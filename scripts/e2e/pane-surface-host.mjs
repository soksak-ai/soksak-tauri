// Tauri PaneSurfaceHost 합성 E2E.
//
// renderer와 문서 밖 surface를 같은 native parent에 넣고, 투명 chrome 아래의 content가
// 실제로 보이는지와 48프레임 이동 동안 두 marker가 한 픽셀 궤적을 공유하는지 판정한다.
// fixture 창은 focus:false로 열고 window.snapshot/window.record도 포커스를 요구하지 않는다.
//
// 실행: SOKSAK_SOCKET=<cored.sock> node scripts/e2e/pane-surface-host.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { markerEvidence, snapshotCssScale } from "./lib/browser-matrix.mjs";
import { openClient, requireSocket, must } from "./lib/client.mjs";
import { acquireFixtureWindow, releaseFixtureWindow } from "./lib/fixtureWindow.mjs";
import { closeHtmlFixture, startHtmlFixture } from "./lib/http-fixture.mjs";

const SOCKET = requireSocket();
const FIXTURE_ROOT = path.join(os.homedir(), ".soksak-e2e", "pane-surface-host");
const EVIDENCE_ROOT = path.join(os.homedir(), ".soksak-e2e", "evidence", "pane-surface-host", "current");
const CONTENT_MARKER = "#00ffff";
const RENDERER_MARKER = "#ff00ff";
const START = Object.freeze({ x: 80, y: 140, w: 320, h: 240 });
const END = Object.freeze({ ...START, x: 280 });
const FRAMES = 48;
const REQUESTS = [];

