// @vitest-environment node
// B12 는 프레임워크 **이름**이 아니라 프레임워크가 낸 **선언**을 읽는다.
//
// 예전 자리: judge 가 `framework === "electron"` 이면 무조건 red 를 넣었다(9곳). 그 줄은 능력이
// 아니라 이름을 읽는다 — 능력이 생긴 날에도 계속 거절하고, 세 번째 프레임워크가 오는 날에는
// 아무 말도 못 한다. 그리고 그 red 의 이름이 'electron' 이라, 무엇이 없어서 못 쟀는지가
// 보고서 어디에도 안 남았다.
//
// 기준은 그대로다: 답할 수 없으면 RED 다. 바뀌는 것은 **그 RED 의 이름**뿐이다.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { judgeB12MachineEvidence } from "./browser-gate-b12.mjs";
import { hostileWindowResizeSizes } from "./browser-matrix.mjs";

const ROLES = Object.freeze(["close", "minimize", "zoom"]);
const SCALE_FACTOR = 2;
const NODE_IDENTITY = "dom-titlebar-instance-1";
const OWNER_IDENTITY = "main#1";
const PRESENTED_COMPOSITION = 9;
const BASELINE_OUTER = Object.freeze({ w: 2_400, h: 1_600 });
const BASELINE_VIEWPORT = Object.freeze({ w: 2_360, h: 1_560 });

const provided = Object.freeze({ provided: true });
const absent = (reason) => ({ provided: false, reason });

const ALL_PROVIDED = Object.freeze({
  buttonPositions: provided,
  backingPlane: provided,
  paintOwner: provided,
});

const identity = (framework) => ({
  framework,
  platform: "darwin",
  buildId: `b12-${framework}-build`,
  runId: `b12-${framework}-run`,
});

function rectsFor(heightCssPx, viewportWidth = BASELINE_VIEWPORT.w) {
  const titlebarHeight = heightCssPx * SCALE_FACTOR;
  const buttonSize = 28;
  const y = (titlebarHeight - buttonSize) / 2;
  return {
    titlebar: { x: 0, y: 0, w: viewportWidth, h: titlebarHeight },
    elements: ROLES.map((role, index) => ({
      role,
      rect: { x: 24 + index * 40, y, w: buttonSize, h: buttonSize },
    })),
  };
}

function owner(provision, revision) {
  if (!provision.paintOwner.provided) return null;
  return {
    identity: OWNER_IDENTITY,
    drawOwnerCount: 1,
    targetSequence: revision,
    appliedTargetSequence: revision,
    mutationSequence: revision,
    drawSequence: revision,
    applying: false,
    lastApplyOk: true,
    lastApplyError: null,
  };
}

function sample(provision, {
  stage,
  revision,
  heightCssPx,
  requestedHeightCssPx = null,
  inlineStyle,
  viewportPhysical = BASELINE_VIEWPORT,
}) {
  const rects = rectsFor(heightCssPx, viewportPhysical.w);
  return {
    stage,
    presentationRevision: revision,
    presented: true,
    requestedHeightCssPx,
    dom: { nodeIdentity: NODE_IDENTITY, inlineStyle: { ...inlineStyle } },
    viewportPhysical: { ...viewportPhysical },
    titlebarPhysical: { ...rects.titlebar },
    reservations: structuredClone(rects.elements),
    buttons: structuredClone(rects.elements),
    backings: provision.backingPlane.provided ? structuredClone(rects.elements) : null,
    owner: owner(provision, revision),
  };
}

function hostileResize(provision, baselineStyle) {
  const transactions = hostileWindowResizeSizes(BASELINE_OUTER).map((requestedOuterPhysical, step) => {
    const viewportPhysical = {
      w: BASELINE_VIEWPORT.w + requestedOuterPhysical.w - BASELINE_OUTER.w,
      h: BASELINE_VIEWPORT.h + requestedOuterPhysical.h - BASELINE_OUTER.h,
    };
    const rects = rectsFor(45, viewportPhysical.w);
    return {
      step,
      requestedOuterPhysical: { ...requestedOuterPhysical },
      probeGeneration: 21 + step,
      titlebar: {
        presentationRevision: 14,
        viewportPhysical,
        titlebarPhysical: { ...rects.titlebar },
        reservations: structuredClone(rects.elements),
        buttons: structuredClone(rects.elements),
        backings: provision.backingPlane.provided ? structuredClone(rects.elements) : null,
        owner: provision.paintOwner.provided
          ? { identity: OWNER_IDENTITY, drawOwnerCount: 1 }
          : null,
      },
    };
  });
  const settledRestore = sample(provision, {
    stage: "resize-restored",
    revision: 14,
    heightCssPx: 45,
    inlineStyle: baselineStyle,
  });
  return {
    baselineOuterPhysical: { ...BASELINE_OUTER },
    transactions,
    restoredOuterPhysical: { ...BASELINE_OUTER },
    settledRestore,
    heldOuterPhysical: { ...BASELINE_OUTER },
    heldRestore: structuredClone(settledRestore),
  };
}

