// 홀은 **네이티브 층이 있을 때만** 뜻이 있다.
//
// 홀이 필요한 이유는 메인 웹뷰 아래에 네이티브 자식(브라우저 webview·엔진 서피스)이 형제로
// 있고 OS 히트테스트가 먼저 가져가기 때문이다. 콘텐츠가 DOM 안에 사는 프레임워크에서는 그
// 층이 없으므로 홀도 없다 — 그때 보내는 것은 no-op 이 아니라 **없는 개념에 대한 호출**이고,
// 프레임워크는 그것을 거절한다(FRAMEWORK_CONCEPT_ABSENT). 거절을 삼키면 조용해지고, 안 삼키면
// 부팅 원장이 실패로 물든다. 둘 다 답이 아니다 — **묻지 않는 것**이 답이다.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async () => undefined);
let provision = { chromium: false, nativeChildWebview: true };

vi.mock("../framework", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  get engineProvision() {
    return provision;
  },
}));
vi.mock("../plugins/hooks", () => ({ onPluginEvent: () => {} }));

async function load() {
  vi.resetModules();
  return import("./domHoles");
}

function layout() {
  document.body.innerHTML =
    '<div class="pane-gutter" style="position:absolute;left:10px;top:0;width:6px;height:100px"></div>';
  for (const el of document.querySelectorAll(".pane-gutter")) {
    (el as HTMLElement).getBoundingClientRect = () =>
      ({ x: 10, y: 0, width: 6, height: 100, left: 10, top: 0, right: 16, bottom: 100 }) as DOMRect;
  }
}

describe("홀 보고는 네이티브 층이 있는 프레임워크에서만 일어난다", () => {
  beforeEach(() => {
    invoke.mockClear();
    layout();
  });

  it("네이티브 자식이 있으면 보고한다", async () => {
    provision = { chromium: false, nativeChildWebview: true };
    const m = await load();
    m.__resetDomHolesForTest();
    m.reportDomHoles();
    expect(invoke).toHaveBeenCalledWith("webview_dom_holes", expect.anything());
  });

  it("네이티브 자식이 없으면 아예 묻지 않는다", async () => {
    provision = { chromium: true, nativeChildWebview: false };
    const m = await load();
    m.__resetDomHolesForTest();
    m.reportDomHoles();
    expect(invoke).not.toHaveBeenCalled();
  });

  // 오라클 생존 — 수집이 0건이면 위 두 단언이 같은 이유로 통과한다("0 의 두 얼굴").
  it("수집이 실제로 사각형을 찾는다", async () => {
    const m = await load();
    expect(m.collectHoles(document).length).toBeGreaterThan(0);
  });
});
