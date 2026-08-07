// B06 focus-lighting 체크포인트 수집.
//
// judge 가 부르는 이름(lightingPlane·rail·sidebar)을 하니스가 그대로 실어야 게이트가 선다.
// 값은 전부 공개 표면에서 온다: ui.tree 가 data-node·dataset·rect 를 내고, ui.snapshot.dom 이
// 한 순간의 가시성을, ui.measure 가 계산된 스타일과 칠하는 순서 사슬을 낸다. private DOM
// 조회도, 픽셀 밝기 추정도 하지 않는다.
//
// ── 단일 평면의 뜻 ──────────────────────────────────────────────────────────
// 조명 평면은 공간(space)마다 한 벌 있고, 창 하나가 공간을 여럿 들 수 있다. 비활성 공간은
// 언마운트되지 않고 숨김으로만 파킹된다 — DOM 에는 남지만 픽셀은 한 점도 칠하지 않는다.
// B06 이 지키는 사실은 "화면의 픽셀을 정확히 한 평면이 가라앉힌다"이므로 **세는 대상은
// 화면에 선 평면**이다. 파킹된 평면은 세지 않되 장부에는 남긴다(parked) — 안 세는 것과 없는
// 것은 다른 사실이다. 가시성을 못 읽은 평면은 셋 중 어느 쪽도 아니다(unreadable) — 못 읽음을
// 파킹으로 적으면 두 번째 평면이 조용히 숨는다.
//
// ── 덮임 판정 ──────────────────────────────────────────────────────────────
// 조명 평면은 space-body 전체를 덮으므로 rect 교차만 보면 레일은 언제나 "덮였다"가 된다.
// 레일이 안 흐린 사실은 기하가 아니라 **칠하는 순서**가 소유한다. 그 순서는 z 두 개의 뺄셈이
// 아니다: 레일 평면(7)과 베일(6) 사이에는 .space-plane(1)이 자기 stacking context 를 만들어
// 베일을 가둔다 — 레일이 위인 진짜 이유는 7>6 이 아니라 7>1 이다. 그래서 덮임은 두 축의 곱이다:
// 겹치는가(기하) × 사슬에서 누가 위인가(공개 stacking path). 둘 중 하나라도 못 읽으면 null 이다.

import { must } from "./client.mjs";
import { comparePaintOrder, stackingPathOf } from "./browser-gate-b06-stacking.mjs";

const PLANE_RE = /^focus-lighting\/([^/]+)$/;
const LIGHTING_ADDRESS_FILTER = "/focus-lighting/";

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

/** data-focus-lighting 선언. dataset 을 못 받았으면 null — 없음을 false 로 적지 않는다. */
export function resolveExempt(measure) {
  const dataset = measure && typeof measure === "object" ? measure.dataset : null;
  if (!dataset || typeof dataset !== "object") return null;
  return dataset.focusLighting === "exempt";
}