/** 선언 그대로의 완전한 증거 한 벌. 선언이 없다고 한 평면은 값도 비어 있다. */
function evidence(provision = ALL_PROVIDED, engine = "browser") {
  const baselineStyle = { height: "", flexBasis: "" };
  const value = {
    engine,
    provision: structuredClone(provision),
    coordinateSpace: { logical: "css-px", physical: "device-px", scaleFactor: SCALE_FACTOR },
    startup: {
      platform: "macos",
      generation: 1,
      headless: false,
      creationCommitted: true,
      rendererGreen: true,
      presentationInFlight: false,
      presented: true,
      composition: { kind: "macos-titlebar", nativeSequence: PRESENTED_COMPOSITION },
    },
    cold: sample(provision, {
      stage: "cold",
      revision: PRESENTED_COMPOSITION,
      heightCssPx: 45,
      inlineStyle: baselineStyle,
    }),
    baseline: sample(provision, {
      stage: "baseline",
      revision: 10,
      heightCssPx: 45,
      inlineStyle: baselineStyle,
    }),
    heights: [30, 60, 72].map((height, index) => sample(provision, {
      stage: "height",
      revision: 11 + index,
      heightCssPx: height,
      requestedHeightCssPx: height,
      inlineStyle: { height: `${height}px`, flexBasis: `${height}px` },
    })),
    reset: sample(provision, {
      stage: "reset",
      revision: 14,
      heightCssPx: 45,
      inlineStyle: baselineStyle,
    }),
    hostileResize: hostileResize(provision, baselineStyle),
    final: sample(provision, {
      stage: "final",
      revision: 14,
      heightCssPx: 45,
      inlineStyle: baselineStyle,
    }),
  };
  value.held = {
    baseline: structuredClone(value.baseline),
    heights: structuredClone(value.heights),
    reset: structuredClone(value.reset),
    final: structuredClone(value.final),
  };
  return value;
}

/** 능력을 못 채운 프레임워크가 낼 수 있는 것 — 선언 하나. 나머지 칸은 잰 적이 없다. */
function declarationOnlyEvidence(provision, engine = "browser") {
  return {
    engine,
    provision: structuredClone(provision),
    coordinateSpace: null,
    startup: null,
    cold: null,
    baseline: null,
    heights: null,
    reset: null,
    hostileResize: null,
    final: null,
    held: null,
  };
}

