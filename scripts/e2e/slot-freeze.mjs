// 네이티브 웹뷰 안정 경계 E2E.
//
// 사용자 동작과 같은 탭 content surface 교차 클릭으로 sidebar flow가 좌우 판 사이를 이동하는 동안,
// Tauri child webview가 DOM 슬롯과 1:1로 남고 모든 전이 프레임이 보존되는지 검증한다.
// Electron에서는 같은 제품 시나리오와 캡처를 수행하되 native composition 판정은 비적용이다.
//
// 실행: SOKSAK_SOCKET=<cored.sock> node scripts/e2e/slot-freeze.mjs
// 멱등: ~/.soksak-e2e/slot-freeze 전용 창과 evidence/slot-freeze/current만 소유한다.
// 포커스 금지: window.focus/OS pointer를 쓰지 않고 ui.input.click+내장 recorder만 사용한다.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { openClient, requireSocket, must } from "./lib/client.mjs";
import { acquireFixtureWindow, releaseFixtureWindow } from "./lib/fixtureWindow.mjs";

const SOCKET = requireSocket();
const FIXTURE_ROOT = path.join(os.homedir(), ".soksak-e2e", "slot-freeze");
const EVIDENCE_ROOT = path.join(
  os.homedir(),
  ".soksak-e2e",
  "evidence",
  "slot-freeze",
  "current",
);
const BROWSER_PROGRAM = process.env.BROWSER_ENGINE || "browser";
const BROWSER_PLUGIN = {
  browser: "soksak-plugin-browser-native",
  "browser-chromium": "soksak-plugin-browser-chromium",
  "browser-chromium-offscreen": "soksak-plugin-browser-chromium-offscreen",
}[BROWSER_PROGRAM];
const CYCLES = 3;
const FRAMES_PER_CLICK = 48;

if (!BROWSER_PLUGIN) throw new Error(`지원하지 않는 BROWSER_ENGINE: ${BROWSER_PROGRAM}`);

function prepareEvidence() {
  const boundary = path.join(os.homedir(), ".soksak-e2e", "evidence") + path.sep;
  const resolved = path.resolve(EVIDENCE_ROOT);
  if (!(`${resolved}${path.sep}`).startsWith(boundary)) {
    throw new Error(`증거 경로 경계 위반: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  fs.mkdirSync(resolved, { recursive: true });
}

function startPageServer() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><meta charset="utf-8"><title>Boundary Fixture</title>
      <style>html,body{margin:0;min-height:100%;background:#10202c;color:#f7f4df;font:24px system-ui}
      main{min-height:100vh;display:grid;place-items:center;background:linear-gradient(135deg,#10202c 0 50%,#e0704f 50%)}
      section{padding:48px;border:8px solid #f7f4df;background:#16394a;box-shadow:20px 20px 0 #10202c}
      h1{font-size:52px;margin:0 0 12px}p{margin:0}</style>
      <main><section><h1>Native Boundary</h1><p>DOM slot ↔ live webview</p></section></main>`);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("fixture server address"));
      resolve({ server, url: `http://127.0.0.1:${address.port}/` });
    });
  });
}

const addressForTab = (tree, tabId) => {
  const tabToken = `/tab/${tabId}/`;
  const node = (tree.nodes ?? []).find(
    (n) => n.nodePath === "surface" && n.address.includes(tabToken),
  );
  if (!node?.address) throw new Error(`탭 content surface 주소가 노출되지 않았다: ${tabId}`);
  return node.address;
};

function assertNativeLighting(data, activeLabel, labels) {
  const surfaces = new Map(
    (data.engine?.surfaces ?? []).map((surface) => [surface.label, surface]),
  );
  const errors = [];
  for (const label of labels) {
    const surface = surfaces.get(label);
    const expected = label === activeLabel ? 0 : 0.5;
    if (!surface) {
      errors.push(`${label}:missing`);
      continue;
    }
    if (surface.dim !== expected) errors.push(`${label}:requested=${surface.dim}/${expected}`);
    const lighting = surface.lighting ?? {};
    if (lighting.appliedAlpha !== expected) {
      errors.push(`${label}:applied=${lighting.appliedAlpha}/${expected}`);
    }
    if (!lighting.frameMatchesSurface) errors.push(`${label}:frame`);
    if (!lighting.siblingOrder?.veilAboveSurface) errors.push(`${label}:stack`);
    if (expected > 0 && lighting.veilHidden) errors.push(`${label}:hidden`);
  }
  if (errors.length) throw new Error(`native lighting 불일치 — ${errors.join(", ")}`);
}

