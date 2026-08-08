#!/usr/bin/env node
// 앱이 명령에 답하기까지를 잰다. 재시작은 부르는 쪽(Makefile)이 소유한다 — 이 자리는 계측만 한다.
//
// 사용: BOOT_STARTED_AT_UNIX_MS=<앱을 띄운 시각> node scripts/e2e/boot-latency.mjs
//
// 첫 응답까지 되묻는다. 창이 자기 서빙 준비를 알리는 자리가 없어서인데, 바로 그 공백이 이
// 판정이 재는 대상이다 — 그 자리가 생기면 이 되묻기도 없앤다.
import { openClient, requireSocket } from "./lib/client.mjs";
import { bootLatencyVerdict } from "./lib/boot-latency.mjs";

const startedAtUnixMs = Number(process.env.BOOT_STARTED_AT_UNIX_MS);
if (!Number.isFinite(startedAtUnixMs)) {
  console.error("BOOT_STARTED_AT_UNIX_MS 가 없다 — 앱을 띄운 시각은 부르는 쪽이 안다.");
  process.exit(2);
}

const client = await openClient(requireSocket());
const rpc = (method, params = {}) => client.rpc(method, params);
const deadline = Date.now() + 60_000;

let respondedAtUnixMs = null;
while (Date.now() < deadline) {
  const answer = await rpc("window.list", {}).catch(() => null);
  if (answer?.ok === true) {
    respondedAtUnixMs = Date.now();
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}

const ledger = await rpc("activity.recent", { limit: 40 }).catch(() => null);
const steps = (ledger?.ok === true ? (ledger.data?.entries ?? []) : [])
  .filter((row) => row?.kind === "boot.step")
  .map((row) => ({ step: row.payload?.step ?? "?", atUnixMs: Number(row.ts) }))
  .sort((left, right) => left.atUnixMs - right.atUnixMs);

const verdict = bootLatencyVerdict({ startedAtUnixMs, respondedAtUnixMs, steps });
const detail = [...verdict.evidence, verdict.reason].filter(Boolean).join(" · ");
console.log(`◉ boot latency ${verdict.status}${detail ? ` — ${detail}` : ""}`);
for (const row of steps) console.log(`   ${row.step} @+${row.atUnixMs - startedAtUnixMs}ms`);
await client.close?.().catch?.(() => {});
process.exitCode = verdict.status === "green" ? 0 : 1;
