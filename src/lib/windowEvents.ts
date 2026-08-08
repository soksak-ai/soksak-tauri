import { currentWindow, type FrameworkEvent, type Unlisten } from "../framework";

// 이 창(webview)으로 *타겟된* 이벤트만 구독한다. Rust 는 멀티 윈도우 신호를 emit_to(label) 로 보내므로
// 각 창은 자기 신호만 받아야 한다. 전역 listen(프레임워크 경계)은 타겟과 무관하게 모든 창의
// 이벤트를 받는다 — emit_to(다른 창) 한 cmd-request 를 main 의 전역 listen 도 실행해 명령이 두 창에서
// 중복 실행된다(창별 독립 붕괴). currentWindow().listen 은 "이 창에 emit 된 이벤트"만
// 받으므로 emit_to 타겟팅이 플랫폼 레벨에서 격리된다 — JS 쪽 label 비교(꼼수) 불요.
//
// currentWindow() 는 프레임워크 런타임 밖(jsdom 테스트)에서 동기적으로 throw 하므로 try 로 감싼다
// (전역 listen 은 promise reject 였지만 이건 동기 throw). 반환 = 해지 함수(언마운트 정리용).
/**
 * 구독 하나. 부르면 해지하고, `ready` 는 **정말 듣기 시작한 시점**에 풀린다.
 *
 * 등록은 비동기다 — `listen()` 이 프레임워크에 닿아 돌아와야 그 창이 사건을 받는다. 이 함수가
 * 돌아왔다는 사실은 "등록을 시작했다" 이지 "듣고 있다" 가 아니다. 둘을 같은 것으로 읽으면
 * 그 사이에 온 사건이 조용히 사라진다 — 실측 2026-08-08: 밀린 배달을 회수하는 신호를 이
 * 함수가 돌아온 직후에 보냈더니 회수한 봉투마저 아직 없는 리스너에게 가서 또 사라졌고,
 * 첫 명령은 그대로 상한 10 초를 채웠다.
 *
 * 해지는 그대로 함수 호출이다(React 정리와 같은 모양). 듣기 시작을 기다려야 하는 자리만
 * `ready` 를 읽는다.
 */
export interface WindowSubscription {
  (): void;
  readonly ready: Promise<void>;
}

export function listenThisWindow<T>(
  event: string,
  handler: (e: FrameworkEvent<T>) => void,
): WindowSubscription {
  let off: Unlisten | null = null;
  let cancelled = false;
  let listening: Promise<void> = Promise.resolve();
  try {
    listening = currentWindow()
      .listen<T>(event, handler)
      .then((fn) => {
        // 중간 해지: fn() 의 반환 promise 를 체인에 입양(return)해야 reject 가 아래 catch 로 간다.
        if (cancelled) {
          void fn();
          return;
        }
        off = fn;
      })
      .catch(() => {});
  } catch {
    /* 프레임워크 런타임 없음(테스트) — 구독 없음 */
  }
  const unsubscribe = () => {
    cancelled = true;
    if (off) {
      // tauri v2 UnlistenFn 은 async — 이미 해제된 리스너의 TypeError 가 promise reject 로
      // 온다(safeListen 과 동일 실측). 동기·비동기 모두 무해화(재해지 멱등).
      try {
        const r = off() as unknown;
        if (r && typeof (r as Promise<unknown>).catch === "function") {
          void (r as Promise<unknown>).catch(() => {});
        }
      } catch {
        /* 이미 해제 — no-op */
      }
      off = null;
    }
  };
  return Object.assign(unsubscribe, { ready: listening }) as WindowSubscription;
}
