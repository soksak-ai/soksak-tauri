// 실체 id 발급기 — 접두·범위·형식의 단일 진실 (docs/IDENTITY.md 의 시행부).
//
// id 는 전역 유일하고 자기 종류를 말한다: `<접두>-<base32 6자>`. 문자열만 봐도 무엇인지
// 알고(`pan-7k2qx3` = 칸), 카운터가 아니므로 재실행·창 간 재등장이 없다 — `g5` 하나로는
// 그것이 무엇인지도, 어느 창의 것인지도 말할 수 없던 결함(§2-4)을 형식이 닫는다.
//
// 적용 범위는 좁다(§1-4d 범위 규칙). 접두 id 는 **레이아웃 실체 + 셸 세션**에만 쓴다.
// schedule·secret·daemon 같은 축은 자연 키(사용자가 붙인 이름, (ns,key) 쌍)가 이미 의미를
// 갖는다 — 거기에 불투명 id 를 씌우는 것은 개선이 아니라 후퇴다(C2). idScope 게이트가
// 이 두 표를 읽어 범위 밖 발급을 실패시킨다.

/** §1-4d ① 접두 id 를 받는 실체 — 레이아웃 넷 + 셸 세션. 창은 여기 없다:
 *  `w-<uuid4>` 를 현행 유지하고 Rust 가 발급한다(§1-1 — `win-` 은 소각된 세대다). */
export const ID_PREFIX = {
  project: "pjt-",
  space: "spc-",
  pane: "pan-",
  tab: "tab-",
  shellSession: "sh-",
} as const;

export type IdKind = keyof typeof ID_PREFIX;

/** §1-4d ② 자연 키를 유지하는 축 — 여기서 접두 id 를 발급하면 idScope 게이트가 실패한다. */
export const NATURAL_KEY_AXES = [
  "ai.session",
  "daemon",
  "data.encrypt",
  "data.kv",
  "process",
  "registry",
  "schedule",
  "secret",
  "settings",
  "sidecar",
  "theme",
  "ui.projection",
  "webview",
] as const;

// base32(RFC 4648 lowercase) — 숫자 0/1 과 문자 o/l 의 혼동 축을 처음부터 제거한 알파벳.
// 6자 = 32^6 ≈ 10억. 이 제품의 실체 수(창당 수십)에서 생일 충돌은 사실상 없고, 있더라도
// 해소가 `AMBIGUOUS` + 후보 경로로 정의돼 있다(§S2) — 낮은 확률을 없는 것으로 다루지 않는다.
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const LEN = 6;

function randomBody(): string {
  let body = "";
  // crypto.getRandomValues 는 렌더러·노드(테스트) 양쪽에 있다 — Math.random 은 쓰지 않는다.
  const buf = new Uint8Array(LEN);
  globalThis.crypto.getRandomValues(buf);
  for (const b of buf) body += ALPHABET[b % 32];
  return body;
}

/** 새 실체 id 를 발급한다. 유일한 발급 지점 — 이 밖에서 접두 문자열을 조립하면 게이트가 잡는다.
 *  접두는 리터럴로 쓴다(동적 lookup 금지) — idScope 게이트가 발급 앵커를 정적으로 세므로,
 *  표에서 꺼내 붙이면 발급이 관측 밖으로 사라진다. 표와 리터럴의 일치는 ids 게이트가 지킨다. */
export function issueId(kind: IdKind): string {
  const body = randomBody();
  switch (kind) {
    case "project":
      return `pjt-${body}`;
    case "space":
      return `spc-${body}`;
    case "pane":
      return `pan-${body}`;
    case "tab":
      return `tab-${body}`;
    case "shellSession":
      return `sh-${body}`;
  }
}

/** 표준형 검사 — 마이그레이션·게이트·주소 해소가 공유한다. */
export const ID_RE = /^(pjt|spc|pan|tab|sh)-[a-z2-7]{6}$/;

/** id 의 종류를 접두에서 읽는다. 표준형이 아니면 null(구형 카운터 id 등). */
export function kindOf(id: string): IdKind | null {
  if (!ID_RE.test(id)) return null;
  const prefix = `${id.slice(0, id.indexOf("-"))}-`;
  for (const [kind, p] of Object.entries(ID_PREFIX)) {
    if (p === prefix) return kind as IdKind;
  }
  return null;
}
