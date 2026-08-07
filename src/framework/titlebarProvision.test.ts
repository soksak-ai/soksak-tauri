// @vitest-environment node
// 신호등(창 제어 버튼) 합성은 **이름이 아니라 선언**으로 갈린다.
//
// 판정이 `framework === "electron"` 을 보면 그 줄은 능력이 아니라 이름을 읽는다. 이름을 읽는
// 판정은 세 번째 프레임워크가 오는 날 조용히 틀리고, 능력이 생긴 날에도 여전히 거절한다.
// 그래서 각 프레임워크가 이 축에 대해 자기가 무엇을 답할 수 있는지 **스스로 밝히고**, 없는
// 것은 사유를 달아 부재로 답한다 — 부재도 답이다.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { titlebarComposition as tauri } from "./tauri";
import { titlebarComposition as electron } from "./electron";
import { selectedFramework as neutral } from "./selected.neutral";
import {
  TITLEBAR_COMPOSITION_FACETS,
  clearTitlebarProvisionBreaches,
  recordTitlebarProvisionBreach,
  titlebarProvisionBreaches,
} from "./titlebarProvision";

const requireCjs = createRequire(import.meta.url);
/** 같은 사실의 다른 자리 — 메인 프로세스의 명령표가 거절하는 사유. */
const electronNativeTitlebarTable = requireCjs(
  "../../frameworks/electron/native/titlebar.cjs",
) as Record<string, { concept: string; absent?: string }>;

describe("프레임워크가 신호등 합성 능력을 스스로 밝힌다", () => {
  it("두 제품 어댑터와 중립 어댑터가 같은 축 전부를 선언한다", () => {
    expect([...TITLEBAR_COMPOSITION_FACETS]).toEqual([
      "buttonPositions",
      "backingPlane",
      "paintOwner",
    ]);
    for (const provision of [tauri, electron, neutral.titlebarComposition]) {
      expect(Object.keys(provision).sort()).toEqual([...TITLEBAR_COMPOSITION_FACETS].sort());
    }
  });

  it("Tauri 는 세 축을 다 제공한다 — 위치·백킹·paint owner", () => {
    for (const facet of TITLEBAR_COMPOSITION_FACETS) {
      expect(tauri[facet]).toEqual({ provided: true });
    }
  });

  it("Electron 은 세 축 전부를 사유와 함께 부재로 답한다", () => {
    for (const facet of TITLEBAR_COMPOSITION_FACETS) {
      const declared = electron[facet];
      expect(declared.provided).toBe(false);
      expect(declared.provided === false && declared.reason.trim()).toBeTruthy();
    }
  });

  // 사유는 한 자리에 산다. 렌더러의 계약 선언과 메인 프로세스의 명령표가 각자 문장을 들면
  // 한쪽만 고쳐지고, 그 어긋남은 "선언은 없다는데 표는 다른 말을 한다"로만 나타난다.
  it("Electron 의 백킹 부재 사유가 메인 프로세스 명령표의 사유와 같은 문장이다", () => {
    const table = electronNativeTitlebarTable.titlebar_backing;
    expect(table.absent).toBeTruthy();
    expect(electron.backingPlane).toEqual({ provided: false, reason: table.absent });
  });

  // 두 답이 같으면 이 축은 아무것도 가르지 않는다("0 의 두 얼굴").
  it("두 프레임워크의 답이 실제로 갈린다", () => {
    expect(tauri).not.toEqual(electron);
  });
});

describe("선언과 행동이 갈린 자리는 삼키지 않는다", () => {
  it("있다고 적어 두고 거절당한 호출을 이름으로 남긴다", () => {
    clearTitlebarProvisionBreaches();
    expect(titlebarProvisionBreaches()).toEqual([]);
    recordTitlebarProvisionBreach("backingPlane", "titlebar_backing", new Error("no such command"));
    expect(titlebarProvisionBreaches()).toEqual([
      { facet: "backingPlane", command: "titlebar_backing", error: "no such command" },
    ]);
    clearTitlebarProvisionBreaches();
    expect(titlebarProvisionBreaches()).toEqual([]);
  });

  it("같은 거절이 반복돼도 장부가 무한히 자라지 않는다 — 사실은 하나다", () => {
    clearTitlebarProvisionBreaches();
    for (let i = 0; i < 5; i += 1) {
      recordTitlebarProvisionBreach("backingPlane", "titlebar_backing", new Error("no such command"));
    }
    expect(titlebarProvisionBreaches()).toHaveLength(1);
    clearTitlebarProvisionBreaches();
  });
});