function assertComposition(data, labels, beforeWrites) {
  const verdict = data.verdict ?? {};
  const errors = ["missing", "misplaced", "stacked"].flatMap((key) =>
    (verdict[key] ?? []).map((item) => `${key}:${JSON.stringify(item)}`),
  );
  const placement = new Map((data.placement ?? []).map((p) => [p.label, p]));
  for (const label of labels) {
    const p = placement.get(label);
    if (!p?.opened || !p.slotPresent) errors.push(`placement:${label}:not-open-or-no-slot`);
    if (p?.syncPending || p?.precommitPending) errors.push(`placement:${label}:pending`);
    if (p?.desiredVisible !== p?.appliedVisible) errors.push(`placement:${label}:visibility`);
    if (beforeWrites.has(label)) {
      const delta = Number(p?.boundsWrites ?? 0) - Number(beforeWrites.get(label));
      if (delta < 0 || delta > 1) errors.push(`placement:${label}:boundsWrites+${delta}`);
    }
  }
  if (errors.length) throw new Error(`native composition 불일치 — ${errors.join(", ")}`);
  return new Map((data.placement ?? []).map((p) => [p.label, Number(p.boundsWrites ?? 0)]));
}

async function main() {
  prepareEvidence();
  const client = await openClient(SOCKET);
  const rpc = (method, params = {}, window) => client.rpc(method, params, window);
  let win;
  let homeOverride = false;
  const page = await startPageServer();

  try {
    const acquired = await acquireFixtureWindow(rpc, FIXTURE_ROOT);
    win = acquired.label;
    console.log(`픽스처 창: ${win}${acquired.adopted ? " (재사용)" : " (생성)"}`);

    // 레지스트리의 Zustand 사건을 구독하는 공개 준비 경계. 하니스 폴링은 없다.
    must(
      await rpc("program.wait", { id: BROWSER_PROGRAM, timeoutMs: 20_000 }, win),
      `program.wait ${BROWSER_PROGRAM}`,
    );
    must(
      await rpc(
        "plugin.settings.set",
        { id: BROWSER_PLUGIN, key: "homeUrl", value: page.url, scope: "project" },
        win,
      ),
      "fixture homeUrl",
    );
    homeOverride = true;

    const panes = must(await rpc("pane.list", {}, win), "pane.list").panes ?? [];
    if (panes.length === 0) must(await rpc("space.create", {}, win), "space.create");

    const left = must(await rpc("tab.open", { program: BROWSER_PROGRAM }, win), "left tab.open");
    const right = must(
      await rpc("pane.split", { side: "right", program: BROWSER_PROGRAM }, win),
      "right pane.split",
    );
    const tabIds = [left.tabId, right.tabId];
    if (tabIds.some((id) => typeof id !== "string")) {
      throw new Error(`브라우저 탭 id 누락: ${JSON.stringify(tabIds)}`);
    }
    must(await rpc("sidebar.left.position", { mode: "flow" }, win), "sidebar flow");

    // 생성 시점부터 로컬 fixture URL을 사용하고 guest DOM 준비 사건을 기다린다.
    // 고정 sleep·재시도 폴링·navigate 직후 document 교체 레이스가 없다.
    for (const tabId of tabIds) {
      must(await rpc("tab.activate", { tab: tabId }, win), `tab.activate ${tabId}`);
      must(
        await rpc(
          `plugin.${BROWSER_PLUGIN}.dom.wait-for`,
          { selector: "h1", timeoutMs: 8_000, viewId: tabId },
          win,
        ),
        `browser ready ${tabId}`,
      );
      const identity = must(
        await rpc(
          `plugin.${BROWSER_PLUGIN}.dom.text`,
          { selector: "h1", viewId: tabId },
          win,
        ),
        `browser identity ${tabId}`,
      );
      if (identity.text !== "Native Boundary") {
        throw new Error(`${tabId}: 페이지 신원 불일치(${JSON.stringify(identity.text)})`);
      }
    }

    const tree = must(await rpc("ui.tree", {}, win), "ui.tree");
    const addresses = tabIds.map((id) => addressForTab(tree, id));
    const provision = must(await rpc("framework.provision", {}, win), "framework.provision");
    const native = provision.nativeChildWebview === true;
    const labels = tabIds.map((id) => `b-${win}-${id}`);
    let writes = new Map();
    let writeDeltaBaselineReady = false;
    if (native) {
      const initial = must(await rpc("webview.composition", {}, win), "initial composition");
      writes = new Map(
        (initial.placement ?? []).map((p) => [p.label, Number(p.boundsWrites ?? 0)]),
      );
    }

    let frameCount = 0;
    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      for (let side = 0; side < addresses.length; side += 1) {
        const name = `${String(cycle * 2 + side + 1).padStart(2, "0")}-${side ? "right" : "left"}`;
        const dir = path.join(EVIDENCE_ROOT, name);
        const clicked = must(
          await rpc(
            "ui.input.click",
            {
              address: addresses[side],
              recordDir: dir,
              recordFrames: FRAMES_PER_CLICK,
              recordIntervalMs: 16,
              recordLeadMs: 700,
            },
            win,
          ),
          `교차 클릭 ${name}`,
        );
        const captured = Number(clicked.recording?.frames ?? 0);
        if (captured !== FRAMES_PER_CLICK) {
          throw new Error(`${name}: 캡처 ${captured}/${FRAMES_PER_CLICK}`);
        }
        const files = fs.readdirSync(dir).filter((f) => /^f\d{4}\.png$/.test(f));
        if (files.length !== FRAMES_PER_CLICK) {
          throw new Error(`${name}: PNG ${files.length}/${FRAMES_PER_CLICK}`);
        }
        if (files.some((f) => fs.statSync(path.join(dir, f)).size === 0)) {
          throw new Error(`${name}: 0바이트 PNG`);
        }
        frameCount += files.length;

        if (native) {
          const current = must(await rpc("webview.composition", {}, win), `composition ${name}`);
          writes = assertComposition(
            current,
            labels,
            writeDeltaBaselineReady ? writes : new Map(),
          );
          writeDeltaBaselineReady = true;
          const surfaces = must(await rpc("webview.surfaces", {}, win), `surfaces ${name}`);
          assertNativeLighting(surfaces, labels[side], labels);
        }
        console.log(`✓ ${name}: ${FRAMES_PER_CLICK} frames · composition exact`);
      }
    }

    const finalPath = path.join(EVIDENCE_ROOT, "final.png");
    must(await rpc("window.snapshot", { path: finalPath }, win), "final snapshot");
    if (!fs.existsSync(finalPath) || fs.statSync(finalPath).size === 0) {
      throw new Error("최종 스냅샷이 저장되지 않았다");
    }
    console.log(
      `✓ slot-freeze GREEN — 실제 교차 클릭 ${CYCLES * 2}회, 연속 프레임 ${frameCount}장, ` +
        `${native ? "Tauri DOM/native 1:1" : "DOM content view"}`,
    );
    console.log(`증거: ${EVIDENCE_ROOT}`);
  } finally {
    if (win && homeOverride) {
      await rpc(
        "plugin.settings.reset",
        { id: BROWSER_PLUGIN, key: "homeUrl", scope: "project" },
        win,
      ).catch(() => {});
    }
    if (win && process.env.KEEP !== "1") {
      await releaseFixtureWindow(rpc, FIXTURE_ROOT).catch(() => {});
    } else if (win) {
      console.log(`KEEP=1 — 픽스처 창 보존: ${win}`);
    }
    client.close();
    await new Promise((resolve) => page.server.close(resolve));
  }
}

main().catch((error) => {
  console.error(`✗ slot-freeze RED — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