/** 화면에 서 있는가. 못 읽었으면 null — 못 읽음을 파킹으로 적지 않는다. */
export function resolvePresented(style) {
  if (!style || typeof style !== "object") return null;
  const visibility = typeof style.visibility === "string" ? style.visibility.trim() : "";
  const display = typeof style.display === "string" ? style.display.trim() : "";
  if (visibility === "" || display === "") return null;
  return visibility !== "hidden" && visibility !== "collapse" && display !== "none";
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

/** 베일이 이 표면의 픽셀에 닿는가 — 겹침(기하) × 사슬(칠하는 순서). 못 읽은 축이 있으면 null. */
export function resolveCoveredByPlane({ planeRect, targetRect, veilStack, targetStack }) {
  const plane = finiteRect(planeRect);
  const target = finiteRect(targetRect);
  if (!plane || !target) return null;
  if (rectOverlapArea(plane, target) <= 0) return false;
  const order = comparePaintOrder(targetStack, veilStack);
  if (order === null) return null;
  return !(order > 0);
}

/** nodePath 로 공개 주소 하나를 집는다. 없거나 둘 이상이면 null — 아무거나 고르지 않는다. */
export function addressForNodePath(nodes, nodePath) {
  const found = nodes.filter((node) =>
    node?.nodePath === nodePath && typeof node.address === "string");
  return found.length === 1 ? found[0].address : null;
}

/** 조명 평면 노드들을 공간별로 가른다 — 한 공간이 두 평면을 들면 여기서 드러난다. */
export function selectLightingPlanes(nodes) {
  const planes = [];
  for (const node of nodes) {
    const nodePath = typeof node?.nodePath === "string" ? node.nodePath : "";
    const scope = PLANE_RE.exec(nodePath)?.[1];
    if (scope) planes.push({ scope, node });
  }
  return planes;
}

function apertureOwner(apertures) {
  if (apertures.length !== 1) return null;
  const owner = apertures[0]?.dataset?.lightingAperture;
  return typeof owner === "string" && owner !== "" ? owner : null;
}

async function measureNode(rpc, win, address, params, what) {
  if (!address) return null;
  return must(await rpc("ui.measure", { address, ...params }, win), what);
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
  const planes = selectLightingPlanes(nodes);

  // 가시성은 한 순간에 한꺼번에 읽는다 — 평면마다 왕복하면 서로 다른 순간의 사실을 센다.
  const presence = must(await rpc("ui.snapshot.dom", {
    filter: LIGHTING_ADDRESS_FILTER,
    props: ["visibility", "display"],
  }, win), `${stage} lighting plane presence`);
  const byAddress = new Map(
    (Array.isArray(presence?.nodes) ? presence.nodes : [])
      .filter((node) => typeof node?.address === "string")
      .map((node) => [node.address, node.style]),
  );

  let presented = 0;
  let parked = 0;
  let unreadable = 0;
  const presentedScopes = [];
  for (const plane of planes) {
    const state = resolvePresented(byAddress.get(plane.node.address));
    if (state === null) unreadable += 1;
    else if (state) {
      presented += 1;
      presentedScopes.push(plane.scope);
    } else parked += 1;
  }

  // 화면에 선 평면이 정확히 하나일 때만 그 공간의 베일·aperture 를 읽는다. 둘이면 어느 것이
  // 답인지 말할 수 없고, 아무거나 고르면 판정이 우연을 탄다.
  const scope = presentedScopes.length === 1 ? presentedScopes[0] : null;
  const baseAddress = scope === null
    ? null
    : addressForNodePath(nodes, `focus-lighting/${scope}/base`);
  const aperturePrefix = scope === null ? null : `focus-lighting/${scope}/aperture/`;
  const apertures = aperturePrefix === null
    ? []
    : nodes.filter((node) =>
      typeof node?.nodePath === "string" && node.nodePath.startsWith(aperturePrefix));

  // 베일 상자·농도·사슬은 같은 읽기에서 온다 — 나눠 가져오면 서로 다른 시각의 사실을 한
  // 판정에 섞는다.
  const baseMeasure = await measureNode(
    rpc, win, baseAddress, { props: ["fillOpacity"], stacking: true }, `${stage} lighting veil`,
  );
  const veilStack = stackingPathOf(baseMeasure);
  const planeRect = baseMeasure?.rect ?? null;

  const exempt = {};
  for (const surface of B06_EXEMPT_SURFACES) {
    const targetAddress = addressForNodePath(nodes, surface.nodePath);
    const layerAddress = surface.layerNodePath === surface.nodePath
      ? targetAddress
      : addressForNodePath(nodes, surface.layerNodePath);
    const targetMeasure = await measureNode(
      rpc,
      win,
      targetAddress,
      { props: ["--dim"], stacking: layerAddress === targetAddress },
      `${stage} ${surface.node} lighting exemption`,
    );
    const layerMeasure = layerAddress === targetAddress
      ? targetMeasure
      : await measureNode(rpc, win, layerAddress, { stacking: true }, `${stage} ${surface.node} layer`);
    exempt[surface.node] = {
      exempt: resolveExempt(targetMeasure),
      styleDim: resolveExemptDim(targetMeasure),
      coveredByPlane: resolveCoveredByPlane({
        planeRect,
        targetRect: targetMeasure?.rect ?? null,
        veilStack,
        targetStack: stackingPathOf(layerMeasure),
      }),
    };
  }

  return {
    phase,
    activePaneId,
    paneIds,
    lighting,
    lightingPlane: {
      presented,
      parked,
      unreadable,
      baseAmount: resolveBaseAmount(baseMeasure),
      aperturePaneId: apertureOwner(apertures),
      apertureCount: apertures.length,
    },
    rail: exempt.rail,
    sidebar: exempt.sidebar,
  };
}
