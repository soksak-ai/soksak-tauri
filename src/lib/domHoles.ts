// DOM 오버레이 홀 — "이 사각형은 네이티브 층 아래에서도 DOM 이 마우스를 갖는다"의 단일 소유자.
//
// 왜 필요한가: 코어 레이어는 메인 웹뷰(투명)를 맨 위에 두고 네이티브 child(브라우저 webview·
// 엔진 서피스)를 그 아래 형제로 둔다. 메인 웹뷰의 hitTest 가 nil 을 돌려주는 자리에서는 아래
// 네이티브가 마우스를 가져간다 — 그래서 DOM 이 반드시 받아야 하는 자리는 홀로 선언해야 한다.
//
// RED 근거(사용자 실측, 2026-07-27): 브라우저가 있는 열의 분할 드래그바가 끌리지 않았다.
// 골(.pane-gutter)은 seam 중심 ±3px 밴드라 이웃 슬롯을 침범하는데(설계 — 잡기 편한 폭),
// 그 자리에 네이티브 표면이 있으면 OS 히트테스트가 먼저 가져간다. 홀 등록은 우측 사이드바
// 하나뿐이었고 골은 통째로 빠져 있었다 — 그 공백이 원인이다.
//
// 계약: 홀 목록 = 열린 우측 사이드바 + 보이는 모든 골. 갱신은 사건 구동(레이아웃 커밋·창
// 리사이즈·사이드바 변화)이고, 같은 값의 재발행은 침묵한다(멱등).
import { moduleState } from "../lib/moduleState";
import { engineProvision, invoke } from "../framework";
import { onPluginEvent } from "../plugins/hooks";

export interface Hole {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 지금 화면에서 DOM 이 마우스를 가져야 하는 사각형들(순수 수집 — 테스트가 직접 부른다). */
export function collectHoles(doc: Document = document): Hole[] {
  const out: Hole[] = [];
  const push = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    if (r.right <= 0 || r.left >= (doc.defaultView?.innerWidth ?? 1e9)) return; // 파킹
    out.push({ x: r.left, y: r.top, w: r.width, h: r.height });
  };
  const sb = doc.querySelector(".sidebar-right.open");
  if (sb) push(sb);
  // 골은 전부 — 네이티브 표면 위에 있든 아니든 홀이어야 한다(표면은 언제든 그 아래로 온다).
  for (const g of doc.querySelectorAll(".pane-gutter")) push(g);
  return out;
}

let lastSig = "";

/** 수집→발행(같은 값이면 침묵). 레이아웃 커밋 다음 프레임에 부르는 것이 정확하다. */
export function reportDomHoles(): void {
  if (typeof document === "undefined") return;
  // 홀은 **네이티브 층이 있을 때만** 뜻이 있다. 콘텐츠가 DOM 안에 사는 프레임워크에는 그
  // 층이 없어 OS 히트테스트가 끼어들 자리도 없다 — 그때 보내는 것은 없는 개념에 대한
  // 호출이고, 프레임워크는 그것을 거절한다. 거절을 삼키면 조용해지고 안 삼키면 부팅 원장이
  // 실패로 물든다. 둘 다 답이 아니라 **묻지 않는 것**이 답이다.
  if (!engineProvision.nativeChildWebview) return;
  const holes = collectHoles();
  const sig = JSON.stringify(holes.map((h) => [Math.round(h.x), Math.round(h.y), Math.round(h.w), Math.round(h.h)]));
  if (sig === lastSig) return;
  lastSig = sig;
  void invoke("webview_dom_holes", { holes }).catch(() => {});
}

// "이미 붙였다"는 기억은 갈아끼우기 경계를 넘어야 한다 — 이 플래그만 사라지면 설치는
// 안 남았는데 채우던 쪽은 이미 돌았다고 알아 다시 붙이지 않는다(영영 미설치).
const installedFlag = moduleState("lib/domHoles#installedFlag.on", () => ({ on: false }));

/** 사건 구동 갱신 설치 — 부트 1회(멱등). 폴링 없음. */
export function installDomHoles(): void {
  if (installedFlag.on || typeof window === "undefined") return;
  installedFlag.on = true;
  const schedule = () => requestAnimationFrame(() => reportDomHoles());
  // 레이아웃 커밋(분할·탭 전환·사이드바·레일 주행)의 단일 신호.
  onPluginEvent("layout.reflow", schedule);
  onPluginEvent("layout.resize-gesture", (p) => {
    if (!p.active) schedule(); // 드래그 종료 착지에서 1회
  });
  window.addEventListener("resize", schedule);
  schedule();
}

/** 테스트 전용 초기화. */
export function __resetDomHolesForTest(): void {
  installedFlag.on = false;
  lastSig = "";
}
