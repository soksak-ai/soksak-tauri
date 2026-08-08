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
import {
  readCompositionParticipant,
  type CompositionParticipant,
} from "./compositionParticipants";

/** 콘텐츠 뷰 하나에 할 수 있는 일 — 앱의 webview_* 표면과 이름·인자가 같다. */
/** 표면에 넣는 포인터 한 사건 — **무엇이 일어났는지**까지 나른다.
 *
 * 좌표만 나르면 누름·뗌·이동·더블클릭·오른버튼이 전부 같은 값이 되고, 받는 쪽은 하나만
 * 흉내낼 수 있다. 그러면 그 표면은 "눌리기는 하는데 끌리지도 우클릭되지도 않는" 자리가 된다.
 */
export interface SurfacePointerInput {
  /** 표면 자기 좌상단 기준 CSS px. */
  x: number;
  y: number;
  /** `drag` 는 버튼이 눌린 채 움직임이다 — `move` 로 보내면 페이지가 받는 mousemove 의
   *  `buttons` 가 0 이라 끌기를 보는 코드가 아무 일도 안 한다.
   *  `enter`/`exit` 는 표면에 **들어오고 나가는** 사실이다 — 이동과 다른 사건이고, 엔진은
   *  hover 를 이 짝으로 시작하고 끝낸다. */
  kind: "down" | "up" | "move" | "drag" | "enter" | "exit";
  button: "left" | "right";
  /** 1=단발, 2=더블 — 엔진이 이 수로 더블클릭을 만든다. */
  clickCount: number;
}

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
  /** 지정한 뷰의 좌표·가시성 변경이 실제 표시 프레임에 반영될 때 완료된다. */
  presentationSettled(labels: readonly string[]): Promise<void>;
  /** 메인 DOM 크롬의 직전 커밋이 실제 표시 프레임에 반영될 때 완료된다. */
  chromePresentationSettled(): Promise<void>;
  history(label: string, delta: number): Promise<void>;
  stop(label: string): Promise<void>;
  /** 새로고침 — 다시 이동이 아니다.
   *
   * 현재 URL 로 다시 이동해 흉내내면 이력이 한 칸 더 쌓이고, 뒤로 갔던 자리에서 새로고침하면
   * 앞 자리로 되돌아간다(실측 2026-08-08). `ignoreCache` 는 캐시를 버리고 원본에서 받는다. */
  reload(label: string, ignoreCache?: boolean): Promise<void>;
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
  sendInput(label: string, input: SurfacePointerInput): Promise<void>;
  /**
   * 이 표면이 **지금 포인터를 받을 수 있는 상태인가** — 그 프레임워크의 사실 그대로.
   *
   * 안 닿았다는 것만 알면 부른 쪽은 자기 좌표를 의심한다. 배달을 가르는 조건은 표면과 그
   * 창의 상태이고, 그것을 물을 자리가 없으면 원인은 영영 추측이다(실측 2026-08-08: 누름은
   * 도착하고 이동만 0회였는데 무엇이 자르는지 물어볼 데가 없었다).
   *
   * `at` 은 **그 자리**의 사실을 묻는다(표면 좌표 CSS px) — 배달 조건 중에는 자리마다 다른
   * 것이 있다(그 지점의 맨 위 창이 누구인가). 안 주면 지금 커서 자리를 잰다.
   *
   * 답은 프레임워크마다 다른 키를 담아도 된다 — 무엇이 그 표면의 사실인지는 그쪽이 안다.
   */
  inputState(label: string, at?: { x: number; y: number }): Promise<Record<string, unknown>>;
  /** 콘텐츠 뷰 안으로 실제 휠 입력을 넣는다 — 뷰 좌표와 DOM WheelEvent 부호(+아래/+오른쪽). */
  wheel(label: string, x: number, y: number, dx: number, dy: number): Promise<void>;
  captureFull(label: string, path: string, width: number, height: number): Promise<{ path: string; bytes: number }>;
  /** 현재 포커스된 편집 요소에 확정 문자열을 엔진의 텍스트 입력 경로로 넣는다. */
  typeText(label: string, text: string): Promise<void>;
  /**
   * **조합 중**인 글자를 넣는다 — 확정과 다른 사실이다.
   *
   * 한글·일본어·중국어는 확정 전에 조합 상태를 지나고, 그 동안 페이지는 `compositionstart`/
   * `compositionupdate` 를 받으며 아직 값이 아닌 글자를 보여 준다. 확정만 넣을 수 있으면 그
   * 구간을 한 번도 안 지나고 "한글이 들어간다" 고 말하게 된다.
   *
   * 빈 문자열은 조합을 **푼다**(확정) — 사람이 스페이스·엔터로 끝내는 그 자리다. 푸는 자리가
   * 없으면 조합이 열린 채 남아 다음 입력이 그 위에 얹힌다.
   */
  markText(label: string, text: string): Promise<void>;
  /**
   * 키 하나를 표면에 넣는다 — 글자가 아니라 **키**다.
   *
   * 확정 문자열(`typeText`)은 편집 경로로 들어가서 Enter·Escape·화살표를 만들지 못한다. 그런
   * 것으로만 닿는 기능(주소줄 확정, 팔레트 이동, 단축키)은 그래서 검증할 수 없었다.
   */
  sendKey(label: string, key: string, modifiers?: {
    ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean;
  }): Promise<void>;
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

