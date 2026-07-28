#!/usr/bin/env node
// 창 흔적 폐기 E2E — 창을 닫으면 그 창의 **영속 흔적**이 함께 사라지는가.
//
// 흔적은 둘이다: ① 워크스페이스 스냅샷(core kv "window/<label>") ② 복원 manifest(core kv
// "windows")의 그 창 slot. 남기면 다음 부트의 리스폰이 그 slot 을 그대로 되살린다 —
// 사용자가 닫은 창이 재시작마다 돌아오고, 닫을수록 늘어난다.
//
// RED 근거(실측 2026-07-28, Electron): 창을 전부 닫은 뒤 main 을 한 번 재적재하자 여태 열었던
// 창 15 개가 되살아났다. 방금 닫은 창까지 포함해서다. Tauri 경로는 Destroyed 에서 흔적을
// 폐기하지만(window.rs prune_window_persistence), Electron 경로에는 그 자리가 없었다 —
// 규칙이 프레임워크 쪽에 한 벌씩 있으면 한쪽만 지킨다. 규칙은 코어가 갖고 둘이 부른다.
//
// 이 하니스는 프레임워크를 묻지 않는다: 소켓 명령만 쓰고, 두 프레임워크에 같은 답을 요구한다.
//
// 멱등: 픽스처 루트 ~/.soksak-e2e/window-traces 전용 창. 끝나면 회수.
// 실행: SOKSAK_SOCKET=<앱 소켓> node scripts/e2e/window-traces.mjs

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { openClient, resolveControlWindow, sleep } from "./lib/client.mjs";
import { acquireFixtureWindow, releaseFixtureWindow } from "./lib/fixtureWindow.mjs";

const FIXTURE = path.join(os.homedir(), ".soksak-e2e", "window-traces");

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
  const ctrl = await resolveControlWindow(rpc);
  console.log("window-traces E2E\n");
  fs.mkdirSync(FIXTURE, { recursive: true });

  const kv = async (key) => {
    const r = await rpc("data.kv.get", { ns: "core", key }, ctrl);
    return r.ok ? (r.data?.value ?? null) : null;
  };
  const slotOf = async (label) =>
    ((await kv("windows"))?.slots ?? []).find((s) => s.label === label) ?? null;

  const { label } = await acquireFixtureWindow(rpc, FIXTURE);
  console.log(`픽스처 창: ${label}`);

  // 흔적이 실제로 남을 때까지 기다린다 — 흔적이 없으면 이 검사는 아무것도 판정하지 못한다
  // (지우기 전에 있었다는 것이 이 하니스의 전제다).
  let snap = null;
  let slot = null;
  for (let i = 0; i < 40 && !(snap && slot); i += 1) {
    snap = await kv(`window/${label}`);
    slot = await slotOf(label);
    if (!(snap && slot)) await sleep(500);
  }
  ok(!!snap, "닫기 전: 워크스페이스 스냅샷이 있다");
  ok(!!slot, "닫기 전: 복원 manifest 에 slot 이 있다");
  if (!(snap && slot)) {
    console.log("\n전제가 서지 않았다 — 판정할 수 없다(창이 상태를 저장하지 못했다).");
    c.close();
    process.exit(1);
  }

  await releaseFixtureWindow(rpc, FIXTURE, { ctrl });
  // 파괴는 비동기다 — 흔적 폐기가 파괴 뒤에 오므로 사라짐을 기다린다.
  let afterSnap = snap;
  let afterSlot = slot;
  for (let i = 0; i < 20 && (afterSnap || afterSlot); i += 1) {
    await sleep(500);
    afterSnap = await kv(`window/${label}`);
    afterSlot = await slotOf(label);
  }

  ok(!afterSnap, "닫은 뒤: 워크스페이스 스냅샷이 없다", "닫힌 창의 스냅샷이 남았다");
  ok(
    !afterSlot,
    "닫은 뒤: manifest slot 이 없다",
    "닫힌 창의 slot 이 남았다 — 다음 부트가 이 창을 되살린다",
  );

  console.log(`\nresult: ${pass} pass / ${fail} fail`);
  c.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(`E2E error: ${e.message}`);
  process.exit(1);
});
