// 모듈 전역 상태의 정의 자리 — 여기 선언한 것은 갈아끼워도 사라지지 않는다.
//
// dev 서버는 고친 모듈과 그 importer 체인을 갈아끼운다. 모듈 전역에 사는 등록부는 그때 새 빈
// 것이 되는데, 그것을 채우던 모듈이 함께 재평가되지 않으면 **영영 빈 채로 남는다**. 등록이
// 모듈 평가의 부수효과이기 때문이다: 채우는 쪽이 안 돌면 다시 채워지지 않는다.
//
// 실측(2026-07-31): 코어 명령 카탈로그가 통째로 사라졌다. 창은 살아 있고 플러그인 명령은
// 답하는데 `ui.*`·`state.*`·`window.*` 만 전부 UNKNOWN_COMMAND 였다. 사용자에게는 "탭의 +
// 로 생성이 안 된다"로 보였고(+ 는 등록 프로그램 0이면 사라진다), 화면 어디에도 원인이
// 적혀 있지 않았다. 되던 것이 우연처럼 안 되는 상태다.
//
// 보관은 globalThis 다. 갈아끼우기가 닿지 않는 유일한 자리이기 때문이다 — 이 모듈 자신의
// `import.meta.hot.data` 에 두면 이 파일을 고치는 순간 같은 결함이 재현된다.
//
// 프로덕션 번들에는 갈아끼우기가 없다. 거기서는 그냥 만든다(전역 오염 0).

const BAG_KEY = "__soksakModuleState";

function bag(): Map<string, { value: unknown; make: unknown }> | null {
  // env 는 번들러 주입이다 — 없거나 PROD 면 보존이 필요 없는 환경이다.
  const env = (import.meta as { env?: { PROD?: boolean } }).env;
  if (!env || env.PROD) return null;
  const g = globalThis as Record<string, unknown>;
  const existing = g[BAG_KEY];
  if (existing instanceof Map) return existing as Map<string, { value: unknown; make: unknown }>;
  const fresh = new Map<string, { value: unknown; make: unknown }>();
  g[BAG_KEY] = fresh;
  return fresh;
}

/**
 * 갈아끼워도 같은 것을 돌려준다.
 *
 * `key` 는 그 상태의 이름이다 — 모듈 경로와 변수 이름을 합쳐 유일하게 짓는다. 두 상태가 같은
 * 이름을 쓰면 한쪽이 다른 쪽의 내용을 물려받는다(조용한 오염). 그 충돌은 **정적 게이트**가
 * 잡는다: 갈아끼우기는 함수 정체성을 바꾸므로 런타임에서 "같은 자리의 재평가"와 "다른 자리의
 * 이름 도용"을 가릴 방법이 없다.
 */
export function moduleState<T>(key: string, make: () => T): T {
  const b = bag();
  if (!b) return make();
  const hit = b.get(key) as { value: T; make: unknown } | undefined;
  if (hit) {
    // 같은 자리의 재평가면 make 가 새 함수여도 **이름이 같다** — 그것은 정상이다.
    // 다른 자리가 같은 이름을 쓰면 조용히 남의 값을 받는다: 실측(2026-07-31) — 한 파일에서
    // 두 상태가 `#state` 를 함께 써서, 뒤엣것이 앞엣것의 객체를 받아 자기 필드가 없었다.
    // 침묵하는 오염이라 오류를 내지 않는다. 그래서 **모양으로** 가른다.
    const want = make();
    if (!sameShape(hit.value, want)) {
      throw new Error(
        `모듈 상태 이름 충돌: ${key} — 다른 모양의 상태가 같은 이름을 씁니다`,
      );
    }
    return hit.value;
  }
  const value = make();
  b.set(key, { value, make });
  return value;
}

/** 같은 자리인가 — 평범한 객체면 키 집합으로, 그 밖(Map·Set 등)이면 생성자로 가른다. */
function sameShape(a: unknown, b: unknown): boolean {
  if (a === null || b === null) return typeof a === typeof b;
  if (typeof a !== "object" || typeof b !== "object") return typeof a === typeof b;
  if (a.constructor !== (b as object).constructor) return false;
  if (a.constructor !== Object) return true; // Map·Set·클래스는 생성자로 충분하다
  const ka = Object.keys(a).sort().join(",");
  const kb = Object.keys(b as object).sort().join(",");
  return ka === kb;
}
