#!/usr/bin/env node
// 앱이 명령에 답하기까지를 잰다. 재시작은 부르는 쪽(Makefile)이 소유한다 — 이 자리는 계측만 한다.
//
// 사용: BOOT_STARTED_AT_UNIX_MS=<앱을 띄운 시각> node scripts/e2e/boot-latency.mjs
//
// 첫 응답까지 되묻는다. 창이 자기 서빙 준비를 알리는 자리가 없어서인데, 바로 그 공백이 이
// 판정이 재는 대상이다 — 그 자리가 생기면 이 되묻기도 없앤다.
import { openClient, requireSocket } from "./lib/client.mjs";
import { bootLatencyVerdict } from "./lib/boot-latency.mjs";
import { awaitSocket } from "./lib/await-socket.mjs";

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

const ledger = await rpc("activity.recent", { limit: 40 }).catch(() => null);
const steps = (ledger?.ok === true ? (ledger.data?.entries ?? []) : [])
  .filter((row) => row?.kind === "boot.step")
  .map((row) => ({ step: row.payload?.step ?? "?", atUnixMs: Number(row.ts) }))
  .sort((left, right) => left.atUnixMs - right.atUnixMs);

const verdict = bootLatencyVerdict({ startedAtUnixMs, respondedAtUnixMs, steps });
// 못 답한 이유를 삼키지 않는다 — 없는 값(null)만 남기면 "왜" 가 사라진다.
const refusal = answer?.ok === true ? null : `첫 물음이 실패했다: ${answer?.code ?? "?"} ${answer?.message ?? ""}`.trim();
const detail = [...verdict.evidence, verdict.reason, refusal].filter(Boolean).join(" · ");
console.log(`◉ boot latency ${verdict.status}${detail ? ` — ${detail}` : ""}`);
for (const row of steps) console.log(`   ${row.step} @+${row.atUnixMs - startedAtUnixMs}ms`);
await client.close?.().catch?.(() => {});
process.exitCode = verdict.status === "green" ? 0 : 1;
