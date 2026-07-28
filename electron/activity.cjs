// 활동 부채질 — 발행 3단 중 **프레임워크의 것**.
//
// 발행은 셋이다: 적재(도장·단조) · 부채질(창 emit) · 영속(records 쓰기). cored 프로세스엔 창이
// 없어 적재까지만 하고 도장 찍힌 항목을 응답에 실어 준다. 창은 프레임워크의 것이므로 부채질은 프레임워크가
// 한다 — 안 하면 프론트가 반환값을 버리므로(void invoke) 활동 구독자가 오류 한 줄 없이 굶는다.
//
// 항목의 소비자는 둘이고 서로 다르다:
//   ① 호출자 — invoke 의 반환값. 도장(seq·ts)을 알아야 하는 부른 쪽의 것이다.
//   ② 창 구독자 — listen("activity") 로 받는 사건. 이 파일이 미는 쪽이다.
// 그래서 같은 항목이 두 경로로 흐르지만 한 창에 두 번 도착하지는 않는다: 반환값은 사건이
// 아니고, 부른 창도 브로드캐스트로 딱 한 번 받는다(코어의 emit 이 그렇다 — 발신 창을 빼지도
// 더하지도 않는다).
//
// electron 을 require 하지 않는다 — 프레임워크를 띄워야만 검증되는 코드는 사실상 검증되지 않는다.

/** 이 명령의 답만 부채질 대상이다. 코어의 발행 진입점과 같은 이름. */
const ACTIVITY_PUBLISH = "activity_publish";

/** 창이 받는 사건 이름. 코어의 broadcast 와 같아야 프론트가 프레임워크를 가리지 않는다. */
const ACTIVITY_EVENT = "activity";

/** 전역 사건이 렌더러로 건너가는 채널 — preload 가 이 봉투를 이름별로 나눈다. */
const EVENT_CHANNEL = "framework:event";

/** 적재분이 아닌 답 — 부채질할 것이 없다. */
const NOT_AN_ENTRY = "FRAMEWORK_ACTIVITY_NOT_AN_ENTRY";

/**
 * 도장 찍힌 활동 항목인가 — 적재가 매기는 축이 다 있어야 한다.
 *
 * 모양을 안 보고 미는 것이 곧 조용한 실패다: 프론트는 `payload.seq` 로 백필 겹침을 가르고
 * `kind` 로 갈래를 나누므로, 아닌 것을 밀면 구독자가 오류 없이 어긋난다.
 */
function isActivityEntry(v) {
  return (
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Number.isFinite(v.seq) &&
    Number.isFinite(v.ts) &&
    typeof v.kind === "string" &&
    typeof v.source === "string" &&
    !!v.payload &&
    typeof v.payload === "object"
  );
}

/**
 * 창 하나에 사건 하나. 반환 = 닿았는가.
 * 죽은 창·던진 창은 false 다 — 삼키면 유실이 성공으로 위장된다.
 */
function deliver(win, event, payload) {
  try {
    if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) return false;
    const wc = win.webContents;
    if (!wc || typeof wc.send !== "function") return false;
    wc.send(EVENT_CHANNEL, { event, payload });
    return true;
  } catch {
    return false;
  }
}

/**
 * 부채질 — 살아 있는 창 **전부**에 같은 사건 이름·같은 페이로드로 배달한다.
 *
 * 라벨을 고르지 않는다: 활동 원장은 "누구에게"가 없는 사건이고, 코어의 broadcast 도 창을
 * 가리지 않는다(발신 창 포함 전부). 창마다 정확히 한 번씩이다.
 *
 * 코어는 목록을 걷지 않고 한 번의 배달로 자식 웹뷰까지 닿지만, 여기엔 그런 배달이 없어
 * 목록을 걷는다. 이 프레임워크에서는 그 둘이 같은 집합이다 — 자식 표면을 만들지 않으므로 창
 * 레지스트리가 곧 받는 쪽 전부다(webview_list 가 그 사실을 값으로 답한다). 프레임워크가 자식
 * 표면을 갖게 되면 그것도 목록에 들어와야 한다: 안 그러면 새 표면만 조용히 굶는다.
 *
 * 반환 = 전부에게 닿았는가. 일부만 닿은 것을 참으로 올리면 유실이 성공으로 위장된다.
 */
function fanOut(entry, windows) {
  let all = true;
  for (const win of windows) {
    if (!deliver(win, ACTIVITY_EVENT, entry)) all = false;
  }
  return all;
}

module.exports = {
  ACTIVITY_PUBLISH,
  ACTIVITY_EVENT,
  EVENT_CHANNEL,
  NOT_AN_ENTRY,
  isActivityEntry,
  fanOut,
};
