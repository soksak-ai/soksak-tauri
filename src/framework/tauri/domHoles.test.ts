// 홀 보고는 **그 장치를 건 프레임워크에서만** 일어난다.
//
// 홀이 필요한 이유는 이 문서 아래에 표면(브라우저 자식 뷰·엔진 서피스)이 형제로 있고 OS
// 히트테스트가 먼저 가져가기 때문이다. 콘텐츠가 문서 안에 사는 프레임워크에는 그 층이 없어
// 홀도 없다 — 그때 보내는 것은 no-op 이 아니라 **없는 개념에 대한 호출**이고, 프레임워크는
// 그것을 거절한다(FRAMEWORK_CONCEPT_ABSENT). 거절을 삼키면 조용해지고, 안 삼키면 부팅 원장이
// 실패로 물든다. 둘 다 답이 아니다 — **묻지 않는 것**이 답이다.
//
// 재입법(2026-08-03): 옛 축은 능력 자문(engineProvision.nativeChildWebview)이었다. 구현이
// 자기 존재를 되묻는 모양이라 틀렸다 — 이 장치를 거는 쪽은 그 프레임워크 자신이고
// (framework/tauri/install.ts), 안 걸었으면 보낼 것도 없다. 축은 **걸렸는가** 하나다.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (_cmd: string, _args?: unknown) => undefined);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}));
vi.mock("../../plugins/hooks", () => ({ onPluginEvent: () => {} }));

async function load() {
  vi.resetModules();
  return import("./domHoles");
}

function layout() {
  document.body.innerHTML =
    '<div class="pane-gutter"></div><div data-native-drag></div>';
  const gutter = document.querySelector<HTMLElement>(".pane-gutter")!;
  gutter.getBoundingClientRect = () =>
    ({ x: 10, y: 0, width: 6, height: 100, left: 10, top: 0, right: 16, bottom: 100 }) as DOMRect;
  const drag = document.querySelector<HTMLElement>("[data-native-drag]")!;
  drag.getBoundingClientRect = () =>
    ({ x: 200, y: 20, width: 8, height: 80, left: 200, top: 20, right: 208, bottom: 100 }) as DOMRect;
}

describe("홀 보고는 그 장치를 건 프레임워크에서만 일어난다", () => {
  beforeEach(() => {
    invoke.mockClear();
    layout();
  });

  it("걸었으면 보고한다", async () => {
    const m = await load();
    m.__resetDomHolesForTest();
    m.installDomHoles();
    m.reportDomHoles();
    expect(invoke).toHaveBeenCalledWith("webview_dom_holes", expect.anything());
  });

  it("안 걸었으면 아예 묻지 않는다 — 부르는 쪽은 누가 걸었는지 몰라도 된다", async () => {
    const m = await load();
    m.__resetDomHolesForTest();
    m.reportDomHoles();
    expect(invoke).not.toHaveBeenCalled();
  });

  // 오라클 생존 — 수집이 0건이면 위 두 단언이 같은 이유로 통과한다("0 의 두 얼굴").
  it("수집이 실제로 사각형을 찾는다", async () => {
    const m = await load();
    expect(m.collectHoles(document)).toEqual([
      { x: 10, y: 0, w: 6, h: 100 },
      { x: 200, y: 20, w: 8, h: 80 },
    ]);
  });

  it("공개 상태는 DOM 드래그 선언의 종류와 실제 네이티브 홀의 일대일 정합을 판정한다", async () => {
    const m = await load();
    expect(m.collectHoleFacts(document)).toEqual([
      { kind: "pane-gutter", node: null, rect: { x: 10, y: 0, w: 6, h: 100 } },
      { kind: "native-drag", node: null, rect: { x: 200, y: 20, w: 8, h: 80 } },
    ]);

    expect(
      m.compareHoles(
        m.collectHoleFacts(document),
        [
          { x: 10, y: 0, w: 6, h: 100 },
          { x: 200, y: 20, w: 8, h: 80 },
        ],
      ),
    ).toEqual({ missingNative: [], staleNative: [], matched: 2 });
  });

  it("DOM에만 있는 드래그바와 네이티브에만 남은 홀을 각각 감추지 않는다", async () => {
    const m = await load();
    const verdict = m.compareHoles(
      [{ kind: "pane-gutter", node: "layout/gutter/g1", rect: { x: 10, y: 0, w: 6, h: 100 } }],
      [{ x: 30, y: 0, w: 6, h: 100 }],
    );
    expect(verdict.missingNative).toHaveLength(1);
    expect(verdict.staleNative).toHaveLength(1);
    expect(verdict.matched).toBe(0);
  });
});
