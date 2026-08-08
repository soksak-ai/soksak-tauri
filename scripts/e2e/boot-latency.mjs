#!/usr/bin/env node
// 앱이 명령에 답하기까지를 잰다. 재시작은 부르는 쪽(Makefile)이 소유한다 — 이 자리는 계측만 한다.
//
// 사용: BOOT_STARTED_AT_UNIX_MS=<앱을 띄운 시각> node scripts/e2e/boot-latency.mjs
//
// 첫 응답까지 되묻는다. 창이 자기 서빙 준비를 알리는 자리가 없어서인데, 바로 그 공백이 이
// 판정이 재는 대상이다 — 그 자리가 생기면 이 되묻기도 없앤다.
import { openClient, requireSocket } from "./lib/client.mjs";
import { bootLatencyVerdict } from "./lib/boot-latency.mjs";
import { bundleTransportVerdict } from "./lib/bundle-transport.mjs";
import { awaitSocket } from "./lib/await-socket.mjs";
import { awaitBootStep } from "./lib/await-ledger.mjs";

const startedAtUnixMs = Number(process.env.BOOT_STARTED_AT_UNIX_MS);
if (!Number.isFinite(startedAtUnixMs)) {
  console.error("BOOT_STARTED_AT_UNIX_MS 가 없다 — 앱을 띄운 시각은 부르는 쪽이 안다.");
  process.exit(2);
}

const socket = requireSocket();
const deadline = Date.now() + 60_000;

// 소켓 자리는 앱이 만든다 — 없을 때 연결하면 ENOENT 다. 생기는 것은 파일시스템 사건이므로
// 감시로 기다린다(되묻지 않는다). 이 기다림도 부팅 시간의 일부라 계측 안에 든다.
await awaitSocket(socket, deadline - Date.now());
const client = await openClient(socket);
const rpc = (method, params = {}) => client.rpc(method, params);

// **한 번만 묻는다.** 되물으면 잃어버린 배달이 다음 물음에 가려져 부팅이 빨라 보인다 — 실측
// 2026-08-08: 첫 물음이 상한 10 초로 죽고 두 번째가 즉시 답했다. 그 10 초가 사용자가 겪는
// 시간이다. 창이 리스너를 달기 전에 온 배달은 이제 그 창이 회수한다(cmd_listener_ready).
const answer = await rpc("window.list", {}).catch((err) => ({ ok: false, message: String(err) }));
const respondedAtUnixMs = answer?.ok === true ? Date.now() : null;

// 번들 도장은 **워크스페이스 창의 플러그인 부팅**이 찍는다. 컨트롤 플레인(main)에는 플러그인이
// 없고, 워크스페이스 부팅 위상(app.boot.wait)은 플러그인 본문보다 **먼저** 준비가 된다 — 그
// 둘 중 어느 것을 기다려도 도장 없이 원장을 읽는다(실측 2026-08-08: 두 번 다 blocked).
// 기다릴 사실은 플러그인 부팅 자체이고, 그 자리가 이제 이름을 가졌다. 첫 응답 시각은 이미
// 찍은 **뒤**라 이 기다림이 계측을 늘리지 않는다.
// 냉시동 500ms 시점에는 워크스페이스 창이 **아직 없다**(실측 2026-08-08: 그때 목록에는 main
// 하나뿐이라 기다릴 대상을 못 찾고 원장을 그냥 읽었다). 창이 서기를 되물어 확인하면 그 주기가
// 곧 오차이고, 이 하니스가 재는 대상이 바로 그 크기의 시간이다.
//
// 그래서 원장의 push 통로로 그 도장이 적히기를 기다린다 — 흘러온 것을 받는다.
const stamped = await awaitBootStep(socket, "plugins:prefetched:", 60_000);
const ledger = await rpc("activity.recent", { limit: 400 }).catch(() => null);
const steps = (ledger?.ok === true ? (ledger.data?.entries ?? []) : [])
  .filter((row) => row?.kind === "boot.step")
  // 도장이 자기 시각을 싣고 있으면 그것을 쓴다 — 원장에 실린 시각은 **적힌 때**라, 모아
  // 두었다 흘려보낸 단계는 전부 한 점으로 뭉친다.
  .map((row) => ({ step: row.payload?.step ?? "?", atUnixMs: Number(row.payload?.atUnixMs ?? row.ts) }))
  .sort((left, right) => left.atUnixMs - right.atUnixMs);

const verdict = bootLatencyVerdict({ startedAtUnixMs, respondedAtUnixMs, steps });
// 번들이 **어떻게 왔는가**는 따로 판정한다 — 총 시간만 보면 통로가 막힌 부팅과 그냥 느린
// 부팅을 못 가른다. 통로가 막혀도 앱은 죽지 않고 느려진 채로 정상처럼 돈다.
const bundles = bundleTransportVerdict({ steps });
// 못 답한 이유를 삼키지 않는다 — 없는 값(null)만 남기면 "왜" 가 사라진다.
const refusal = answer?.ok === true ? null : `첫 물음이 실패했다: ${answer?.code ?? "?"} ${answer?.message ?? ""}`.trim();
const detail = [...verdict.evidence, verdict.reason, refusal].filter(Boolean).join(" · ");
console.log(`◉ boot latency ${verdict.status}${detail ? ` — ${detail}` : ""}`);
// 무엇을 기다렸는지 함께 낸다 — 판정이 막혔을 때 "안 기다렸다" 와 "기다렸는데 없다" 는 고칠
// 자리가 다르다.
const waited = `stamped=${stamped === null ? "못 봤다(상한)" : "봤다"}`;
const bundleDetail = [...bundles.evidence, bundles.reason, waited].filter(Boolean).join(" · ");
console.log(`◉ bundle transport ${bundles.status}${bundleDetail ? ` — ${bundleDetail}` : ""}`);
for (const row of steps) console.log(`   ${row.step} @+${row.atUnixMs - startedAtUnixMs}ms`);
await client.close?.().catch?.(() => {});
process.exitCode = verdict.status === "green" && bundles.status === "green" ? 0 : 1;
