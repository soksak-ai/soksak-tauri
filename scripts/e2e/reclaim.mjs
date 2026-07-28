#!/usr/bin/env node
// E2E 픽스처 창 회수 — 앞 판들이 두고 간 창을 걷는다. 멱등: 몇 번 돌려도 같은 자리에 선다.
//
// 왜 있나: 하니스가 실패로 끝나면 자기 창을 두고 나간다. 그 창은 같은 rect 에 겹쳐 뜨므로
// 화면으로는 한 장으로 보이고, 다음 판은 그 위에 또 한 장을 얹는다. 21 장이 쌓여 있었다(실측
// 2026-07-28). 이제 확보 자체가 멱등이라(lib/fixtureWindow.acquireFixtureWindow) 새로 쌓이지
// 않지만, **이미 쌓인 것**과 손으로 만든 밭은 이 도구가 걷는다.
//
// 남의 창 불가침: 픽스처 밭(~/.soksak-e2e/*)과 픽스처 이름 규약(soksak-e2e-*)에 걸리는 창만
// 닫는다. 사용자의 프로젝트 창은 어느 규칙에도 걸리지 않는다.
//
// 실행: SOKSAK_SOCKET=<앱 소켓> node scripts/e2e/reclaim.mjs

import os from "node:os";
import path from "node:path";
import { openClient, resolveControlWindow } from "./lib/client.mjs";
import {
  emptyWorkspaceWindows,
  projectMap,
  releaseFixtureWindowsNamed,
  releaseFixtureWindowsUnder,
} from "./lib/fixtureWindow.mjs";

const FIELD = path.join(os.homedir(), ".soksak-e2e");
const TMP_PREFIX = "soksak-e2e-";
// 빈 창(프로젝트 0)은 기본 대상이 아니다 — 사용자도 프로젝트를 열기 전 빈 창을 띄운다.
const SWEEP_EMPTY = process.argv.includes("--empty");

async function main() {
  const c = await openClient();
  const rpc = (name, params, window) => c.rpc(name, params, window);
  const ctrl = await resolveControlWindow(rpc);

  const before = await projectMap(rpc, ctrl);
  console.log(`창 ${before.length} 개가 프로젝트를 들고 있다`);

  const swept = [
    ...(await releaseFixtureWindowsUnder(rpc, FIELD, { ctrl })),
    ...(await releaseFixtureWindowsNamed(rpc, TMP_PREFIX, { ctrl })),
  ];
  for (const w of swept) console.log(`  회수 ${w.label}  ${w.root}`);

  const after = await projectMap(rpc, ctrl);
  const labels = (await rpc("window.list", {}, ctrl))?.data?.labels ?? [];
  const empty = emptyWorkspaceWindows(labels, after);
  if (SWEEP_EMPTY) {
    for (const l of empty) {
      await rpc("window.close", { label: l }, ctrl).catch(() => {});
      console.log(`  회수(빈 창) ${l}`);
    }
  } else if (empty.length) {
    console.log(`빈 창 ${empty.length} 개는 두었다 — 걷으려면 --empty`);
  }

  console.log(`회수 ${swept.length + (SWEEP_EMPTY ? empty.length : 0)} 개 — 프로젝트 창 ${after.length} 개 남음`);
  for (const p of after) console.log(`  남김 ${p.window}  ${p.root}`);
  c.close();
}

main().catch((e) => {
  console.error(`회수 실패: ${e.message}`);
  process.exit(1);
});
