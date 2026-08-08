// **표면은 창 안에 있어야 한다.**
//
// 사고 2026-08-09: 콘텐츠 표면들이 창 밖으로 흩어져 화면 오른쪽에 겹쳐 떠 있었다. 사람이
// 스크린샷을 보고 "엉망" 이라고 말할 때까지 아무도 몰랐다 — `ui.verify` 는 그 순간에도
// `passed` 를 답했다. 그 판정은 DOM 만 보고 있었고, 창 밖으로 나간 것은 DOM 이 아니라
// **문서 밖 표면**이었다.
//
// 보이는 표면이 창 밖에 있으면 그것은 무조건 결함이다. 사람이 볼 수 없는 자리에 그려지고 있고,
// 그 사실은 어떤 DOM 검사로도 안 잡힌다. 기하는 기하로 판정한다.
import { describe, expect, it } from "vitest";
import { surfacesOutsideWindow, unknownSurfaces } from "./surfaceInsideWindow";

const surface = (label: string, x: number, y: number, w = 100, h = 100, hidden = false) =>
  ({ label, hidden, effectivelyHidden: hidden, frame: { x, y, w, h } });

const window = { w: 1000, h: 800 };

describe("표면은 창 안에 있다", () => {
  it("창 안의 표면은 아무것도 답하지 않는다", () => {
    expect(surfacesOutsideWindow([surface("a", 0, 0), surface("b", 900, 700)], window)).toEqual([]);
  });

  it("창 밖으로 나간 표면을 이름과 얼마나 나갔는지로 답한다", () => {
    const out = surfacesOutsideWindow([surface("a", 1200, 100)], window);
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toBe("a");
    expect(out[0]!.overflow).toEqual({ right: 300, bottom: 0, left: 0, top: 0 });
  });

  it("음수 자리도 나간 것이다", () => {
    expect(surfacesOutsideWindow([surface("a", -40, -10)], window)[0]!.overflow)
      .toEqual({ left: 40, top: 10, right: 0, bottom: 0 });
  });

  // 숨은 표면은 사람이 못 본다 — 자리가 어디든 화면의 사실이 아니다.
  it("숨은 표면은 세지 않는다", () => {
    expect(surfacesOutsideWindow([surface("a", 5000, 5000, 100, 100, true)], window)).toEqual([]);
  });

  // 창 크기를 모르면 판정할 수 없다 — 0 으로 두면 모든 표면이 밖으로 읽힌다.
  it("창 크기가 없으면 판정하지 않는다", () => {
    expect(surfacesOutsideWindow([surface("a", 1200, 100)], { w: 0, h: 0 })).toEqual([]);
  });

  // 한 픽셀 걸침은 반올림 오차다 — 진짜 사고는 수백 px 로 나타났다.
  it("1px 걸침은 결함으로 세지 않는다", () => {
    expect(surfacesOutsideWindow([surface("a", 901, 0, 100, 100)], window)).toEqual([]);
  });
});

// **앱이 모르는 표면이 화면에 있다.**
//
// 실측 2026-08-09: 탭을 닫았는데 그 탭의 네이티브 표면이 계속 보이고 있었다. 앱의 유령 판정은
// `ghosts: []` 를 답했다 — 그 판정은 **자기 장부**를 훑는데, 이 표면은 이미 장부에서 빠지고
// 네이티브 층에만 남아 있었다. 장부에서 사라진 유령은 장부로 못 찾는다.
//
// 그러면 그 표면은 매 전환마다 확인 비용을 내고, 화면 어딘가를 덮은 채 아무도 그 존재를 모른다.
// 판정은 **네이티브가 든 목록**과 앱이 아는 이름을 맞대야 한다.
describe("앱이 모르는 표면", () => {
  it("네이티브에 있는데 앱이 모르는 표면을 이름으로 답한다", () => {
    expect(
      unknownSurfaces([surface("b-tab-gone", 0, 0), surface("b-tab-live", 0, 0)], new Set(["b-tab-live"])),
    ).toEqual(["b-tab-gone"]);
  });

  it("앱이 아는 것은 답하지 않는다", () => {
    expect(unknownSurfaces([surface("b-tab-live", 0, 0)], new Set(["b-tab-live"]))).toEqual([]);
  });

  // 숨은 표면은 화면의 사실이 아니다 — 아직 회수 전인 것과 지금 덮고 있는 것은 다르다.
  it("숨은 표면은 세지 않는다", () => {
    expect(unknownSurfaces([surface("b-tab-gone", 0, 0, 10, 10, true)], new Set())).toEqual([]);
  });
});