describe("B12 는 선언을 읽는다 — 이름이 아니라", () => {
  // 값 대조만으로는 "지금 이름을 안 본다"까지고, 한 줄이 다시 들어오는 것을 못 막는다.
  // 이름과의 비교 자체를 소스에서 금지한다. 귀속(FRAMEWORKS.has)은 판정이 아니라 이름표다.
  it("judge 소스에 프레임워크 이름 비교가 없다", () => {
    const source = readFileSync(new URL("./browser-gate-b12.mjs", import.meta.url), "utf8");
    expect(source).not.toMatch(/framework\s*(===|!==|==|!=)\s*["'](tauri|electron)["']/);
    expect(source).not.toMatch(/["'](tauri|electron)["']\s*(===|!==|==|!=)\s*framework/);
    expect(source).toContain("inspectProvision");
  });

  it("Electron 이라는 이름으로도 선언한 능력을 다 채우면 GREEN 이다", () => {
    const verdict = judgeB12MachineEvidence(evidence(), identity("electron"));
    expect(verdict).toMatchObject({ status: "green", reason: null });
  });

  it("Tauri 라는 이름으로도 위치 축을 부재로 선언하면 RED 다", () => {
    const value = evidence({ ...ALL_PROVIDED, buttonPositions: absent("no public button rect") });
    const verdict = judgeB12MachineEvidence(value, identity("tauri"));
    expect(verdict.status).toBe("red");
    expect(verdict.evidence.some((e) => e.includes("provision.buttonPositions"))).toBe(true);
  });

  // 이름 무관을 직접 잰다: 같은 증거를 다른 이름으로 판정해도 실패 목록이 **한 글자도** 달라지지
  // 않아야 한다. 한 곳이라도 이름을 보면 이 대조가 갈린다.
  it("같은 증거는 어느 이름으로 판정해도 같은 실패 목록을 낸다", () => {
    const declarations = [
      ALL_PROVIDED,
      { ...ALL_PROVIDED, buttonPositions: absent("공개 위치 표면이 없다") },
      { ...ALL_PROVIDED, backingPlane: absent("깔 자리가 없다") },
      { ...ALL_PROVIDED, paintOwner: absent("원장이 없다") },
    ];
    for (const provision of declarations) {
      for (const value of [evidence(provision), declarationOnlyEvidence(provision)]) {
        const asTauri = judgeB12MachineEvidence(structuredClone(value), identity("tauri"));
        const asElectron = judgeB12MachineEvidence(structuredClone(value), identity("electron"));
        expect(asElectron.status).toBe(asTauri.status);
        expect(asElectron.evidence.map((e) => e.replace(/B12:(tauri|electron);/, "B12;")))
          .toEqual(asTauri.evidence.map((e) => e.replace(/B12:(tauri|electron);/, "B12;")));
      }
    }
  });

  it("RED 의 이름이 없는 능력을 가리키고 그 프레임워크가 적은 사유를 싣는다", () => {
    const reason = "이 프레임워크의 신호등 API 는 위치·가시성뿐이다";
    const value = declarationOnlyEvidence({
      buttonPositions: absent(reason),
      backingPlane: absent("버튼 뒤에 뷰를 깔 자리가 없다"),
      paintOwner: absent("네이티브 paint owner 원장이 없다"),
    });
    const verdict = judgeB12MachineEvidence(value, identity("electron"));
    expect(verdict.status).toBe("red");
    const named = verdict.evidence.filter((e) => e.includes("provision.buttonPositions"));
    expect(named).toHaveLength(1);
    expect(named[0]).toContain("declared-absent");
    expect(named[0]).toContain(reason);
  });
});

describe("선언은 값과 맞아야 한다", () => {
  it("선언 자체가 없으면 RED 다 — 안 밝힌 것은 모르는 것이다", () => {
    const value = evidence();
    delete value.provision;
    expect(judgeB12MachineEvidence(value, identity("tauri")).status).toBe("red");
  });

  it("망가진 선언은 예외 없이 RED 다", () => {
    const malformed = [
      null,
      17,
      {},
      { buttonPositions: provided, backingPlane: provided },
      { ...ALL_PROVIDED, paintOwner: { provided: false } },
      { ...ALL_PROVIDED, paintOwner: { provided: false, reason: "  " } },
      { ...ALL_PROVIDED, paintOwner: { provided: true, reason: "제공하는데 사유가 있다" } },
      { ...ALL_PROVIDED, paintOwner: { provided: "yes" } },
      { ...ALL_PROVIDED, trafficLights: provided },
    ];
    for (const provision of malformed) {
      const value = evidence();
      value.provision = provision;
      expect(() => judgeB12MachineEvidence(value, identity("tauri"))).not.toThrow();
      expect(judgeB12MachineEvidence(value, identity("tauri")).status).toBe("red");
    }
  });

  it("없다고 선언한 평면을 값으로 채우면 RED 다 — 지어낸 rect 는 증거가 아니다", () => {
    const withoutBacking = { ...ALL_PROVIDED, backingPlane: absent("깔 자리가 없다") };
    expect(judgeB12MachineEvidence(evidence(withoutBacking), identity("electron")).status)
      .toBe("green");
    const fabricated = evidence(withoutBacking);
    fabricated.baseline.backings = structuredClone(fabricated.baseline.buttons);
    expect(judgeB12MachineEvidence(fabricated, identity("electron")).status).toBe("red");

    const withoutOwner = { ...ALL_PROVIDED, paintOwner: absent("원장이 없다") };
    expect(judgeB12MachineEvidence(evidence(withoutOwner), identity("electron")).status)
      .toBe("green");
    const fabricatedOwner = evidence(withoutOwner);
    fabricatedOwner.baseline.owner = {
      identity: OWNER_IDENTITY,
      drawOwnerCount: 1,
      targetSequence: 10,
      appliedTargetSequence: 10,
      mutationSequence: 10,
      drawSequence: 10,
      applying: false,
      lastApplyOk: true,
      lastApplyError: null,
    };
    expect(judgeB12MachineEvidence(fabricatedOwner, identity("electron")).status).toBe("red");
  });

  it("있다고 선언한 평면이 비면 RED 다 — 선언만으로는 아무것도 증명하지 않는다", () => {
    const missingBacking = evidence();
    missingBacking.baseline.backings = null;
    expect(judgeB12MachineEvidence(missingBacking, identity("tauri")).status).toBe("red");

    const missingOwner = evidence();
    missingOwner.baseline.owner = null;
    expect(judgeB12MachineEvidence(missingOwner, identity("tauri")).status).toBe("red");
  });

  // 기준을 낮추지 않는다: 위치 축을 제공한다고 선언한 이상 나머지 계약은 그대로 다 걸린다.
  it("위치를 제공한다고 선언하면 냉시작 영수증까지 같은 기준으로 받는다", () => {
    const cases = [
      (value) => { value.startup.platform = "other"; },
      (value) => { value.startup.composition.kind = "dom"; },
      (value) => { value.startup.presented = false; },
      (value) => { value.heights[1].buttons[0].rect.y += 1; },
      (value) => { value.final.dom.nodeIdentity = "remounted-final"; },
    ];
    for (const mutate of cases) {
      const value = evidence();
      mutate(value);
      expect(judgeB12MachineEvidence(value, identity("electron")).status).toBe("red");
    }
  });
});
