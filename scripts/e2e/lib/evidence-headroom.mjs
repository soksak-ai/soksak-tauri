// 인수 실행이 자기 증거를 담을 자리가 있는지 먼저 답한다.
//
// 증거 저장소는 자기 한도(전체 2GiB)를 지키지만 파일시스템이 먼저 차면 그 한도에 닿기 전에
// 실행이 무너진다 — 실측 2026-08-07: ENOSPC 하나가 slot-freeze 중간에 나서 뒤따르는 재시작과
// B12 두 사이클을 통째로 죽였고, 집계는 framework drift 로 red 가 됐다. 제품과 무관한 red 다.

// 이 실행이 곧바로 다시 만드는 자리는 회수처가 아니다.
//
// 실측 2026-08-07: 앞선 안내가 target/debug 를 "재생성 가능한 host 캐시"로 가리켰고, 그대로
// 지웠더니 인수 타깃이 첫 단계에서 통째로 다시 빌드해 3.8GiB 를 도로 먹었다 — 자리를 비운 게
// 아니라 같은 자리를 더 오래, 더 크게 쓴 것이다. 회수 안내는 이 목록을 가리키지 않는다.
export const REBUILT_BY_THIS_RUN = Object.freeze([
  "target/debug",
  "target/aarch64-apple-darwin/debug",
  "node_modules",
]);

// 실행이 다시 만들지 않는 자리만 회수처로 답한다.
export const RECLAIM_HINTS = Object.freeze([
  "지난 실행의 증거: ~/.soksak-e2e/evidence/*/runs (current 는 남긴다)",
  "make doctor-fix",
]);

function readGib(value) {
  const gib = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(gib) ? gib : null;
}

export function judgeHeadroom({ freeGib, needGib, phase }) {
  const free = readGib(freeGib);
  const reclaim = RECLAIM_HINTS.map((hint) => `  · ${hint}`).join("\n");

  if (free === null) {
    return {
      ok: false,
      message: [
        `증거를 담을 여유를 못 읽었다(${phase}) — 못 읽음은 넉넉함이 아니다.`,
        reclaim,
      ].join("\n"),
    };
  }

  if (free >= needGib) return { ok: true, message: "" };

  return {
    ok: false,
    message: [
      `디스크 여유 ${free}GiB — 인수 실행은 ${phase} 시점에 ${needGib}GiB 이상이 필요하다.`,
      "증거 저장소 한도(2GiB)에 닿기 전에 파일시스템이 먼저 차면 제품과 무관한 red 가 남는다.",
      "회수:",
      reclaim,
    ].join("\n"),
  };
}
