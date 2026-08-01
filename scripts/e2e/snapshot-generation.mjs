#!/usr/bin/env node
// 직전 세대 보존 E2E — **잃는 쓰기는 되돌릴 자리를 남긴다.**
//
// RED 근거(실측 2026-08-01): 워크스페이스 스냅샷은 `DO UPDATE` 로 저장된다 — 쓰는 순간 이전
// 값이 그 자리에서 사라진다. 복원이 예외로 죽어 창이 빈 상태가 되자 그 빈 상태가 곧바로
// 저장되어 스냅샷을 덮었고(10KB → 32B), 사용자 워크스페이스 셋이 사라졌다. 백업 링은 최소
// 간격이 1시간이라 그 사이의 작업은 어디에도 없었다.
//
// 원인 하나는 막았지만(persistGuard — 복원 실패 시 저장 금지) 원인을 다 막을 수는 없다:
// 크래시·강제종료·앞으로 생길 버그. 그러니 **잃어도 되돌릴 수 있어야** 한다.
//
// 이 하니스가 판정하는 것:
//   ① 잃는 쓰기(스페이스가 사라지는 저장) 뒤에 직전 세대가 남는가
//   ② 그 세대가 무엇을 담았는지 사람이 물어볼 수 있는가(window.restorePrevious)
//   ③ 되돌리면 실제로 돌아오는가, 그리고 되돌린 것도 되돌릴 수 있는가(왕복)
//
// 멱등: 자기 픽스처 창을 열고 끝나면 닫는다. 사용자 창은 건드리지 않는다.
// 실행: SOKSAK_SOCKET=<앱 소켓> node scripts/e2e/snapshot-generation.mjs

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { openClient, must, sleep } from "./lib/client.mjs";

const FIXTURE = path.join(os.homedir(), ".soksak-e2e", "snapshot-generation");

/** 저장은 400ms 디바운스다 — 그보다 넉넉히 기다린 뒤에 저장소를 읽는다. */
const PERSIST_SETTLE_MS = 1200;

const ok = (label) => console.log(`  ✓ ${label}`);

async function main() {
  fs.mkdirSync(FIXTURE, { recursive: true });
  const c = await openClient();
  let win = null;
  try {
    // 자기 창을 연다 — 사용자 창의 상태를 이 검사가 흔들지 않는다.
    const opened = must(
      await c.rpc("window.open", { root: FIXTURE }),
      "픽스처 창 열기",
    );
    win = opened.label ?? opened.window ?? opened.existingWindow;
    if (!win) throw new Error(`창 라벨을 못 받았다: ${JSON.stringify(opened)}`);
    await sleep(PERSIST_SETTLE_MS);
    ok(`픽스처 창 ${win}`);

    const project = must(await c.rpc("state.tree", {}, win), "상태 트리").projects?.[0]?.id;
    if (!project) throw new Error("픽스처 창에 프로젝트가 없다");

    // ① 늘리는 쓰기는 세대를 남기지 않는다 — 남기면 직전 값이 그 쓰기로 밀린다.
    must(await c.rpc("space.create", { project }, win), "스페이스 추가");
    await sleep(PERSIST_SETTLE_MS);
    const afterAdd = must(await c.rpc("window.restorePrevious", {}, win), "추가 뒤 조회");
    if (afterAdd.found) throw new Error("늘리는 쓰기가 세대를 남겼다 — 되돌릴 이유가 없는 쓰기다");
    ok("늘리는 쓰기는 세대를 남기지 않는다");

    const spaces = must(await c.rpc("space.list", { project }, win), "스페이스 목록").spaces;
    if (spaces.length < 2) throw new Error(`스페이스가 둘 이상이어야 한다: ${spaces.length}`);
    const doomed = spaces[spaces.length - 1].id;

    // ② 잃는 쓰기 — 스페이스를 닫으면 그 안의 탭이 사라진다.
    must(await c.rpc("space.close", { project, space: doomed }, win), "스페이스 닫기");
    await sleep(PERSIST_SETTLE_MS);
    const kept = must(await c.rpc("window.restorePrevious", {}, win), "잃는 쓰기 뒤 조회");
    if (!kept.found) {
      throw new Error("잃는 쓰기가 직전 세대를 안 남겼다 — 되돌릴 자리가 없다(원래 결함의 모양)");
    }
    ok(`잃는 쓰기가 세대를 남긴다 (프로젝트 ${kept.projects} · 탭 ${kept.tabs})`);

    // ③ 되돌리면 돌아온다.
    const applied = must(
      await c.rpc("window.restorePrevious", { apply: true }, win),
      "되돌리기",
    );
    if (!applied.applied) throw new Error("되돌리기가 적용되지 않았다");
    ok("되돌리면 직전 세대가 적용된다");

    // ④ 되돌린 것도 되돌릴 수 있다 — 왕복이 아니면 그것도 잃는 길이다.
    const roundTrip = must(await c.rpc("window.restorePrevious", {}, win), "왕복 조회");
    if (!roundTrip.found) {
      throw new Error("되돌리기가 직전 값을 안 남겼다 — 왕복 불가는 새 손실 경로다");
    }
    ok("되돌린 것도 되돌릴 수 있다(왕복)");

    console.log("snapshot-generation: PASS");
  } finally {
    // 멱등 — 이 검사가 만든 창은 이 검사가 거둔다.
    if (win) await c.rpc("window.close", { label: win }).catch(() => {});
    c.close();
  }
}

main().catch((e) => {
  console.error(`snapshot-generation: FAIL — ${e.message}`);
  process.exit(1);
});
