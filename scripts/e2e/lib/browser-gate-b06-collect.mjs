// B06 focus-lighting 체크포인트 수집.
//
// judge 가 부르는 이름(lightingPlane·rail·sidebar)을 하니스가 그대로 실어야 게이트가 선다.
// 값은 전부 공개 표면에서 온다: ui.tree 가 data-node·dataset·rect 를 내고, ui.measure 가
// 계산된 스타일을 낸다. private DOM 조회도, 픽셀 밝기 추정도 하지 않는다.
//
// 덮임 판정 — 조명 평면은 space-body 전체를 덮으므로 rect 교차만 보면 레일은 언제나
// "덮였다"가 된다. 레일이 안 흐린 사실은 기하가 아니라 **선언된 층**이 소유한다
// (App.css: 레일 평면은 focus veil 보다 위). 그래서 덮임은 두 축의 곱이다:
// 겹치는가(기하) × 베일 위에 서는가(선언된 z). 둘 중 하나라도 못 읽으면 null 이다 —
// 못 읽음은 0 도 false 도 아니다.

import { must } from "./client.mjs";

const PLANE_RE = /^focus-lighting\/[^/]+$/;
const BASE_RE = /^focus-lighting\/[^/]+\/base$/;
const APERTURE_RE = /^focus-lighting\/[^/]+\/aperture\/.+$/;

/**
 * 조명 면제 표면 — 이름은 judge 가 정한다(rail·sidebar).
 *
 * layerNodePath 는 그 표면의 stacking 선언을 실제로 낸 공개 노드다. 레일 자신은 z 를
 * 선언하지 않고 레일 평면이 선언한다(assertRailCompositionContract 가 읽는 그 노드).
 */
export const B06_EXEMPT_SURFACES = Object.freeze([
  Object.freeze({ node: "rail", nodePath: "rail/left", layerNodePath: "rail/plane" }),
  Object.freeze({ node: "sidebar", nodePath: "sidebar/right", layerNodePath: "sidebar/right" }),
]);

function treeNodes(tree) {
  return Array.isArray(tree?.nodes) ? tree.nodes : [];
}

/** 공개 스타일 한 칸을 읽는다. 답이 없으면 undefined — 빈 문자열("선언 없음")과 다른 사실이다. */
function declaredValue(measure, prop) {
  const style = measure && typeof measure === "object" ? measure.style : null;
  if (!style || typeof style !== "object" || !Object.hasOwn(style, prop)) return undefined;
  const raw = style[prop];
  return typeof raw === "string" ? raw.trim() : undefined;
}

/**
 * 면제 표면의 흐림 세기.
 *
 * `--dim` 은 흐린 판만 선언하고 상속으로 내려간다. 면제 표면에 닿는 선언이 없다는 것은
 * "못 읽었다"가 아니라 "이 노드는 흐림을 받지 않는다"는 측정 결과다 → 0.
 * 읽기 자체가 답하지 않았거나 값이 숫자가 아니면 null 이다 — 실패를 0 으로 적지 않는다.
 */
export function resolveExemptDim(measure) {
  const raw = declaredValue(measure, "--dim");
  if (raw === undefined) return null;
  if (raw === "") return 0;
  const amount = Number.parseFloat(raw);
  return Number.isFinite(amount) ? amount : null;
}

/** 베일 농도. 선언이 없으면 null — 조명 평면에 "농도 없음"은 성립하지 않는다. */
export function resolveBaseAmount(measure) {
  const raw = declaredValue(measure, "fillOpacity");
  if (!raw) return null;
  const amount = Number.parseFloat(raw);
  return Number.isFinite(amount) ? amount : null;
}

/** 선언된 층. `auto` 는 층을 선언하지 않은 것이므로 숫자가 아니라 null 이다. */
export function resolveLayerZ(measure) {
  const raw = declaredValue(measure, "zIndex");
  if (!raw || raw === "auto") return null;
  const order = Number.parseInt(raw, 10);
  return Number.isFinite(order) ? order : null;
}

/** data-focus-lighting 선언. dataset 을 못 받았으면 null — 없음을 false 로 적지 않는다. */
export function resolveExempt(measure) {
  const dataset = measure && typeof measure === "object" ? measure.dataset : null;
  if (!dataset || typeof dataset !== "object") return null;
  return dataset.focusLighting === "exempt";
}

function finiteRect(rect) {
  if (!rect || typeof rect !== "object") return null;
  const { x, y, w, h } = rect;
  if (![x, y, w, h].every((value) => Number.isFinite(value))) return null;
  return { x, y, w, h };
}

/** 두 상자가 실제로 겹치는 넓이. 접점(0폭)은 겹침이 아니다. */
export function rectOverlapArea(a, b) {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  const width = right - left;
  const height = bottom - top;
  return width > 0 && height > 0 ? width * height : 0;
}

