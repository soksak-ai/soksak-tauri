// B12 증거 봉투의 정본 표본 — 판정이 GREEN 이라고 부르는 한 벌의 수치.
//
// 이 표본은 두 자리에서 쓰인다: B12 judge 의 RED/GREEN 을 고정하는 짝 테스트와, 그 판정이 정본
// 36칸 보고서까지 실려 가는지 보는 기여·병합 테스트. 두 자리가 각자 표본을 들면 한쪽만 고쳐지고
// 나머지는 옛 계약 위에서 통과한다 — 같은 사실이므로 한 자리에 둔다.
//
// 지어낸 값이 아니다: 모양과 필드는 scripts/e2e/titlebar-composition.mjs 가 실앱에서 옮겨 적는
// 봉투 그대로다. 표본을 고칠 일이 생기면 하니스가 무엇을 싣는지부터 보고 여기를 맞춘다.

import { hostileWindowResizeSizes } from "./browser-matrix.mjs";

export const B12_ROLES = Object.freeze(["close", "minimize", "zoom"]);
export const B12_PRESENTED_COMPOSITION = 9;

const SCALE_FACTOR = 2;
const NODE_IDENTITY = "dom-titlebar-instance-1";
const OWNER_IDENTITY = "main#1";
const BASELINE_OUTER = Object.freeze({ w: 2_400, h: 1_600 });
const BASELINE_VIEWPORT = Object.freeze({ w: 2_360, h: 1_560 });

/** 한 실행의 신원. 판정은 이 중 framework 만 읽지만 보고서는 네 축을 모두 든다. */
export function b12Identity(framework) {
  return {
    framework,
    platform: "darwin",
    buildId: `b12-${framework}-build`,
    runId: `b12-${framework}-run`,
    // 능력은 프레임워크의 사실이다 — 픽스처가 임의로 정하면 실제와 갈린다.
    // src/framework/<name>/index.ts 의 engineProvision.nativeChildWebview 를 따른다.
    nativeChildWebview: framework === "tauri",
  };
}

function rectsFor(heightCssPx, viewportWidth = BASELINE_VIEWPORT.w) {
  const titlebarHeight = heightCssPx * SCALE_FACTOR;
  const buttonSize = 28;
  const y = (titlebarHeight - buttonSize) / 2;
  return {
    titlebar: { x: 0, y: 0, w: viewportWidth, h: titlebarHeight },
    elements: B12_ROLES.map((role, index) => ({
      role,
      rect: { x: 24 + index * 40, y, w: buttonSize, h: buttonSize },
    })),
  };
}

/** 프레임워크가 스스로 밝힌 신호등 합성 능력 — 판정이 읽는 것은 이름이 아니라 이 선언이다. */
function provisionFor(framework) {
  if (framework === "tauri") {
    return {
      buttonPositions: { provided: true },
      backingPlane: { provided: true },
      paintOwner: { provided: true },
    };
  }
  return {
    buttonPositions: { provided: false, reason: "공개 신호등 위치 표면이 없다" },
    backingPlane: { provided: false, reason: "버튼 뒤에 뷰를 깔 자리가 없다" },
    paintOwner: { provided: false, reason: "네이티브 paint owner 원장이 없다" },
  };
}

function owner(framework, revision) {
  if (framework !== "tauri") return null;
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

function startupReceipt() {
  return {
    platform: "macos",
    generation: 1,
    headless: false,
    creationCommitted: true,
    rendererGreen: true,
    presentationInFlight: false,
    presented: true,
    composition: { kind: "macos-titlebar", nativeSequence: B12_PRESENTED_COMPOSITION },
  };
}

function sample({
  framework,
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
    dom: {
      nodeIdentity: NODE_IDENTITY,
      inlineStyle: { ...inlineStyle },
    },
    viewportPhysical: { ...viewportPhysical },
    titlebarPhysical: { ...rects.titlebar },
    reservations: structuredClone(rects.elements),
    buttons: structuredClone(rects.elements),
    backings: framework === "tauri" ? structuredClone(rects.elements) : null,
    owner: owner(framework, revision),
  };
}

function hostileResize(framework, baselineStyle) {
  const sizes = hostileWindowResizeSizes(BASELINE_OUTER);
  const transactions = sizes.map((requestedOuterPhysical, step) => {
    const viewportPhysical = {
      w: BASELINE_VIEWPORT.w + requestedOuterPhysical.w - BASELINE_OUTER.w,
      h: BASELINE_VIEWPORT.h + requestedOuterPhysical.h - BASELINE_OUTER.h,
    };
    const rects = rectsFor(45, viewportPhysical.w);
    return {
      step,
      // 정본 하니스와 같은 좁힘. 단계가 선언한 phase 는 B10 의 축이라 B12 봉투에 싣지 않는다.
      requestedOuterPhysical: { w: requestedOuterPhysical.w, h: requestedOuterPhysical.h },
      probeGeneration: 21 + step,
      titlebar: {
        presentationRevision: 14,
        viewportPhysical,
        titlebarPhysical: { ...rects.titlebar },
        reservations: structuredClone(rects.elements),
        buttons: structuredClone(rects.elements),
        backings: framework === "tauri" ? structuredClone(rects.elements) : null,
        owner: framework === "tauri" ? { identity: OWNER_IDENTITY, drawOwnerCount: 1 } : null,
      },
    };
  });
  const settledRestore = sample({
    framework,
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

/** 한 창·한 엔진의 완결된 B12 봉투. tauri 는 GREEN, 능력을 부재로 선언한 프레임워크는 RED 다. */
export function b12Evidence(engine = "browser", framework = "tauri") {
  const baselineStyle = { height: "", flexBasis: "" };
  const value = {
    engine,
    provision: provisionFor(framework),
    coordinateSpace: {
      logical: "css-px",
      physical: "device-px",
      scaleFactor: SCALE_FACTOR,
    },
    startup: startupReceipt(),
    cold: sample({
      framework,
      stage: "cold",
      revision: B12_PRESENTED_COMPOSITION,
      heightCssPx: 45,
      inlineStyle: baselineStyle,
    }),
    baseline: sample({
      framework,
      stage: "baseline",
      revision: 10,
      heightCssPx: 45,
      inlineStyle: baselineStyle,
    }),
    heights: [
      sample({
        framework,
        stage: "height",
        revision: 11,
        heightCssPx: 30,
        requestedHeightCssPx: 30,
        inlineStyle: { height: "30px", flexBasis: "30px" },
      }),
      sample({
        framework,
        stage: "height",
        revision: 12,
        heightCssPx: 60,
        requestedHeightCssPx: 60,
        inlineStyle: { height: "60px", flexBasis: "60px" },
      }),
      sample({
        framework,
        stage: "height",
        revision: 13,
        heightCssPx: 72,
        requestedHeightCssPx: 72,
        inlineStyle: { height: "72px", flexBasis: "72px" },
      }),
    ],
    reset: sample({
      framework,
      stage: "reset",
      revision: 14,
      heightCssPx: 45,
      inlineStyle: baselineStyle,
    }),
    hostileResize: hostileResize(framework, baselineStyle),
    final: sample({
      framework,
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

/** 봉투가 든 모든 정지 표본 — 단계별 판정을 한 축으로 훑을 때 쓴다. */
export function b12AllSamples(value) {
  return [
    value.cold,
    value.baseline,
    ...value.heights,
    value.reset,
    value.final,
    value.held.baseline,
    ...value.held.heights,
    value.held.reset,
    value.held.final,
  ];
}
