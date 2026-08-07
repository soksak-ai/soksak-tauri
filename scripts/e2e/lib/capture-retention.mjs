// 사람용 캡처도 자기 자리를 스스로 지킨다.
//
// 기계 판정 저장소는 한도와 회수를 든다(evidence-retention). 사람용 캡처(B12 냉시동 PNG)는 그
// 밖이라 아무도 비우지 않았고, 실행마다 76MB 씩 쌓여 764MB 가 됐다 — 손으로 지우는 것이 유일한
// 관리였다. 손으로 하는 관리는 관리가 아니라 회피다.
//
// 판정 저장소와 규칙이 다른 이유: 이 자리는 바이트 한도가 아니라 **되짚을 실행 수**로 센다.
// 사람이 보는 증거는 "최근 몇 판을 다시 볼 수 있는가" 가 쓸모의 기준이다.
import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

/**
 * 캡처 저장소에서 최신 keepRuns 개만 남기고 오래된 실행을 회수한다.
 *
 * @param {string} root 실행 디렉터리들이 사는 자리
 * @param {{keepRuns: number, keep?: readonly string[]}} options
 * @returns {string[]} 회수한 실행 이름
 */
export function reclaimCaptureRuns(root, { keepRuns, keep = [] } = {}) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    // 없는 자리는 조용히 넘어간다 — 첫 실행이 회수 때문에 실패하면 안 된다.
    return [];
  }
  const held = new Set(keep);
  const rows = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    let at;
    try {
      at = statSync(dir).mtimeMs;
    } catch {
      continue;
    }
    // 순서를 못 읽은 실행은 회수 대상이 아니다 — 못 읽음을 "가장 오래됨" 으로 읽으면 최신
    // 기여가 먼저 사라진다.
    if (!Number.isFinite(at)) continue;
    rows.push({ name: entry.name, dir, at });
  }
  rows.sort((left, right) => right.at - left.at);
  const reclaimed = [];
  let kept = 0;
  for (const row of rows) {
    if (held.has(row.name)) continue;
    if (kept < keepRuns) { kept += 1; continue; }
    rmSync(row.dir, { recursive: true, force: true });
    reclaimed.push(row.name);
  }
  return reclaimed;
}
