#!/usr/bin/env node
// 탭 최대화 E2E — 최대화한 탭의 **내용이 실제로 그려지는가**.
//
// RED 근거(사용자 실측 2026-07-29): "창 최대화(탭 더블클릭)시 빈화면이다." 재현했다 — 브라우저
// 크롬(제목·주소창·버튼)은 그려지는데 페이지 자리가 통째로 비었다. 그 순간 플러그인이 보는
// 현재 뷰와 화면에 선 뷰가 **달랐다**(플러그인은 tab-md7buv, 화면은 tab-otj7zd).
//
// 최대화는 셀 재마운트 축이라 콘텐츠 뷰가 자리를 다시 받아야 한다. 그 재배치가 어긋난 뷰로
// 가면 화면에 선 뷰는 아무도 안 돌봐서 빈 채로 남는다 — 오류는 나지 않는다.
//
// 판정은 둘이다.
//  ① 픽셀 — 페이지 자리가 밝은가(example.com 은 밝은 회색, 빈 화면은 지면색). 크롬만 보고
//     "떴다"고 하면 바로 이 결함을 놓친다.
//  ② 결속 — 플러그인이 보는 현재 뷰가 화면에 선 뷰와 같은가. 픽셀이 우연히 맞아도 이것이
//     어긋나 있으면 다음 조작에서 터진다.
//
// 간헐이므로 라운드를 돈다. 한 번 통과는 통과가 아니다.
//
// 멱등: 픽스처 루트 ~/.soksak-e2e/tab-maximize 전용 창. 끝나면 회수.
// 실행: SOKSAK_SOCKET=<앱 소켓> node scripts/e2e/tab-maximize.mjs [라운드수]

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { openClient, sleep } from "./lib/client.mjs";
import { acquireFixtureWindow, releaseFixtureWindow } from "./lib/fixtureWindow.mjs";
import { decodePng } from "./lib/png.mjs";

const FIXTURE = path.join(os.homedir(), ".soksak-e2e", "tab-maximize");
const ROUNDS = Math.max(1, Number(process.argv[2] ?? 3));
const PAGE = "https://example.com";
const PLUGIN = "plugin.soksak-plugin-browser-native.";

let pass = 0;
let fail = 0;
const ok = (cond, label, detail = "") => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

async function main() {
  const c = await openClient();
  const rpc = (name, params, window) => c.rpc(name, params, window);
  fs.mkdirSync(FIXTURE, { recursive: true });
  console.log(`tab-maximize E2E — ${ROUNDS} 라운드\n`);

  const { label: win } = await acquireFixtureWindow(rpc, FIXTURE);
  const data = (r) => r?.data ?? {};

  try {
    // 프로그램이 설 때까지 — 빈 창엔 아무것도 없다(설계).
    let browser = null;
    let term = null;
    for (let i = 0; i < 40 && !(browser && term); i += 1) {
      const ids = (data(await rpc("program.list", {}, win)).programs ?? []).map((p) => p.id);
      browser = ids.find((id) => id === "browser" || id.startsWith("browser-")) ?? browser;
      term = ids.find((id) => id.startsWith("terminal-")) ?? term;
      if (!(browser && term)) await sleep(500);
    }
    ok(!!browser, `browser 프로그램 (${browser})`);
    if (!browser) throw new Error("브라우저 프로그램이 서지 않았다 — 판정할 수 없다");

    // 사용자 실측의 모양: **반반 분할** — 왼쪽 터미널, 오른쪽 브라우저. 레일이 그 사이(50)에
    // 서고, 최대화는 패널을 0..100 으로 만든다. 한 펜 안의 탭들로는 이 조합이 안 만들어진다.
    if (term) await rpc("tab.open", { program: term }, win);
    await sleep(2500);
    const split = data(await rpc("pane.split", { side: "right", program: browser }, win));
    ok(typeof split.tabId === "string", `반반 분할 — 오른쪽에 브라우저 (${split.tabId})`);
    await sleep(4000);
    await rpc(`${PLUGIN}navigate`, { url: PAGE }, win);
    await sleep(3500);
    const tabs = typeof split.tabId === "string" ? [split.tabId] : [];

    /** 페이지 자리의 밝기 — 크롬 아래 본문만 본다. 빈 화면은 지면색이라 어둡다. */
    const pageBrightness = async () => {
      const s = await rpc("window.snapshot", { base64: true }, win);
      const png = decodePng(Buffer.from(s.media.base64, "base64"));
      let sum = 0;
      let n = 0;
      // 툴바 아래·좌우 여백 안쪽만 — 창 가장자리와 크롬을 표본에서 뺀다.
      for (let y = Math.round(png.h * 0.45); y < Math.round(png.h * 0.9); y += 20) {
        for (let x = Math.round(png.w * 0.6); x < Math.round(png.w * 0.95); x += 20) {
          sum += png.px[(y * png.w + x) * png.ch];
          n += 1;
        }
      }
      return n > 0 ? Math.round(sum / n) : -1;
    };

    for (let round = 1; round <= ROUNDS; round += 1) {
      console.log(`\n라운드 ${round}`);
      for (const tab of tabs) {
        await rpc("tab.restore", {}, win);
        await sleep(1200);
        await rpc("tab.activate", { tab }, win);
        await sleep(2500);
        const before = await pageBrightness();
        // 전제 — 최대화 전에 이미 비어 있으면 이 라운드는 최대화를 판정할 자격이 없다.
        if (before < 120) {
          ok(false, `${tab}: 최대화 전 페이지가 이미 비었다`, `밝기 ${before}`);
          continue;
        }
        await rpc("tab.maximize", { tab }, win);
        await sleep(2500);
        const after = await pageBrightness();
        ok(after >= 120, `${tab}: 최대화 뒤에도 페이지가 그려진다`, `전 ${before} → 후 ${after}`);

        // 결속 — 플러그인이 보는 뷰가 화면에 선 뷰와 같아야 한다. 픽셀이 우연히 맞아도
        // 이것이 어긋나면 다음 조작에서 터진다(이 결함이 실제로 그 모양이었다).
        const seen = data(await rpc(`${PLUGIN}eval`, { js: "return 1" }, win)).viewId ?? null;
        ok(seen === tab, `${tab}: 플러그인이 보는 뷰가 화면의 뷰와 같다`, `플러그인=${seen}`);
        // 트리 생존 — 렌더가 던지면 노출 노드가 통째로 사라진다. 픽셀만 보면 "어둡다"로만
        // 보이고 앱이 죽은 것을 못 가른다(실측: 최대화 뒤 ui.tree 가 64 → 0 이었다).
        const nodes = (data(await rpc("ui.tree", {}, win)).nodes ?? []).length;
        ok(nodes > 0, `${tab}: 최대화 뒤에도 UI 트리가 산다`, `노드 ${nodes}`);
      }
    }
  } finally {
    await rpc("tab.restore", {}, win).catch(() => {});
    await releaseFixtureWindow(rpc, FIXTURE).catch(() => {});
    c.close();
  }

  console.log(`\nresult: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`E2E error: ${e?.message ?? e}`);
  process.exit(1);
});
