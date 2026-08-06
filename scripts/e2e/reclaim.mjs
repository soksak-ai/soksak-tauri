#!/usr/bin/env node
// E2E 픽스처 창 회수 — 앞 판들이 두고 간 창을 걷는다. 멱등: 몇 번 돌려도 같은 자리에 선다.
//
// 왜 있나: 하니스가 실패로 끝나면 자기 창을 두고 나간다. 그 창은 같은 rect 에 겹쳐 뜨므로
// 화면으로는 한 장으로 보이고, 다음 판은 그 위에 또 한 장을 얹는다. 21 장이 쌓여 있었다(실측
// 2026-07-28). 이제 확보 자체가 멱등이라(lib/fixtureWindow.acquireFixtureWindow) 새로 쌓이지
// 않지만, **이미 쌓인 것**과 손으로 만든 밭은 이 도구가 걷는다.
//
// 남의 창 불가침: 선언된 픽스처 밭(~/.soksak-e2e/*) 아래의 창만 닫는다.
//
// 실행: SOKSAK_SOCKET=<앱 소켓> node scripts/e2e/reclaim.mjs

import os from "node:os";
import path from "node:path";
import { openClient, resolveControlWindow } from "./lib/client.mjs";
import {
  emptyWorkspaceWindows,
  forgetFixtureData,
  projectMap,
  reclaimStoredWindowSnapshots,
  releaseFixtureWindowsUnder,
} from "./lib/fixtureWindow.mjs";

const FIELD = path.join(os.homedir(), ".soksak-e2e");
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

  // 창을 닫아도 저장소에 쓴 것은 남는다. 앞 판들이 두고 간 그 데이터를 여기서 걷는다.
  await sweepStoredResidue(rpc, ctrl, labels);
  c.close();
}

/**
 * 앞 판들이 저장소에 두고 간 것을 걷는다.
 *
 *  ① 유령 스냅샷: `window/<label>` 인데 그 창이 **지금도 없고 앞으로도 안 살아난다.** 살아날
 *     창은 장부(`windows`)가 안다 — 지금 안 열려 있다고 지우면 다음 부팅에 되살아날 창을
 *     지운다. 그리고 스냅샷이 픽스처만 들었을 때만 지운다: 사용자 창의 스냅샷은 지우면 그
 *     창의 내용이 통째로 사라진다(실측 2026-08-01 — 그렇게 지웠고 백업에서 되살렸다).
 *  ② 픽스처가 차지한 최근 목록: 목록은 20칸이라, 픽스처가 채우면 사용자의 실제 프로젝트가
 *     목록 밖으로 밀려난다(실측: 20칸 중 19칸이 픽스처였다).
 *
 * 지금 열려 있는 프로젝트는 픽스처 밭에 있어도 남긴다 — 쓰고 있는 것을 목록에서 빼지 않는다.
 */
async function sweepStoredResidue(rpc, ctrl, liveLabels) {
  const snapshots = await reclaimStoredWindowSnapshots(rpc, ctrl, {
    field: FIELD,
    liveLabels,
  });
  for (const kept of snapshots.preserved) {
    if (kept.reason === "not-proven-fixture-only") {
      console.log(`  남김 window/${kept.label} — 모든 세대가 픽스처뿐임을 증명하지 못했다`);
    }
  }
  console.log(
    `유령 스냅샷 ${snapshots.labels} 개 회수 — exact key ${snapshots.deleted} deleted, ${snapshots.absent} absent`,
  );

  const openRoots = new Set((await projectMap(rpc, ctrl)).map((p) => String(p.root)));
  const recents = (await rpc("project.recent", {}, ctrl))?.data ?? [];
  const list = Array.isArray(recents) ? recents : (recents.recents ?? []);
  const stale = list
    .map((r) => String(r?.root ?? r))
    .filter((root) => root.startsWith(field) && !openRoots.has(root));
  for (const root of stale) await forgetFixtureData(rpc, ctrl, { root });
  console.log(`최근 목록에서 픽스처 ${stale.length} 개 회수 — 열려 있는 것은 남겼다`);
}

main().catch((e) => {
  console.error(`회수 실패: ${e.message}`);
  process.exit(1);
});
