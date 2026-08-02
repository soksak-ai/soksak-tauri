// 콘텐츠 뷰 — 앱이 웹 콘텐츠를 부르는 **하나의 표면**.
//
// 여기 있는 것은 계약과 자리 선언과 등록부뿐이다. **채우는 물건은 여기 없다.**
//
// 콘텐츠가 무엇인지는 프레임워크가 정한다: 어떤 프레임워크에서는 OS 자식 뷰라 문서 밖에
// 살고 좌표를 써 줘야 움직이며, 어떤 프레임워크에서는 태그라 문서 안에 살고 자리의 자식이면
// 끝이다. 그 둘은 앱이 고르는 것이 아니다 — 한쪽은 태그를 줄 수 없고 다른 쪽은 label 로
// 부르는 OS 자식 뷰를 줄 수 없다. 그러므로 구현은 각자의 프레임워크 파일에 살고(framework/
// tauri/, framework/electron/), 여기서는 **누가 걸었는지 묻지 않고** 그것을 쓴다.
//
// 부르는 쪽(plugins/api.ts)은 어느 쪽인지 모른다. 그것이 이 파일이 있는 이유다.
import { moduleState } from "../lib/moduleState";

/** 콘텐츠 뷰 하나에 할 수 있는 일 — 앱의 webview_* 표면과 이름·인자가 같다. */
export interface ContentViewHost {
  open(label: string, opts: Record<string, unknown>): Promise<void>;
  close(label: string): Promise<void>;
  list(): Promise<string[]>;
  alive(label: string): Promise<boolean>;
  navigate(label: string, url: string): Promise<void>;
  /**
   * 이 뷰를 이 사각형에 맞춘다.
   *
   * 좌표로 미는 구현에게는 **명령**이고, 자리의 자식으로 사는 구현에게는 **대조**다 —
   * 후자는 이미 맞춰져 있으므로 다시 쓸 것이 없고, 어긋났다면 그 사실을 답한다.
   * 어느 쪽이든 `false` 는 "안 맞았다"는 뜻이다. 조용한 성공은 없다.
   */
  bounds(label: string, x: number, y: number, w: number, h: number): Promise<boolean>;
  visible(label: string, visible: boolean, focus?: boolean): Promise<void>;
  history(label: string, delta: number): Promise<void>;
  stop(label: string): Promise<void>;
  zoom(label: string, factor: number): Promise<number>;
  devtools(label: string): Promise<boolean>;
  evalJs(label: string, js: string): Promise<string>;
  /** 스크립트 주입. 반환은 해지 — 주입을 되돌릴 수 없는 구현은 해지가 no-op 임을 스스로 밝힌다. */
  injectScript(label: string, code: string, phase: "document-start" | "document-end"): () => void;
  /** 앱 밖 창으로 연다(외부 브라우저가 아니라 이 앱의 새 창). */
  openWindow(url: string): Promise<void>;
  /**
   * 콘텐츠 뷰 **안**으로 진짜 입력을 넣는다 — 뷰 좌표(CSS px).
   *
   * 스크립트로 만든 클릭에는 사용자 활성화가 없어서 엔진이 창-열기 같은 것을 막는다(실측
   * 2026-08-02: `_blank` 링크를 스크립트로 눌러도 창-열기 요청이 0회였다). 그래서 검증이
   * "잴 방법이 없다"로 멈췄다 — 없으면 만드는 것까지가 이 자리의 몫이다(A27).
   *
   * 못 하는 구현은 이름을 달고 거절한다. 조용히 성공하면 부른 쪽은 눌렀다고 믿는다.
   */
  sendInput(label: string, x: number, y: number): Promise<void>;
}

/**
 * 콘텐츠 뷰가 **어디에 사는가**를 선언하는 속성 — 값은 label 이다.
 *
 *   <div className="bv-area" data-content-view-body={label} />
 *
 * 선언은 하나이고 읽는 쪽이 둘이다: 좌표로 미는 구현에게 이 자리는 **추종 앵커**이고,
 * 문서 안에 사는 구현에게는 **부모**다. 선언하는 쪽(플러그인)은 그 차이를 몰라도 된다.
 */
export const CONTENT_VIEW_BODY = "data-content-view-body";

/** 이 label 을 위해 선언된 자리. 없으면 이 뷰는 **자리가 없는** 뷰다(화면에 놓이지 않는다). */
export function findContentViewSlot(label: string, doc: Document): HTMLElement | null {
  for (const el of doc.querySelectorAll<HTMLElement>(`[${CONTENT_VIEW_BODY}]`)) {
    if (el.getAttribute(CONTENT_VIEW_BODY) === label) return el;
  }
  return null;
}

// 갈아끼우기 경계 밖 — 이 자리가 새것이 되면 건 쪽은 이미 걸었다고 알아 다시 걸지 않는다.
const registered = moduleState("lib/contentViews#host", () => ({
  host: null as ContentViewHost | null,
}));

/** 프레임워크가 자기 구현을 건다. 적재되는 순간 한 번 — 코어는 부르지 않는다. */
export function registerContentViewHost(host: ContentViewHost): void {
  registered.host = host;
}

/**
 * 활성 구현 — **프레임워크 이름도 능력도 묻지 않는다.**
 *
 * 아무도 안 걸었으면 이름을 달고 거절한다. 빈 구현을 돌려주면 부른 쪽은 열었다고 믿은 채
 * 아무것도 안 보이는 화면을 보고, 그 침묵은 오류로 나타나지 않는다.
 */
export function contentViewHost(): ContentViewHost {
  if (!registered.host) {
    throw new Error(
      "콘텐츠 뷰 구현이 걸려 있지 않습니다(framework/<name>/install 이 걸어야 합니다)",
    );
  }
  return registered.host;
}

/** 걸렸는가 — 감사·진단이 "없음"과 "비어 있음"을 가르는 자리. */
export function hasContentViewHost(): boolean {
  return registered.host !== null;
}

/** 테스트 전용 초기화 — 등록부는 갈아끼우기 경계 밖이라 모듈 재평가로는 안 비워진다. */
export function __resetContentViewHostForTest(): void {
  registered.host = null;
}
