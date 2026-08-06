/**
 * 녹화·픽셀·프레임워크 시계와 무관한 공개 layout 거래 장부 판정.
 * 한 자극은 하나의 닫힌 거래로 나타나야 하고 이동 identity와 시간이 유한해야 한다.
 */
export function layoutTransactionVerdict(
  entries,
  { afterSequence = 0, expectedMode, candidateViewIds = [] } = {},
) {
  const rows = (Array.isArray(entries) ? entries : [])
    .filter((entry) => Number(entry?.sequence) > Number(afterSequence));
  const errors = [];
  if (rows.length !== 1) errors.push(`transactions=${rows.length}/1`);
  const entry = rows[0];
  if (!entry) return { ok: false, errors, transactions: rows };
  if (entry.phase !== "committed") errors.push(`phase=${entry.phase}/committed`);
  if (expectedMode && entry.mode !== expectedMode) errors.push(`mode=${entry.mode}/${expectedMode}`);
  if (typeof entry.transactionId !== "string" || !entry.transactionId) errors.push("transaction-id-missing");
  const moves = Array.isArray(entry.moves) ? entry.moves : [];
  if (!moves.length) errors.push("moves=0");
  const ids = new Set();
  for (const [index, move] of moves.entries()) {
    if (typeof move?.viewId !== "string" || !move.viewId) errors.push(`move${index}:view-id-missing`);
    if (ids.has(move?.viewId)) errors.push(`move${index}:duplicate:${move?.viewId}`);
    ids.add(move?.viewId);
    if (!Number.isFinite(Number(move?.dx)) || Math.abs(Number(move?.dx)) < 0.5) {
      errors.push(`move${index}:dx=${move?.dx}`);
    }
  }
  if (candidateViewIds.length && !candidateViewIds.some((id) => ids.has(id))) {
    errors.push(`candidate-view-missing:${candidateViewIds.join("/")}`);
  }
  const preparedAt = entry.preparedAtUnixMs;
  const domCommittedAt = entry.domCommittedAtUnixMs;
  const closedAt = entry.closedAtUnixMs;
  if (!Number.isFinite(preparedAt)) errors.push("prepared-time-missing");
  if (!Number.isFinite(domCommittedAt)) errors.push("dom-commit-time-missing");
  if (!Number.isFinite(closedAt)) errors.push("closed-time-missing");
  if (Number.isFinite(preparedAt)
      && Number.isFinite(domCommittedAt)
      && Number.isFinite(closedAt)
      && (domCommittedAt < preparedAt || closedAt < domCommittedAt)) {
    errors.push("dom-commit-time-reversed");
  }
  return { ok: errors.length === 0, errors, transactions: rows, transaction: entry };
}
