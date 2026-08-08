// 사람이 페이지를 누르면 **그 페이지가 받는다.**
//
// 이 프레임워크에서 콘텐츠는 메인 웹뷰 아래에 깔린 자식 표면이다. 그래서 사람이 페이지 위를 눌러도
// 그 사건은 위에 있는 메인 웹뷰가 받는다 — 아래로 저절로 내려가지 않고, CSS 로는 네이티브 형제에게
// 클릭을 넘길 수 없다.
//
// 실측 2026-08-08: 명령으로 넣은 클릭은 세 브라우저 모두 링크를 따라갔는데 사람이 손으로 누르면
// 아무 일도 안 일어났다. 주입 경로만 살아 있었고 사람 경로는 처음부터 없었다.
//
// 뷰 안의 노드(주소줄·버튼)는 이미 이 방식으로 넘긴다(pluginViewPresentation). 빠져 있던 것은
// **콘텐츠 자리**다. 다른 프레임워크에는 이 배선이 없다 — 거기서는 콘텐츠가 문서 안에 살아서
// 사건이 그냥 도착한다.
import { CONTENT_VIEW_BODY, contentViewHost, hasContentViewHost } from "../../lib/contentViews";
import type { SurfacePointerInput } from "../../lib/contentViews";

const KIND: Record<string, "down" | "up" | "move"> = {
  mousedown: "down",
  mouseup: "up",
  mousemove: "move",
};

/**
 * 문서 전체에서 콘텐츠 자리 위의 포인터를 그 표면으로 넘긴다. 반환은 해지 — 남기면 사라진
 * 표면으로 계속 보낸다.
 */
export function installContentInputForwarding(doc: Document): () => void {
  const forward = (event: MouseEvent) => {
    const named = KIND[event.type];
    if (named === undefined) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    // 자리는 선언이 안다 — 좌표로 뒤지면 겹친 자리에서 남의 표면을 고른다.
    const slot = target.closest<HTMLElement>(`[${CONTENT_VIEW_BODY}]`);
    const label = slot?.getAttribute(CONTENT_VIEW_BODY);
    if (!slot || !label || !hasContentViewHost()) return;
    const rect = slot.getBoundingClientRect();
    // 버튼을 쥔 이동은 끌기다 — 이동으로 보내면 그 안의 `buttons` 가 0 이라 끌기가 죽는다.
    const kind: SurfacePointerInput["kind"] =
      named === "move" && event.buttons !== 0 ? "drag" : named;
    void contentViewHost()
      .sendInput(label, {
        x: Math.round(event.clientX - rect.left),
        y: Math.round(event.clientY - rect.top),
        kind,
        button: event.button === 2 ? "right" : "left",
        clickCount: Math.max(1, event.detail),
      })
      .catch(() => {});
  };
  // 실클릭도 합성 클릭도 같은 이름을 낸다 — 사람 경로와 검증 경로가 같은 경로다.
  const names = ["mousedown", "mouseup", "mousemove"] as const;
  for (const name of names) doc.addEventListener(name, forward, true);
  return () => {
    for (const name of names) doc.removeEventListener(name, forward, true);
  };
}
