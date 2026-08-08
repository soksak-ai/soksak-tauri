// 번들이 **어떻게 왔는가**를 값으로 판정한다.
//
// 부팅에서 옮기는 양이 곧 기다림이다. 실측 2026-08-08: 34 개 번들을 IPC 로 나르면 818ms,
// 엔진의 자원 경로로 가져오면 41ms 였다(23.8MB 중 약 15MB 가 문자열로 직렬화돼 경계를 건넜다).
//
// 이 판정이 필요한 이유는 그 회귀가 **조용하기 때문**이다. 통로가 막히면 부팅이 죽지 않는다 —
// 활성화가 하나씩 자기 것을 다시 읽어서, 느려진 채로 정상처럼 돈다. 0 만 남으면 통로가 막힌
// 것인지 플러그인이 없는 것인지도 못 가른다.
//
// 그래서 부팅 원장의 도장 하나를 읽는다: `plugins:prefetched:<받은>/<원한>:<ms>`.

/** 원장에서 이 사실을 든 도장을 찾는다. 없으면 잰 적이 없다 — 통과가 아니다. */
export function bundleTransportVerdict({ steps = [], budgetMs = 200 } = {}) {
  const stamp = steps
    .map((row) => String(row?.step ?? ""))
    .find((step) => step.startsWith("plugins:prefetched:"));
  const failure = steps
    .map((row) => String(row?.step ?? ""))
    .find((step) => step.startsWith("prefetch-failed:"));
  if (stamp === undefined) {
    return {
      status: "blocked",
      reason: "번들 도장이 원장에 없다 — 이 부팅에서 번들 적재를 재지 못했다",
      evidence: [],
    };
  }
  const match = /^plugins:prefetched:(\d+)\/(\d+):(\d+)ms$/.exec(stamp);
  if (match === null) {
    return { status: "blocked", reason: `도장 모양이 다르다: ${stamp}`, evidence: [] };
  }
  const [, gotText, wantedText, msText] = match;
  const got = Number(gotText);
  const wanted = Number(wantedText);
  const elapsedMs = Number(msText);
  const evidence = [`bundles=${got}/${wanted}`, `transport=${elapsedMs}ms/${budgetMs}ms`];
  if (wanted === 0) {
    // 원한 것이 없으면 통로를 잰 적이 없다. 0/0 을 통과로 읽으면 플러그인이 하나도 안 뜬
    // 부팅이 가장 빠른 부팅으로 기록된다.
    return { status: "blocked", reason: "적재할 번들이 없었다 — 통로를 재지 못했다", evidence };
  }
  if (got < wanted) {
    return {
      status: "red",
      reason: `번들 ${wanted - got}개가 통로를 못 지났다${failure ? ` (${failure})` : ""}`,
      evidence,
    };
  }
  if (elapsedMs > budgetMs) {
    return { status: "red", reason: "번들이 IPC 를 지나고 있다(양이 곧 기다림)", evidence };
  }
  return { status: "green", reason: null, evidence };
}