/** 베일이 이 표면의 픽셀에 닿는가 — 겹침(기하) × 층(선언). 못 읽은 축이 있으면 null. */
export function resolveCoveredByPlane({ planeRect, targetRect, planeZ, layerZ }) {
  const plane = finiteRect(planeRect);
  const target = finiteRect(targetRect);
  if (!plane || !target) return null;
  if (rectOverlapArea(plane, target) <= 0) return false;
  // 겹치는데 평면의 층을 못 읽으면 어느 쪽이 위인지 말할 수 없다.
  if (!Number.isFinite(planeZ)) return null;
  // 층을 선언하지 않은 표면은 베일을 이길 근거가 없다.
  if (!Number.isFinite(layerZ)) return true;
  return !(layerZ > planeZ);
}

/** nodePath 로 공개 주소 하나를 집는다. 없거나 둘 이상이면 null — 아무거나 고르지 않는다. */
export function addressForNodePath(nodes, nodePath) {
  const found = nodes.filter((node) =>
    node?.nodePath === nodePath && typeof node.address === "string");
  return found.length === 1 ? found[0].address : null;
}

/** 조명 평면 트리를 세 갈래로 가른다 — 평면, 베일, aperture. */
export function selectLightingNodes(nodes) {
  const planes = [];
  const bases = [];
  const apertures = [];
  for (const node of nodes) {
    const nodePath = typeof node?.nodePath === "string" ? node.nodePath : "";
    if (PLANE_RE.test(nodePath)) planes.push(node);
    else if (BASE_RE.test(nodePath)) bases.push(node);
    else if (APERTURE_RE.test(nodePath)) apertures.push(node);
  }
  return { planes, bases, apertures };
}

function apertureOwner(apertures) {
  if (apertures.length !== 1) return null;
  const owner = apertures[0]?.dataset?.lightingAperture;
  return typeof owner === "string" && owner !== "" ? owner : null;
}

async function measureNode(rpc, win, address, props, what) {
  if (!address) return null;
  return must(await rpc("ui.measure", { address, props }, win), what);
}

/**
 * 한 체크포인트를 공개 표면에서 읽어 mapper 가 소비하는 모양으로 낸다.
 *
 * 노드가 없거나 측정이 답하지 않으면 그 칸은 null 로 남고 judge 가 이름을 달아 RED 를 낸다.
 * 여기서 던지지 않는다 — 한 게이트의 결측이 나머지 게이트 측정을 끝내면 안 된다.
 */
export async function collectB06Checkpoint({
  rpc,
  win,
  phase,
  activePaneId,
  paneIds,
  lighting,
  stage = "B06",
}) {
  const tree = must(await rpc("ui.tree", { rects: true }, win), `${stage} lighting plane tree`);
  const nodes = treeNodes(tree);
  const { planes, bases, apertures } = selectLightingNodes(nodes);
  const planeNode = planes.length === 1 ? planes[0] : null;
  const baseNode = bases.length === 1 ? bases[0] : null;

  const [planeMeasure, baseMeasure] = await Promise.all([
    measureNode(rpc, win, planeNode?.address ?? null, ["zIndex"], `${stage} lighting plane layer`),
    measureNode(rpc, win, baseNode?.address ?? null, ["fillOpacity"], `${stage} lighting veil amount`),
  ]);
  const planeZ = resolveLayerZ(planeMeasure);
  // 베일 상자는 농도와 같은 읽기에서 온다 — 상자와 값을 다른 읽기에서 가져오면 두 시각의
  // 사실을 한 판정에 섞는다.
  const planeRect = baseMeasure?.rect ?? null;

  const exempt = {};
  for (const surface of B06_EXEMPT_SURFACES) {
    const targetAddress = addressForNodePath(nodes, surface.nodePath);
    const layerAddress = surface.layerNodePath === surface.nodePath
      ? targetAddress
      : addressForNodePath(nodes, surface.layerNodePath);
    const targetMeasure = await measureNode(
      rpc, win, targetAddress, ["--dim", "zIndex"], `${stage} ${surface.node} lighting exemption`,
    );
    const layerMeasure = layerAddress === targetAddress
      ? targetMeasure
      : await measureNode(rpc, win, layerAddress, ["zIndex"], `${stage} ${surface.node} layer`);
    exempt[surface.node] = {
      exempt: resolveExempt(targetMeasure),
      styleDim: resolveExemptDim(targetMeasure),
      coveredByPlane: resolveCoveredByPlane({
        planeRect,
        targetRect: targetMeasure?.rect ?? null,
        planeZ,
        layerZ: resolveLayerZ(layerMeasure),
      }),
    };
  }

  return {
    phase,
    activePaneId,
    paneIds,
    lighting,
    lightingPlane: {
      count: planes.length,
      baseAmount: resolveBaseAmount(baseMeasure),
      aperturePaneId: apertureOwner(apertures),
      apertureCount: apertures.length,
    },
    rail: exempt.rail,
    sidebar: exempt.sidebar,
  };
}