/** 슬롯의 실제 DOM 합성 가시성. 좌표나 프레임워크 표면 상태를 대리값으로 쓰지 않는다. */
export function contentViewSlotVisible(slot: HTMLElement): boolean {
  for (let current: HTMLElement | null = slot; current; current = current.parentElement) {
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (style?.visibility === "hidden" || style?.display === "none") return false;
    if (
      current.hasAttribute("data-project-plane") &&
      current.dataset.projectActive !== "1"
    ) return false;
  }
  return true;
}

export interface ContentViewDomFact {
  label: string;
  slotLabel: string | null;
  directVisibility: string;
  computedVisibility: string;
  display: string;
  projectId: string | null;
  projectActive: boolean;
  /**
   * 이 표면이 스스로 밝힌 합성 참가 선언. 안 실으면 읽는 쪽이 label 문법에서 뷰를 추론하게
   * 되고, 그 추론은 문법이 바뀌는 날 조용히 남의 뷰를 가리킨다. 안 찍혔으면 null 이다.
   */
  composition: CompositionParticipant | null;
  /**
   * 이 표면이 통과시키는 빛 — 어댑터가 자기 표면에 건 감광이 여기 드러난다.
   *
   * 조명은 작업면 평면 하나가 소유한다. 어댑터가 자기 표면을 한 번 더 어둡게 하면 같은 화면이
   * 두 번 감광되는데, 물을 자리가 없으면 판정하는 쪽은 "안 걸었을 것"이라고 써 넣는 수밖에
   * 없다 — 그 순간 그 축은 무엇이 걸려 있어도 영원히 통과한다.
   */
  opacity: string;
  filter: string;
  rect: { x: number; y: number; w: number; h: number };
}

/** 문서 안 콘텐츠 표면의 공개 상태. 네이티브 구현에서는 빈 목록이 곧 사실이다. */
export function contentViewDomFacts(doc: Document = document): ContentViewDomFact[] {
  const out: ContentViewDomFact[] = [];
  for (const el of doc.querySelectorAll<HTMLElement>("[data-content-view]")) {
    const slot = el.closest<HTMLElement>(`[${CONTENT_VIEW_BODY}]`);
    const project = el.closest<HTMLElement>("[data-project-plane]");
    const style = doc.defaultView?.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    out.push({
      label: el.getAttribute("data-content-view") ?? "",
      slotLabel: slot?.getAttribute(CONTENT_VIEW_BODY) ?? null,
      directVisibility: el.style.visibility,
      computedVisibility: style?.visibility ?? "",
      display: style?.display ?? "",
      projectId: project?.dataset.projectPlane ?? null,
      projectActive: project?.dataset.projectActive === "1",
      composition: readCompositionParticipant(el),
      opacity: style?.opacity ?? "",
      filter: style?.filter ?? "",
      rect: {
        x: +rect.x.toFixed(2),
        y: +rect.y.toFixed(2),
        w: +rect.width.toFixed(2),
        h: +rect.height.toFixed(2),
      },
    });
  }
  return out;
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