function preparePaths() {
  fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
  const boundary = path.join(os.homedir(), ".soksak-e2e", "evidence") + path.sep;
  const resolved = path.resolve(EVIDENCE_ROOT);
  if (!(`${resolved}${path.sep}`).startsWith(boundary)) {
    throw new Error(`증거 경로 경계 위반: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  fs.mkdirSync(resolved, { recursive: true });
}

function htmlFor(request) {
  const pathname = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
  REQUESTS.push(pathname);
  if (pathname === "/renderer") {
    return `<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}
      #chrome{position:absolute;inset:0 0 auto 0;height:64px;background:#f06424;color:white;font:24px sans-serif}
      #renderer-marker{position:absolute;left:16px;top:16px;width:48px;height:32px;background:${RENDERER_MARKER}}
    </style><div id="chrome"><div id="renderer-marker"></div></div>`;
  }
  return `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;width:100%;height:100%;background:#006472;overflow:hidden}
    #content-marker{position:absolute;left:16px;top:120px;width:48px;height:32px;background:${CONTENT_MARKER}}
  </style><div id="content-marker"></div>`;
}

function strongestMarker(file, color, stage) {
  const evidence = markerEvidence(fs.readFileSync(file), color, 24, 1);
  const component = [...evidence.components]
    .filter((item) => item.count >= 400 && item.width >= 32 && item.height >= 20)
    .sort((a, b) => b.count - a.count)[0];
  if (!component) throw new Error(`${stage}: ${color} marker 소실 — ${JSON.stringify(evidence.largest)}`);
  return component;
}

function inspectFrames(dir, scale) {
  const files = fs.readdirSync(dir).filter((name) => /^f\d{4}\.png$/.test(name)).sort();
  if (files.length !== FRAMES) throw new Error(`녹화 프레임=${files.length}/${FRAMES}`);
  const rows = files.map((name) => {
    const file = path.join(dir, name);
    const renderer = strongestMarker(file, RENDERER_MARKER, name);
    const content = strongestMarker(file, CONTENT_MARKER, name);
    return { frame: name, renderer, content, dx: Math.abs(renderer.x - content.x) };
  });
  const maxPairDx = Math.max(...rows.map((row) => row.dx));
  if (maxPairDx > Math.max(2, scale)) {
    const worst = rows.find((row) => row.dx === maxPairDx);
    throw new Error(`renderer↔content 궤적 분리 dx=${maxPairDx}: ${JSON.stringify(worst)}`);
  }
  const startX = rows[0].renderer.x;
  const endX = rows.at(-1).renderer.x;
  if (endX - startX < 150 * scale) {
    throw new Error(`pane 이동량 부족: ${startX}→${endX}, scale=${scale}`);
  }
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].renderer.x + scale < rows[index - 1].renderer.x) {
      throw new Error(`renderer 역행: ${rows[index - 1].frame}→${rows[index].frame}`);
    }
    if (rows[index].content.x + scale < rows[index - 1].content.x) {
      throw new Error(`content 역행: ${rows[index - 1].frame}→${rows[index].frame}`);
    }
  }
  return { frames: rows.length, maxPairDx, startX, endX, rows };
}

async function evalState(rpc, win, label) {
  const data = must(await rpc("webview.pane.eval", {
    label,
    js: "return JSON.stringify({href:location.href,ready:document.readyState,text:document.body?.innerText||'',html:getComputedStyle(document.documentElement).backgroundColor,body:getComputedStyle(document.body).backgroundColor})",
  }, win), `eval ${label}`);
  return JSON.parse(data.result);
}

async function main() {
  preparePaths();
  const client = await openClient(SOCKET);
  const page = await startHtmlFixture(htmlFor);
  let win = null;
  let contentLabel = null;
  let rendererLabel = null;
  try {
    const fixture = await acquireFixtureWindow(client.rpc, FIXTURE_ROOT);
    win = fixture.label;
    // Native navigation policy treats the label as the webview principal.
    // These are browser documents, so the fixture must obey the same b-* address
    // contract as production browser surfaces instead of inventing a test role.
    contentLabel = `b-pane-content-${win}`;
    rendererLabel = `b-pane-renderer-${win}`;
    const pane = `pane-host-${win}`;
    must(await client.rpc("window.resize", { w: 1400, h: 1000 }, win), "fixture window resize");
    const info = must(await client.rpc("window.info", {}, win), "window.info");
    const contentUrl = new URL("content", page.url).href;
    const rendererUrl = new URL("renderer", page.url).href;

    const contentOpen = must(await client.rpc("webview.pane.surface-open", {
      label: contentLabel, url: contentUrl, ...START, transparent: false,
    }, win, { timeoutMs: 30_000 }), "content open+loaded");
    const rendererOpen = must(await client.rpc("webview.pane.surface-open", {
      label: rendererLabel, url: rendererUrl, ...START, transparent: true,
    }, win, { timeoutMs: 30_000 }), "renderer open+loaded");
    if (contentOpen.page?.url !== contentUrl || rendererOpen.page?.url !== rendererUrl) {
      throw new Error(`page-load URL 불일치: ${JSON.stringify({ contentOpen, rendererOpen })}`);
    }
    const [contentPage, rendererPage] = await Promise.all([
      evalState(client.rpc, win, contentLabel),
      evalState(client.rpc, win, rendererLabel),
    ]);
    if (contentPage.body !== "rgb(0, 100, 114)") throw new Error(`content 배경: ${JSON.stringify(contentPage)}`);
    if (rendererPage.body !== "rgba(0, 0, 0, 0)") throw new Error(`renderer 배경: ${JSON.stringify(rendererPage)}`);

    must(await client.rpc("webview.pane.group", {
      pane, renderer: rendererLabel, members: [contentLabel], ...START,
    }, win), "pane group");
    const hosts = must(await client.rpc("webview.pane.hosts", {}, win), "pane hosts");
    const host = hosts.hosts?.find((item) => item.pane === pane);
    if (!host || host.rendererTransparent !== true || host.rendererTopology?.sameView !== false
        || host.rendererTopology?.lowestCommonAncestorIsWindowContentRoot !== false) {
      throw new Error(`pane topology 불일치: ${JSON.stringify(host)}`);
    }

    const initial = path.join(EVIDENCE_ROOT, "initial.png");
    must(await client.rpc("window.snapshot", { path: initial }, win), "initial snapshot");
    const scale = snapshotCssScale(fs.readFileSync(initial), info);
    const initialRenderer = strongestMarker(initial, RENDERER_MARKER, "initial");
    const initialContent = strongestMarker(initial, CONTENT_MARKER, "initial");
    if (Math.abs(initialRenderer.x - initialContent.x) > Math.max(2, scale)) {
      throw new Error(`initial marker x 불일치: ${initialRenderer.x}/${initialContent.x}`);
    }

    const recordDir = path.join(EVIDENCE_ROOT, "move");
    const moved = must(await client.rpc("webview.pane.move", {
      pane, ...END, startAtUnixMs: 0, durationMs: 320,
      recordDir, recordFrames: FRAMES, recordIntervalMs: 16,
    }, win, { timeoutMs: 60_000 }), "pane move scan");
    if (moved.recording?.frames !== FRAMES) throw new Error(`recording ACK: ${JSON.stringify(moved)}`);
    const motion = inspectFrames(recordDir, scale);
    const finalHosts = must(await client.rpc("webview.pane.hosts", {}, win), "final pane hosts");
    const finalHost = finalHosts.hosts?.find((item) => item.pane === pane);
    if (Math.abs(Number(finalHost?.frame?.x) - END.x) > 0.5) {
      throw new Error(`final host x=${finalHost?.frame?.x}/${END.x}`);
    }
    const verdict = {
      ok: true,
      window: win,
      pane,
      pageLoad: { content: contentOpen.page, renderer: rendererOpen.page },
      topology: host.rendererTopology,
      scale,
      motion: { frames: motion.frames, maxPairDx: motion.maxPairDx, startX: motion.startX, endX: motion.endX },
      finalFrame: finalHost.frame,
    };
    fs.writeFileSync(path.join(EVIDENCE_ROOT, "verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`);
    console.log(JSON.stringify(verdict, null, 2));
  } finally {
    if (win && rendererLabel) await client.rpc("webview.pane.surface-close", { label: rendererLabel }, win).catch(() => {});
    if (win && contentLabel) await client.rpc("webview.pane.surface-close", { label: contentLabel }, win).catch(() => {});
    await releaseFixtureWindow(client.rpc, FIXTURE_ROOT).catch(() => {});
    await closeHtmlFixture(page.server);
    client.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  console.error(`fixture requests: ${JSON.stringify(REQUESTS)}`);
  process.exitCode = 1;
});
