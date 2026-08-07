import { decodePng } from "./png.mjs";
import { sameRect } from "../../../packages/dom-webview-compositor/src/index.ts";
import { B04_JOURNAL_ENTRY_KEYS } from "./browser-gates.mjs";
export { layoutTransactionVerdict } from "./layout-transaction-verdict.mjs";

/**
 * 프레임워크의 표시 원장 — **이름은 코어 계약이다**(src/framework/presentationLedger.ts).
 *
 * 한때 이 자리는 한 프레임워크의 이름 공간(webview.pane.*)을 불렀고, 그래서 다른 프레임워크
 * 에서는 B04·B05 가 한 칸도 측정되지 않았다. 부재가 결함으로 안 보이고 "원래 없는 게이트"로
 * 보이는 것이 그 값이다. 하니스는 어느 어댑터가 답하는지 묻지 않는다.
 */
const FRAMEWORK_PRESENTATION_TRACE = Object.freeze({
  ownerCommand: "view.presentation.owners",
  ownerParams: () => ({}),
  armCommand: "view.presentation.trace.arm",
  readCommand: "view.presentation.trace.close",
  resolveOwners({ facts, windowLabel, viewIds, paneIds, surfaceIds }) {
    return viewIds.map((viewId, index) => {
      const surfaceId = surfaceIds[index];
      const candidates = (facts?.owners ?? []).filter((owner) =>
        owner?.window === windowLabel
        && owner?.logicalPaneId === paneIds[index]
        && owner?.viewId === viewId
        && owner?.surfaceId === surfaceId);
      if (candidates.length !== 1) {
        throw new Error(
          `${viewId}: presentation owner=${candidates.length}/1 `
          + `pane=${paneIds[index]} surface=${surfaceId}`,
        );
      }
      const owner = candidates[0];
      if (typeof owner.hostId !== "string" || owner.hostId.length === 0) {
        throw new Error(`${viewId}: presentation hostId가 비었습니다`);
      }
      if (typeof owner.rendererId !== "string" || owner.rendererId.length === 0) {
        throw new Error(`${viewId}: presentation renderer identity가 비었습니다`);
      }
      return Object.freeze({
        viewId,
        logicalPaneId: owner.logicalPaneId,
        hostId: owner.hostId,
        rendererId: owner.rendererId,
        surfaceId,
      });
    });
  },
  armParams({ traceId, owners }) {
    return {
      traceId,
      owners: owners.map(({ viewId, hostId, surfaceId }) => ({ viewId, hostId, surfaceId })),
      maxEvents: 512,
    };
  },
  readParams({ traceId }) {
    return { traceId };
  },
  events(receipt, { targetViewId }) {
    const violations = receipt?.violations ?? {};
    const violationTotal = Object.values(violations).reduce(
      (sum, value) => sum + (Number.isFinite(Number(value)) ? Number(value) : 0),
      0,
    );
    if (receipt?.closed !== true || violationTotal !== 0) {
      throw new Error(
        `${targetViewId}: presentation trace가 깨졌습니다 `
        + `closed=${String(receipt?.closed)} violations=${JSON.stringify(violations)}`,
      );
    }
    return (receipt.presentationEvents ?? []).map((event, index) => {
      const surfaces = (event?.surfaces ?? []).filter((surface) => surface?.viewId === targetViewId);
      if (surfaces.length !== 1) {
        throw new Error(`${targetViewId}: presentation event ${index} surface=${surfaces.length}/1`);
      }
      const surface = surfaces[0];
      return {
        // 궤적 판정의 시각은 이 좌표를 읽은 순간이다. `presentedAtUnixMs`는 직전 frame이
        // 화면에 뜬 시각이고 그 사이에도 CA 보간은 흐르므로, 그것으로 날인하면 지연이
        // 좌표 오차로 둔갑한다(실측 최대 0.65 물리 px).
        sampledAtUnixMs: Number(event.callbackObservedAtUnixMs),
        connected: surface.live === true && surface.visible === true && surface.painted === true,
        slotFrame: surface.domFrame,
        rendererFrame: surface.domFrame,
        surfaceFrame: surface.surfaceFrame,
      };
    });
  },
});

const OFFSCREEN_PRESENTATION_TRACE = Object.freeze({
  ownerCommand: "plugin.soksak-plugin-browser-chromium-offscreen.stats",
  ownerParams: () => ({}),
  armCommand: "plugin.soksak-plugin-browser-chromium-offscreen.surface.trace.start",
  readCommand: "plugin.soksak-plugin-browser-chromium-offscreen.surface.trace.read",
  resolveOwners({ facts, viewIds, paneIds }) {
    return viewIds.map((viewId, index) => {
      const candidates = (facts?.ids ?? []).filter((entry) => entry?.viewId === viewId);
      if (candidates.length !== 1
          || typeof candidates[0]?.surfaceId !== "number"
          || !Number.isFinite(candidates[0].surfaceId)) {
        throw new Error(`${viewId}: offscreen presentation owner=${candidates.length}/1`);
      }
      const surfaceId = String(candidates[0].surfaceId);
      return Object.freeze({
        viewId,
        logicalPaneId: paneIds[index],
        rendererId: `offscreen-renderer:${surfaceId}`,
        surfaceId,
      });
    });
  },
  armParams() {
    return { durationMs: 800 };
  },
  readParams({ traceId }) {
    return { traceId };
  },
  events(receipt, { targetViewId }) {
    return (receipt?.samples ?? []).map((sample, index) => {
      const surfaces = (sample?.surfaces ?? []).filter((surface) => surface?.viewId === targetViewId);
      if (surfaces.length !== 1) {
        throw new Error(`${targetViewId}: offscreen presentation sample ${index} surface=${surfaces.length}/1`);
      }
      const surface = surfaces[0];
      if (surface.rendererFrame == null || surface.surfaceFrame == null) {
        throw new Error(
          `${targetViewId}: offscreen native renderer/surface frame[${index}]가 모두 필요하다`,
        );
      }
      return {
        sampledAtUnixMs: Number(sample.atUnixMs),
        connected: surface.domRect != null,
        slotFrame: surface.domRect,
        // rAF/interpolation `domRect`는 진단일 뿐이다. renderer(content layer)와
        // surface(clip host)는 각자의 실제 display-link presentation frame을 보존한다.
        rendererFrame: surface.rendererFrame,
        surfaceFrame: surface.surfaceFrame,
      };
    });
  },
});

function finiteB04Rect(value, name) {
  const rect = {
    x: Number(value?.x),
    y: Number(value?.y),
    w: Number(value?.w),
    h: Number(value?.h),
  };
  if (![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)
      || rect.w <= 0 || rect.h <= 0) {
    throw new Error(`${name}: 유한한 양수 rect가 아니다 ${JSON.stringify(value)}`);
  }
  return rect;
}

/**
 * 클릭 대상은 layout 거래의 이동 owner와 같다는 보장이 없다. B04는 닫힌 공개 장부가
 * 유일하게 이동했다고 기록한 view를 presentation/DOM 참가자 identity의 정본으로 삼는다.
 */
export function resolveB04MovedParticipant({
  transactions,
  owners,
  viewIds,
  paneAddresses,
  slotAddresses,
}) {
  if (!Array.isArray(transactions) || transactions.length !== 1) {
    throw new Error(`B04 transactions=${transactions?.length ?? 0}/1`);
  }
  const moves = Array.isArray(transactions[0]?.moves) ? transactions[0].moves : [];
  if (moves.length !== 1) throw new Error(`B04 moved views=${moves.length}/1`);
  if (!Array.isArray(viewIds)
      || !Array.isArray(paneAddresses)
      || !Array.isArray(slotAddresses)
      || viewIds.length === 0
      || paneAddresses.length !== viewIds.length
      || slotAddresses.length !== viewIds.length) {
    throw new Error(
      `B04 participant inventory=${viewIds?.length ?? 0}`
      + `/${paneAddresses?.length ?? 0}/${slotAddresses?.length ?? 0}`,
    );
  }
  const targetViewId = moves[0]?.viewId;
  const matchingIndexes = viewIds
    .map((viewId, index) => (viewId === targetViewId ? index : -1))
    .filter((index) => index >= 0);
  if (typeof targetViewId !== "string" || !targetViewId || matchingIndexes.length !== 1) {
    throw new Error(`${String(targetViewId)}: B04 moved view mapping=${matchingIndexes.length}/1`);
  }
  const ownerMatches = (Array.isArray(owners) ? owners : [])
    .filter((owner) => owner?.viewId === targetViewId);
  if (ownerMatches.length !== 1) {
    throw new Error(`${targetViewId}: B04 presentation owner=${ownerMatches.length}/1`);
  }
  const index = matchingIndexes[0];
  const paneAddress = paneAddresses[index];
  const slotAddress = slotAddresses[index];
  if (typeof paneAddress !== "string" || !paneAddress
      || typeof slotAddress !== "string" || !slotAddress) {
    throw new Error(`${targetViewId}: B04 DOM address가 비었습니다`);
  }
  return {
    targetViewId,
    owner: ownerMatches[0],
    paneAddress,
    slotAddress,
  };
}

/**
 * raw layout journal의 optional field 계약은 바꾸지 않는다. 다만 B04 canonical receipt는
 * snap 거래도 동일한 exact-key schema를 가져야 하므로 누락 epoch를 null로 표현한다.
 *
 * 원장을 통째로 펼치지 않는다 — 코어가 장부에 필드를 하나 더 노출하는 날 그 필드가 canonical
 * receipt로 새어 exact-key 판정이 남의 이유로 깨진다. 투영 목록은 판정이 선언한 그 목록이다.
 */
export function normalizeB04JournalEntries(entries) {
  if (!Array.isArray(entries)) throw new Error("B04 journal entries는 배열이어야 한다");
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`B04 journal entry[${index}]가 객체가 아니다`);
    }
    const projected = {};
    for (const key of B04_JOURNAL_ENTRY_KEYS) projected[key] = entry[key] ?? null;
    return projected;
  });
}

/**
 * 공개 layout DOM-commit 사건이 연 실제 WebKit presentation-frame raw rect와 native display
 * producer를 transaction id·commit epoch·표시 시각으로 결합한다. 보간·투영은 하지 않는다.
 */
export function mapB04PresentationSamples({
  events,
  domSamples,
  owner,
  targetViewId,
  transactionId,
  domCommittedAtUnixMs,
  presentationStartAtUnixMs,
  durationMs,
  moveDx,
  railAddress,
  paneAddress,
  slotAddress,
}) {
  if (!Array.isArray(events) || events.length < 2) {
    throw new Error(`${targetViewId}: actual presentation samples=${events?.length ?? 0}/2`);
  }
  if (!Array.isArray(domSamples)) {
    throw new Error(`${targetViewId}: raw DOM samples=0/2`);
  }
  if (typeof transactionId !== "string" || !transactionId) {
    throw new Error(`${targetViewId}: transaction id가 비었습니다`);
  }
  const commitAt = domCommittedAtUnixMs;
  if (!Number.isFinite(commitAt)) {
    throw new Error(`${targetViewId}: DOM commit epoch가 유한하지 않다 ${domCommittedAtUnixMs}`);
  }
  const presentationStartAt = presentationStartAtUnixMs;
  if (!Number.isFinite(presentationStartAt) || presentationStartAt < commitAt) {
    throw new Error(
      `${targetViewId}: presentation start epoch=${presentationStartAtUnixMs}/${commitAt}`,
    );
  }
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error(`${targetViewId}: presentation duration=${durationMs}`);
  }
  if (!Number.isFinite(moveDx) || Math.abs(moveDx) < 0.5) {
    throw new Error(`${targetViewId}: presentation move dx=${moveDx}`);
  }
  for (const [index, sample] of domSamples.entries()) {
    if (sample?.sequence !== index || !Number.isFinite(sample?.sampledAtUnixMs)) {
      throw new Error(`${targetViewId}: raw DOM sample sequence/time[${index}]가 유효하지 않다`);
    }
  }
  const initialSamples = domSamples.filter((sample) => sample?.trigger === "initial");
  if (initialSamples.length !== 1) {
    throw new Error(`${targetViewId}: initial sample=${initialSamples.length}/1`);
  }
  const initialSample = initialSamples[0];
  if (initialSample.transactionId !== null || initialSample.domCommittedAtUnixMs !== null) {
    throw new Error(`${targetViewId}: initial sample에 layout transaction이 섞였다`);
  }
  const commitSamples = domSamples.filter((sample) => (
    sample?.trigger === "layout-dom-commit" && sample?.transactionId === transactionId
  ));
  if (commitSamples.length !== 1) {
    throw new Error(`${targetViewId}: DOM-commit sample=${commitSamples.length}/1 transaction=${transactionId}`);
  }
  const commitSample = commitSamples[0];
  if (commitSample.domCommittedAtUnixMs !== commitAt) {
    throw new Error(
      `${targetViewId}: DOM-commit epoch=${commitSample.domCommittedAtUnixMs}/${commitAt}`,
    );
  }
  const frameSamples = domSamples.filter((sample) => (
    sample?.trigger === "presentation-frame"
      && sample?.transactionId === transactionId
      && sample?.domCommittedAtUnixMs === commitAt
  ));
  // WebKit may suspend rAF for an occluded, unfocused window. That is an
  // observation limitation, not evidence that the DOM moved. The layout
  // commit callback is the authoritative DOM boundary for this transaction:
  // it reads the real DOM rect after the state commit, without interpolation
  // or a timer. Prefer display-frame samples when available, otherwise join
  // the native producer to this exact commit sample.
  // Keep the commit boundary as well as the final frame. Native events during
  // the glide must join the real DOM start and real DOM end; using only the
  // final sample would manufacture a large false gap at the first frame.
  const presentationSamples = [...commitSamples, ...frameSamples];
  if (presentationSamples.length === 0) {
    throw new Error(`${targetViewId}: DOM presentation boundary sample=0`);
  }
  // CADisplayLink와 WebKit DOM observers are independent producers. Their
  // callback epochs are not a visual contract, so nearest-sample timestamp
  // distance is recorded in `joins` but never used as a pass/fail shortcut.
  // The declared timeline validator below checks each producer at its own
  // actual samples and compares only physical rounded edges.
  const participant = (id, connected, frame) => ({
    id,
    ownerViewId: targetViewId,
    connected,
    frame,
  });
  const joins = [];
  let priorDomSequence = -1;
  let priorPresentationAt = -Infinity;
  const allSamples = events.map((event, index) => {
    const presentationAt = event.sampledAtUnixMs;
    if (!Number.isFinite(presentationAt) || presentationAt <= priorPresentationAt) {
      throw new Error(`${targetViewId}: presentation timestamp[${index}]=${presentationAt}/${priorPresentationAt}`);
    }
    priorPresentationAt = presentationAt;
    const beforeDomCommit = presentationAt < commitAt;
    const beforePresentationStart = presentationAt < presentationStartAt;
    const domSample = beforeDomCommit
      ? initialSample
      : beforePresentationStart
        ? commitSample
        : presentationSamples.reduce((nearest, candidate) => (
          Math.abs(candidate.sampledAtUnixMs - presentationAt)
            < Math.abs(nearest.sampledAtUnixMs - presentationAt)
            ? candidate
            : nearest
        ));
    const domAt = domSample?.sampledAtUnixMs;
    const gapMs = Math.abs(domAt - presentationAt);
    const domSequence = domSample?.sequence;
    if (!Number.isInteger(domSequence) || domSequence < priorDomSequence) {
      throw new Error(`${targetViewId}: DOM pair sequence[${index}]=${domSequence}/${priorDomSequence}`);
    }
    priorDomSequence = domSequence;
    const rawNodes = Array.isArray(domSample?.nodes) ? domSample.nodes : [];
    const distinctAddresses = new Set(rawNodes.map((node) => node?.address));
    const requiredNode = (address) => rawNodes.filter((node) => node?.address === address);
    const railMatches = requiredNode(railAddress);
    const paneMatches = requiredNode(paneAddress);
    const slotMatches = requiredNode(slotAddress);
    if (new Set([railAddress, paneAddress, slotAddress]).size !== 3
        || distinctAddresses.size !== rawNodes.length
        || railMatches.length !== 1
        || paneMatches.length !== 1
        || slotMatches.length !== 1) {
      throw new Error(`${targetViewId}: raw DOM participant inventory가 1:1이 아니다`);
    }
    const [rail] = railMatches;
    const [pane] = paneMatches;
    const [slot] = slotMatches;
    const railFrame = finiteB04Rect(rail.rect, `${targetViewId}:rail[${index}]`);
    const paneFrame = finiteB04Rect(pane.rect, `${targetViewId}:pane[${index}]`);
    const slotFrame = finiteB04Rect(slot.rect, `${targetViewId}:slot[${index}]`);
    const rendererFrame = finiteB04Rect(event.rendererFrame, `${targetViewId}:renderer[${index}]`);
    const surfaceFrame = finiteB04Rect(event.surfaceFrame, `${targetViewId}:surface[${index}]`);
    joins.push({
      sequence: index,
      domSequence,
      trigger: domSample.trigger,
      transactionId: domSample.transactionId,
      domSampledAtUnixMs: domAt,
      domCommittedAtUnixMs: domSample.domCommittedAtUnixMs,
      presentationSampledAtUnixMs: presentationAt,
      gapMs,
    });
    return {
      transactionId,
      sequence: index,
      phase: beforeDomCommit
        ? "prepared"
        : index === events.length - 1 ? "committed" : "presenting",
      sampledAtUnixMs: presentationAt,
      rail: participant(railAddress, rail.connected === true, railFrame),
      pane: participant(paneAddress, pane.connected === true, paneFrame),
      slot: participant(slotAddress, slot.connected === true, slotFrame),
      renderer: participant(owner.rendererId, event.connected === true, rendererFrame),
      surface: participant(owner.surfaceId, event.connected === true, surfaceFrame),
    };
  });
  const first = allSamples[0];
  const last = allSamples.at(-1);
  const samples = [
    { ...first, sequence: 0, phase: "prepared" },
    { ...last, sequence: 1, phase: "committed" },
  ];
  const endAtUnixMs = presentationStartAt + durationMs;
  const transactionWindow = (values, at) => {
    const before = values.filter((value) => at(value) <= presentationStartAt).at(-1);
    const during = values.filter((value) => (
      at(value) > presentationStartAt && at(value) < endAtUnixMs
    ));
    const after = values.find((value) => at(value) >= endAtUnixMs);
    return [before, ...during, after].filter((value, index, all) => (
      value !== undefined && all.indexOf(value) === index
    ));
  };
  // Preserve every real DOM boundary at the start epoch. The commit and the
  // one-shot post-commit anchor can share a timestamp, but they are distinct
  // observations and must not be collapsed by object-identity deduplication.
  const transactionDomSamples = [
    ...presentationSamples.filter((sample) => sample.sampledAtUnixMs <= presentationStartAt),
    ...presentationSamples.filter((sample) => (
      sample.sampledAtUnixMs > presentationStartAt && sample.sampledAtUnixMs < endAtUnixMs
    )),
    ...presentationSamples.filter((sample) => sample.sampledAtUnixMs >= endAtUnixMs).slice(0, 1),
  ];
  const transactionNativeEvents = transactionWindow(events, (event) => event.sampledAtUnixMs);
  const slotTimeline = transactionDomSamples.map((domSample, sequence) => {
    const matches = (domSample.nodes ?? []).filter((node) => node?.address === slotAddress);
    if (matches.length !== 1 || matches[0].connected !== true) {
      throw new Error(`${targetViewId}: timeline slot[${sequence}]=${matches.length}/1 connected`);
    }
    return {
      sequence,
      sampledAtUnixMs: domSample.sampledAtUnixMs,
      frame: finiteB04Rect(matches[0].rect, `${targetViewId}:timeline-slot[${sequence}]`),
    };
  });
  // 한 표시 epoch에는 표시된 frame이 하나뿐이다. DOM commit 경계와 그 직후 one-shot
  // anchor는 서로 다른 관측이지만 같은 epoch를 공유할 수 있고, 같은 rect라면 궤적 위의
  // 한 점이다. rect가 다르면 한 epoch에 두 frame을 주장하는 것이므로 둘 다 남겨 RED로 센다.
  const collapsedSlotTimeline = slotTimeline.reduce((rows, row) => {
    const previous = rows[rows.length - 1];
    if (previous
        && previous.sampledAtUnixMs === row.sampledAtUnixMs
        && sameRect(previous.frame, row.frame)) return rows;
    rows.push(row);
    return rows;
  }, []).map((row, sequence) => ({ ...row, sequence }));
  const fromSample = collapsedSlotTimeline.filter(({ sampledAtUnixMs }) => (
    sampledAtUnixMs <= presentationStartAt
  )).at(-1);
  if (!fromSample) throw new Error(`${targetViewId}: timeline start coverage가 없다`);
  const from = fromSample.frame;
  const to = { ...from, x: from.x - moveDx };
  const nativeTimeline = (field) => transactionNativeEvents.map((event, sequence) => ({
    sequence,
    sampledAtUnixMs: event.sampledAtUnixMs,
    frame: finiteB04Rect(event[field], `${targetViewId}:timeline-${field}[${sequence}]`),
  }));
  return {
    samples,
    joins,
    timeline: {
      startAtUnixMs: presentationStartAt,
      durationMs,
      timingFunction: [0.4, 0, 0.2, 1],
      from,
      to,
      slot: collapsedSlotTimeline,
      renderer: nativeTimeline("rendererFrame"),
      surface: nativeTimeline("surfaceFrame"),
    },
  };
}

export const browserImplementations = Object.freeze({
  browser: Object.freeze({
    plugin: "soksak-plugin-browser-native",
    surface: "framework-native",
    label: (windowLabel, viewId) => `b-${windowLabel}-${viewId}`,
    presentationTrace: FRAMEWORK_PRESENTATION_TRACE,
  }),
  "browser-chromium": Object.freeze({
    plugin: "soksak-plugin-browser-chromium",
    surface: "engine-windowed",
    label: (_windowLabel, viewId) => `chromium-${viewId}`,
    presentationTrace: FRAMEWORK_PRESENTATION_TRACE,
  }),
  "browser-chromium-offscreen": Object.freeze({
    plugin: "soksak-plugin-browser-chromium-offscreen",
    surface: "engine-offscreen",
    label: (_windowLabel, viewId) => `offscreen-${viewId}`,
    presentationTrace: OFFSCREEN_PRESENTATION_TRACE,
  }),
});

export const fixtureMarkers = Object.freeze(["#ff00ff", "#00ffff"]);
export const fixtureInputMarkers = Object.freeze(["#ffff00", "#00ff00"]);
// 궤적 기준자는 page/input/lighting/calibration 팔레트와 겹치지 않는다. 같은 색을 재사용하면
// 다른 12px 조각을 두 번째 기준자로 오인해 실제 착지 뒤에도 거짓 dx가 생긴다.
export const fixtureMotionMarkers = Object.freeze(["#8000ff", "#ff8000"]);
export const fixtureMotionMarkerSize = Object.freeze({ width: 12, height: 12 });
// 공용 브라우저 툴바의 DOM anchor와 페이지 fixed anchor 사이의 선언된 수직 간격.
export const fixtureMotionMarkerVerticalGap = 28;
export const fixtureInputMarkerSize = Object.freeze({ minWidth: 64, height: 24 });
export const compositorCalibrationMarker = "#0000ff";
export const compositorCalibrationSize = Object.freeze({ width: 40, height: 40 });
// hostile resize의 최소 2-pane viewport에도 잘리지 않는 고정 ruler. 작아지는 반응형 marker가
// 아니라 언제나 같은 64 CSS px이므로 캡처에서 확대/압축된 옛 프레임을 엄격히 검출할 수 있다.
export const fixtureMarkerSize = Object.freeze({ width: 64, height: 40 });
export const fixtureMarkerGap = 8;

/** 플러그인 DOM의 단일 소유권 판정. Tauri native surface는 별도 OS renderer지만
 * plugin chrome/slot DOM은 Electron과 동일하게 메인 문서에만 존재해야 한다. */
export function rendererTopologyOwnershipVerdict(topology) {
  const errors = [];
  if (!topology) errors.push("missing");
  else {
    if (topology.verdict !== "shared-pane-host") errors.push(`verdict=${topology.verdict}`);
    if (topology.panelAtomicMotion !== true) errors.push(`panelAtomicMotion=${topology.panelAtomicMotion}`);
    if (typeof topology.sharedPaneHost !== "string" || topology.sharedPaneHost.length === 0) {
      errors.push(`sharedPaneHost=${topology.sharedPaneHost}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** 전체 문서 identity는 같은 색의 독립 표식 3개로 이루어진 한 행이다.
 * 단순 색상 개수 대신 선언된 크기·정렬·간격을 함께 판정해 중복 캡처와 찢어진 캡처를 구분한다. */
export function fixtureMarkerRowVerdict(components, { scale = 1 } = {}) {
  const expectedWidth = fixtureMarkerSize.width * scale;
  const expectedHeight = fixtureMarkerSize.height * scale;
  const expectedGap = fixtureMarkerGap * scale;
  const tolerance = Math.max(2, 2 * scale);
  const candidates = components
    .filter((component) => component.width >= expectedWidth * 0.7 && component.height >= expectedHeight * 0.7)
    .sort((left, right) => left.y - right.y || left.x - right.x);
  const errors = [];
  if (candidates.length !== 3) errors.push(`count=${candidates.length}`);
  if (candidates.length === 3) {
    for (const [index, component] of candidates.entries()) {
      if (Math.abs(component.width - expectedWidth) > tolerance
          || Math.abs(component.height - expectedHeight) > tolerance) {
        errors.push(`size-${index}=${component.width}x${component.height}`);
      }
      if (Math.abs(component.y - candidates[0].y) > tolerance) {
        errors.push(`row-${index}=${component.y - candidates[0].y}`);
      }
      if (index > 0) {
        const gap = component.x - (candidates[index - 1].x + candidates[index - 1].width);
        if (Math.abs(gap - expectedGap) > tolerance) errors.push(`gap-${index}=${gap}`);
      }
    }
  }
  return { ok: errors.length === 0, errors, components: candidates };
}

/** window.info는 물리 픽셀, window.snapshot은 구현이 선택한 PNG 픽셀을 반환한다.
 * 두 값을 섞어 deviceScale을 추측하지 않고 실제 산출물의 CSS-px당 PNG-px 배율을 계산한다. */
export function snapshotCssScale(bytes, windowInfo) {
  const image = decodePng(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  const deviceScale = Number(windowInfo?.scale);
  const cssWidth = Number(windowInfo?.w) / deviceScale;
  const cssHeight = Number(windowInfo?.h) / deviceScale;
  const x = image.w / cssWidth;
  const y = image.h / cssHeight;
  if (![deviceScale, cssWidth, cssHeight, x, y].every(Number.isFinite)
      || deviceScale <= 0 || cssWidth <= 0 || cssHeight <= 0 || x <= 0 || y <= 0) {
    throw new Error(`snapshot 좌표계 산출 불가: ${JSON.stringify({ image: { w: image.w, h: image.h }, windowInfo })}`);
  }
  if (Math.abs(x - y) > 0.02) {
    throw new Error(`snapshot 비등방 배율: ${x}x${y}`);
  }
  return (x + y) / 2;
}

export function markerEvidence(bytes, hex, tolerance = 24, sampleStep = 1) {
  const image = decodePng(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  const target = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  const step = Math.max(1, Math.round(sampleStep));
  const gridWidth = Math.ceil(image.w / step);
  const gridHeight = Math.ceil(image.h / step);
  const matches = new Uint8Array(gridWidth * gridHeight);
  let total = 0;
  for (let gy = 0; gy < gridHeight; gy += 1) {
    for (let gx = 0; gx < gridWidth; gx += 1) {
      const x = gx * step;
      const y = gy * step;
      const i = (y * image.w + x) * image.ch;
      const rgb = image.ch >= 3
        ? [image.px[i], image.px[i + 1], image.px[i + 2]]
        : [image.px[i], image.px[i], image.px[i]];
      // 조명은 표면 위 native/DOM 합성 평면이다. 창이 비활성인 무포커스 캡처에서는 AppKit도
      // 함께 합성하므로 원색의 절대 RGB는 보존되지 않지만 색상 채널의 우세 관계는 보존된다.
      // 큰 marker의 hue를 세면 필요한 focus lighting을 유지하면서도 표면 생존을 판정할 수 있다.
      const [r, g, b] = rgb;
      const dimDominant = 20;
      const dimChroma = 12;
      const dimBalance = 8;
      const managedBalance = Math.max(dimBalance, Math.max(r, g, b) * 0.08);
      const kind = target[0] === 128 && target[1] === 0 && target[2] === 255 ? "violet"
        : target[0] === 255 && target[1] === 128 && target[2] === 0 ? "orange"
        : target[0] === 0 && target[1] === 0 && target[2] === 255 ? "blue"
        : target[0] === 255 && target[1] === 0 && target[2] === 0 ? "red"
        : target[0] === 255 && target[1] === 0 && target[2] === 255 ? "magenta"
        : target[0] === 0 && target[1] === 255 && target[2] === 255 ? "cyan"
          : target[0] === 255 && target[1] === 255 ? "yellow" : "green";
      const hit = kind === "violet"
        ? b - g >= 48 && r - g >= 24 && b - r >= 24
        : kind === "orange"
        // 비활성 표면은 제품 계약상 밝기가 크게 내려가므로 절대 원색 차이가 아니라 orange의
        // 세 채널 순서와 최소 채도를 본다. 연결 성분의 직사각 본체 판정이 장식 조각을 배제한다.
        ? r >= dimDominant && r - b >= dimChroma && g - b >= 6 && r - g >= 8
        : kind === "blue"
        ? b - r >= 64 && b - g >= 64 && Math.abs(r - g) <= tolerance
        : kind === "red"
        ? r - g >= 48 && r - b >= 48 && Math.abs(g - b) <= tolerance * 2
        : kind === "magenta"
        // blocked pane은 제품 계약상 70% veil(원색의 약 30%)까지 내려간다. 절대 밝기가 아니라
        // magenta 채도와 R/B 균형으로 식별하고, 생존 판정은 호출부의 큰 연결성분 기준이 맡는다.
        ? Math.max(r, b) >= dimDominant && r - g >= dimChroma && b - g >= dimChroma && Math.abs(r - b) <= managedBalance
        : kind === "cyan"
          ? Math.max(g, b) >= dimDominant && g - r >= dimChroma && b - r >= dimChroma && Math.abs(g - b) <= managedBalance
          : kind === "yellow"
            ? Math.max(r, g) >= dimDominant && r - b >= dimChroma && g - b >= dimChroma && Math.abs(r - g) <= managedBalance
            : g >= dimDominant && g - r >= dimChroma && g - b >= dimChroma;
      if (hit) {
        matches[gy * gridWidth + gx] = 1;
        total += 1;
      }
    }
  }
  let largest = { count: 0, x: 0, y: 0, width: 0, height: 0 };
  const components = [];
  const stack = [];
  for (let start = 0; start < matches.length; start += 1) {
    if (!matches[start]) continue;
    matches[start] = 0;
    stack.push(start);
    let count = 0;
    let minX = gridWidth, maxX = 0, minY = gridHeight, maxY = 0;
    const rowExtents = new Map();
    const columnExtents = new Map();
    const rowPoints = new Map();
    while (stack.length) {
      const at = stack.pop();
      const x = at % gridWidth;
      const y = Math.floor(at / gridWidth);
      count += 1;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      const row = rowExtents.get(y) ?? [x, x];
      row[0] = Math.min(row[0], x); row[1] = Math.max(row[1], x);
      rowExtents.set(y, row);
      const points = rowPoints.get(y) ?? [];
      points.push(x);
      rowPoints.set(y, points);
      const column = columnExtents.get(x) ?? [y, y];
      column[0] = Math.min(column[0], y); column[1] = Math.max(column[1], y);
      columnExtents.set(x, column);
      for (const next of [at - 1, at + 1, at - gridWidth, at + gridWidth]) {
        if (next < 0 || next >= matches.length || !matches[next]) continue;
        const nx = next % gridWidth;
        if (Math.abs(nx - x) > 1) continue;
        matches[next] = 0;
        stack.push(next);
      }
    }
    const median = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)] ?? 0;
    };
    const component = {
      count,
      x: minX * step,
      y: minY * step,
      width: (maxX - minX + 1) * step,
      height: (maxY - minY + 1) * step,
      bodyWidth: median([...rowExtents.values()].map(([lo, hi]) => hi - lo + 1)) * step,
      bodyHeight: median([...columnExtents.values()].map(([lo, hi]) => hi - lo + 1)) * step,
    };
    const rowRuns = [...rowPoints.values()].map((points) => {
      const sorted = points.sort((a, b) => a - b);
      let longest = 0;
      let run = 0;
      let previous = -2;
      for (const point of sorted) {
        run = point === previous + 1 ? run + 1 : 1;
        longest = Math.max(longest, run);
        previous = point;
      }
      return longest * step;
    });
    // 진단 JSON은 기존의 작은 요약을 유지하되, 선택기는 연결 성분 안의 직사각 본체를 읽는다.
    Object.defineProperties(component, {
      rowRuns: { value: rowRuns, enumerable: false },
      sampleStep: { value: step, enumerable: false },
    });
    components.push(component);
    if (count > largest.count) largest = component;
  }
  components.sort((a, b) => b.count - a.count);
  return { total, largest, components };
}

export function markerPixels(bytes, hex, tolerance = 24, sampleStep = 1) {
  return markerEvidence(bytes, hex, tolerance, sampleStep).total;
}

/** 같은 hue의 페이지 배경이 있어도 fixture의 선언된 본체 기하와 맞는 성분만 고른다. */
export function selectFixtureMarkerComponent(
  components,
  { expectedWidth, expectedHeight, minWidth = false, tolerance = 4, minCount = 200 },
) {
  return (components ?? [])
    .filter((component) => component.count >= minCount)
    .filter((component) => {
      const rectangleHeight = (component.rowRuns ?? []).filter((width) => minWidth
        ? width >= expectedWidth - tolerance
        : Math.abs(width - expectedWidth) <= tolerance).length * (component.sampleStep ?? 1);
      const bodyHeightMatches = Math.abs(component.bodyHeight - expectedHeight) <= tolerance;
      const bodyWidthMatches = minWidth
        ? component.bodyWidth >= expectedWidth - tolerance
        : Math.abs(component.bodyWidth - expectedWidth) <= tolerance;
      const outerHeightMatches = Math.abs(component.height - expectedHeight) <= tolerance;
      const outerWidthMatches = minWidth
        ? component.width >= expectedWidth - tolerance
        : Math.abs(component.width - expectedWidth) <= tolerance;
      return (bodyHeightMatches && bodyWidthMatches)
        || rectangleHeight >= expectedHeight - tolerance
        || (outerHeightMatches && outerWidthMatches);
    })
    .sort((a, b) => b.count - a.count)[0] ?? null;
}

/** 같은 색의 DOM slot anchor와 페이지 surface marker가 한 프레임에서 같은 x에 있는지 판정한다. */
export function motionMarkerAlignment(bytes, hex, scale, tolerance = 4) {
  const expected = Number(scale) * fixtureMotionMarkerSize.width;
  const expectedGap = Number(scale) * fixtureMotionMarkerVerticalGap;
  // 앱의 장식 평면은 브라우저와 DOM anchor보다 위에 그려질 수 있다. 장식이 marker를
  // 가로지르면 같은 12px 사각형이 여러 연결 성분으로 갈리지만 그 외곽과 x는 변하지 않는다.
  // 한 marker 경계 안에서만 조각을 합쳐 관측 오염을 복구하고, 두 marker의 x 동일성은 그대로
  // 엄격히 판정한다. 멀리 떨어진 같은 hue 장식은 이 경계에 들어오지 못한다.
  const fragments = markerEvidence(bytes, hex, 24, 1).components;
  const clusters = [];
  for (const component of fragments) {
    let merged = false;
    for (const cluster of clusters) {
      const x = Math.min(cluster.x, component.x);
      const y = Math.min(cluster.y, component.y);
      const right = Math.max(cluster.x + cluster.width, component.x + component.width);
      const bottom = Math.max(cluster.y + cluster.height, component.y + component.height);
      if (right - x <= expected + tolerance && bottom - y <= expected + tolerance) {
        cluster.x = x;
        cluster.y = y;
        cluster.width = right - x;
        cluster.height = bottom - y;
        cluster.bodyWidth = cluster.width;
        cluster.bodyHeight = cluster.height;
        cluster.count += component.count;
        merged = true;
        break;
      }
    }
    if (!merged) clusters.push({ ...component });
  }
  const candidates = clusters.filter((component) =>
    component.count >= expected * expected * 0.2
    // 위에 있는 장식은 marker의 오른쪽 일부를 덮을 수 있다. x축 판정의 기준인 왼쪽
    // 경계와 전체 높이가 살아 있으면 최대 25%의 오른쪽 가림은 허용하되, 두 기준자의 x
    // 동일성 자체는 아래에서 같은 tolerance로 계속 엄격히 판정한다.
    && component.width >= expected - Math.max(tolerance, Math.ceil(expected * 0.25))
    && component.width <= expected + tolerance
    && Math.abs(component.height - expected) <= tolerance);
  const pairs = candidates.flatMap((first, index) => candidates.slice(index + 1).map((second) => ({
    pair: [first, second],
    gapError: Math.abs(Math.abs(first.y - second.y) - expectedGap),
    count: first.count + second.count,
  }))).filter((entry) => entry.gapError <= tolerance)
    .sort((a, b) => a.gapError - b.gapError || b.count - a.count);
  if (!pairs.length) {
    return { ok: false, errors: [`motion-pair=0 candidates=${candidates.length}`], candidates };
  }
  const selected = pairs[0].pair;
  const dx = Math.abs(selected[0].x - selected[1].x);
  return {
    ok: dx <= tolerance,
    dx,
    errors: dx <= tolerance ? [] : [`motion-x=${selected[0].x}/${selected[1].x} dx=${dx}`],
    candidates,
  };
}

/** 유한 캡처 구간을 끝까지 읽고 실패 분포와 최대 궤적 이탈을 한 판정으로 만든다. */
export function summarizeFrameSequence(observations) {
  const rows = Array.isArray(observations) ? observations : [];
  const failures = rows.filter((row) => Array.isArray(row.errors) && row.errors.length > 0);
  const maxMotionDx = rows.reduce(
    (max, row) => Math.max(max, Number.isFinite(Number(row.motionDx)) ? Number(row.motionDx) : 0),
    0,
  );
  const details = failures.map((row) => `${row.frame}:${row.errors.join("|")}`);
  return {
    ok: failures.length === 0,
    checked: rows.length,
    failed: failures.length,
    maxMotionDx,
    failures,
    summary: `frames=${rows.length} failed=${failures.length} maxMotionDx=${maxMotionDx}${details.length ? ` ${details.join(", ")}` : ""}`,
  };
}

/**
 * 사이드바와 탭 pane의 DOM 전이를 녹화와 독립된 수치로 판정한다.
 * 주소는 전이 전에 한 번 해석된 같은 Element를 가리키므로 connected=false는 DOM 교체/분리다.
 * 실제로 움직이는 노드들은 중앙 거래가 부여한 하나의 FLIP 시계를 공유해야 한다.
 */
export function domTransitionTraceVerdict(
  samples,
  {
    railAddress,
    paneAddresses,
    animationName = "rail-flip-x",
    clockToleranceMs = 0.1,
    progressTolerance = 0.001,
    positionTolerancePx = 1,
    minSamples = 3,
    motionMode = "glide",
  },
) {
  const rows = Array.isArray(samples) ? samples : [];
  const expected = [railAddress, ...(paneAddresses ?? [])];
  const errors = [];
  const animatedAddresses = new Set();
  let sharedClockFrames = 0;
  if (rows.length < minSamples) errors.push(`frames=${rows.length}/${minSamples}`);

  for (const [sampleIndex, sample] of rows.entries()) {
    const byAddress = new Map((sample?.nodes ?? []).map((node) => [node.address, node]));
    const moving = [];
    for (const address of expected) {
      const node = byAddress.get(address);
      if (!node) {
        errors.push(`s${sampleIndex}:missing:${address}`);
        continue;
      }
      if (node.connected !== true) errors.push(`s${sampleIndex}:disconnected:${address}`);
      const rect = node.rect;
      if (![rect?.x, rect?.y, rect?.w, rect?.h].every((value) => Number.isFinite(Number(value)))) {
        errors.push(`s${sampleIndex}:rect-non-finite:${address}`);
      } else if (Number(rect.w) <= 0 || Number(rect.h) <= 0) {
        errors.push(`s${sampleIndex}:rect-empty:${address}:${rect.w}x${rect.h}`);
      }
      const animation = (node.animations ?? []).find((item) => item.name === animationName);
      if (animation) {
        animatedAddresses.add(address);
        moving.push({ address, animation });
      }
    }
    if (moving.length === 1) {
      errors.push(`s${sampleIndex}:clock-participants=${moving[0].address}`);
    } else if (moving.length > 1) {
      sharedClockFrames += 1;
      const basis = moving[0];
      for (const current of moving.slice(1)) {
        const startSkew = Math.abs(Number(current.animation.startTime) - Number(basis.animation.startTime));
        const currentSkew = Math.abs(Number(current.animation.currentTime) - Number(basis.animation.currentTime));
        const progressSkew = Math.abs(Number(current.animation.progress) - Number(basis.animation.progress));
        if (!Number.isFinite(startSkew) || startSkew > clockToleranceMs) {
          errors.push(`s${sampleIndex}:clock-start-skew=${basis.address}/${current.address}:${startSkew}`);
        }
        if (!Number.isFinite(currentSkew) || currentSkew > clockToleranceMs) {
          errors.push(`s${sampleIndex}:clock-current-skew=${basis.address}/${current.address}:${currentSkew}`);
        }
        if (!Number.isFinite(progressSkew) || progressSkew > progressTolerance) {
          errors.push(`s${sampleIndex}:clock-progress-skew=${basis.address}/${current.address}:${progressSkew}`);
        }
      }
    }
  }

  if (motionMode === "glide") {
    if (!animatedAddresses.has(railAddress)) errors.push(`animation-missing:${railAddress}`);
    if (!(paneAddresses ?? []).some((address) => animatedAddresses.has(address))) {
      errors.push("animation-missing:pane");
    }
    if (sharedClockFrames === 0) errors.push("shared-clock-frames=0");
  } else if (motionMode === "snap") {
    if (animatedAddresses.size > 0) errors.push(`animation-forbidden:${[...animatedAddresses].join("/")}`);
    const changeFrames = [];
    for (const address of expected) {
      const xs = rows.map((sample) => Number(
        (sample?.nodes ?? []).find((node) => node.address === address)?.rect?.x,
      )).filter(Number.isFinite);
      const distinct = xs.filter((value, index) => index === 0 || Math.abs(value - xs[index - 1]) > positionTolerancePx);
      if (distinct.length > 2) errors.push(`snap-intermediate:${address}:${distinct.join("/")}`);
      if (distinct.length === 2) {
        changeFrames.push({ address, frame: xs.findIndex((value) => Math.abs(value - xs[0]) > positionTolerancePx) });
      }
    }
    if (!changeFrames.some(({ address }) => address === railAddress)) errors.push(`snap-missing:${railAddress}`);
    if (!changeFrames.some(({ address }) => (paneAddresses ?? []).includes(address))) errors.push("snap-missing:pane");
    const frames = new Set(changeFrames.map(({ frame }) => frame));
    if (frames.size > 1) errors.push(`snap-frame-skew:${changeFrames.map(({ address, frame }) => `${address}@${frame}`).join("/")}`);
  } else {
    errors.push(`motion-mode-unknown:${motionMode}`);
  }

  for (const address of expected) {
    const xs = rows
      .map((sample) => (sample?.nodes ?? []).find((node) => node.address === address)?.rect?.x)
      .map(Number)
      .filter(Number.isFinite);
    if (xs.length < 2) continue;
    const direction = Math.sign(xs.at(-1) - xs[0]);
    if (direction === 0) continue;
    for (let index = 1; index < xs.length; index += 1) {
      const step = xs[index] - xs[index - 1];
      if (step * direction < -positionTolerancePx) {
        errors.push(`s${index}:position-reversed:${address}:${xs[index - 1]}/${xs[index]}`);
      }
    }
  }

  return { ok: errors.length === 0, errors, frames: rows.length, sharedClockFrames, motionMode };
}

/**
 * PIN 포커스 변경은 레이아웃 거래가 아니다. 같은 공개 DOM들이 전 프레임 연결된 채 같은 rect를
 * 유지하고, 레일 이동 FLIP에 참여하지 않아야 한다. 녹화 프레임 이벤트와 같은 tick의 trace를
 * 소비하므로 화면과 수치 판정의 관측 구간도 같다.
 */
export function pinnedDomTraceVerdict(
  samples,
  { addresses, tolerancePx = 0.5, minSamples = 3, animationName = "rail-flip-x" },
) {
  const rows = Array.isArray(samples) ? samples : [];
  const expected = Array.isArray(addresses) ? addresses : [];
  const errors = [];
  const baseline = new Map();
  if (rows.length < minSamples) errors.push(`frames=${rows.length}/${minSamples}`);
  if (!expected.length) errors.push("addresses=0");

  for (const [sampleIndex, sample] of rows.entries()) {
    const byAddress = new Map((sample?.nodes ?? []).map((node) => [node.address, node]));
    for (const address of expected) {
      const node = byAddress.get(address);
      if (!node) {
        errors.push(`s${sampleIndex}:missing:${address}`);
        continue;
      }
      if (node.connected !== true) errors.push(`s${sampleIndex}:disconnected:${address}`);
      const rect = node.rect;
      if (![rect?.x, rect?.y, rect?.w, rect?.h].every((value) => Number.isFinite(Number(value)))) {
        errors.push(`s${sampleIndex}:rect-non-finite:${address}`);
        continue;
      }
      if (!baseline.has(address)) baseline.set(address, { ...rect });
      const first = baseline.get(address);
      for (const key of ["x", "y", "w", "h"]) {
        const from = Number(first[key]);
        const to = Number(rect[key]);
        if (Math.abs(to - from) > tolerancePx) {
          errors.push(`s${sampleIndex}:rect-changed:${address}:${key}=${from}/${to}`);
        }
      }
      for (const animation of node.animations ?? []) {
        if (animation?.name === animationName) {
          errors.push(`s${sampleIndex}:animation-forbidden:${address}:${animationName}`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors, frames: rows.length };
}

/**
 * 녹화 픽셀이 아니라 같은 유한 trace tick에서 읽은 DOM rect와 native presentation rect를
 * 비교한다. tick의 왕복 불확실성이 크면 좌표가 맞아도 관측 실패다.
 */
export function numericCompositionTraceVerdict(
  samples,
  { tolerancePx = 1, maxUncertaintyMs = 2, minSamples = 3 } = {},
) {
  const errors = [];
  let maxDelta = 0;
  let compared = 0;
  for (const [sampleIndex, sample] of (samples ?? []).entries()) {
    const uncertaintyMs = Number(sample?.uncertaintyMs);
    if (!Number.isFinite(uncertaintyMs) || uncertaintyMs > maxUncertaintyMs) {
      errors.push(`s${sampleIndex}:clock-uncertainty=${uncertaintyMs}/${maxUncertaintyMs}ms`);
      continue;
    }
    for (const pair of sample?.surfaces ?? []) {
      const dom = pair?.domRect;
      const native = pair?.presentationRect;
      if (!dom || !native) {
        errors.push(`s${sampleIndex}:${pair?.viewId ?? "unknown"}:rect-missing`);
        continue;
      }
      compared += 1;
      for (const key of ["x", "y", "w", "h"]) {
        const delta = Math.abs(Number(dom[key]) - Number(native[key]));
        if (!Number.isFinite(delta)) {
          errors.push(`s${sampleIndex}:${pair.viewId}:${key}=non-finite`);
          continue;
        }
        maxDelta = Math.max(maxDelta, delta);
        if (delta > tolerancePx) {
          errors.push(`s${sampleIndex}:${pair.viewId}:${key}=${dom[key]}/${native[key]} dx=${delta}`);
        }
      }
    }
  }
  if (compared < minSamples) errors.push(`samples=${compared}/${minSamples}`);
  return { ok: errors.length === 0, errors, compared, maxDelta };
}

/** 정사각 DOM ruler의 고유비를 유지한 component만 합성 배율 근거로 쓴다.
 * WindowServer crop이나 네이티브 표면에 일부 가려진 조각은 존재 증거일 뿐 epoch 증거가 아니다. */
export function completeCalibrationComponents(components, tolerance = 4) {
  return components.filter((component) =>
    Math.abs(Number(component.width) - Number(component.height)) <= tolerance);
}

/** WindowServer가 화면 경계에 맞춰 창 캡처 전체를 재투영할 수 있으므로 각 PNG 안의 DOM
 * 기준자에서 그 프레임의 실제 CSS→pixel 배율을 읽는다. 브라우저만의 stretch는 이 값에
 * 포함되지 않아 동일 epoch 비교 기준을 약화하지 않는다. */
export function calibrationFrameScale(components, intrinsic = compositorCalibrationSize) {
  const complete = completeCalibrationComponents(components);
  if (!complete.length) return null;
  const values = complete.flatMap((component) => [
    Number(component.width) / Number(intrinsic.width),
    Number(component.height) / Number(intrinsic.height),
  ]).filter(Number.isFinite).sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)] ?? null;
}

export function parseBrowserEngines(raw) {
  const engines = String(raw ?? Object.keys(browserImplementations).join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const unknown = engines.filter((engine) => !(engine in browserImplementations));
  if (unknown.length) throw new Error(`지원하지 않는 브라우저 구현: ${unknown.join(", ")}`);
  if (!engines.length) throw new Error("검증할 브라우저 구현이 없습니다");
  return [...new Set(engines)];
}

/**
 * 한 workspace window 안에서 플러그인 view 장부와 실제 엔진 surface 장부가 같은 대상을
 * 가리키는지 판정한다. 엔진의 전역 stats에는 다른 window의 surface도 함께 보이므로 owner를
 * `plugin@window`로 범위화한다. DOM/픽셀 판정 전에 이 연결이 끊겼다면 화면은 우연히 남은
 * 프레임일 뿐 live surface가 아니다.
 */
export function browserSurfaceInvariant({
  surface,
  plugin,
  windowLabel,
  viewIds,
  expectedVisible,
  stats,
}) {
  const errors = [];
  const expectedOwner = `${plugin}@${windowLabel}`;
  const offscreen = surface === "engine-offscreen";
  const engine = offscreen ? stats?.engine : stats;
  const engineSurfaces = Array.isArray(engine?.surfaces) ? engine.surfaces : [];
  const byId = new Map(engineSurfaces.map((item) => [Number(item.id), item]));
  const engineIds = new Set((Array.isArray(engine?.ids) ? engine.ids : []).map(Number));
  const offscreenMap = new Map(
    (Array.isArray(stats?.ids) ? stats.ids : []).map((item) => [item?.viewId, Number(item?.surfaceId)]),
  );
  const mappedIds = [];

  for (let index = 0; index < viewIds.length; index += 1) {
    const viewId = viewIds[index];
    const key = offscreen ? viewId : `chromium-${viewId}`;
    const id = offscreen ? offscreenMap.get(viewId) : Number(stats?.idMap?.[key]);
    if (!Number.isFinite(id)) {
      errors.push(`${viewId}:mapping-missing`);
      continue;
    }
    mappedIds.push(id);
    const live = engineIds.has(id) && byId.has(id);
    if (!live) {
      errors.push(`${viewId}:engine-live-missing:${id}`);
      continue;
    }
    const actual = byId.get(id);
    if (actual.owner !== expectedOwner) errors.push(`${viewId}:owner=${actual.owner}/${expectedOwner}`);
    const visible = expectedVisible[index] === true;
    if (actual.hidden !== !visible) errors.push(`${viewId}:hidden=${actual.hidden}/${!visible}`);
    if (!offscreen && stats?.visibility?.[key] !== visible) {
      errors.push(`${viewId}:plugin-visible=${stats?.visibility?.[key]}/${visible}`);
    }
    // windowed surface가 PaneSurfaceHost에 결합되면 독립 창 bounds 소유권은 사라지고
    // composition이 실제 배치 정본이 된다. 여기서는 live 결합 존재를 판정하고, 정확한 DOM↔member
    // 기하는 webview.composition의 1px 계약이 별도로 판정한다.
    if (!offscreen && visible && !actual.bounds && !actual.composition) {
      errors.push(`${viewId}:presentation-missing`);
    }
    if (offscreen && actual.resize?.pending === true) errors.push(`${viewId}:resize-pending`);
    if (offscreen && actual.viewport?.matches !== true) errors.push(`${viewId}:viewport-mismatch`);
  }

  const sortedMapped = [...mappedIds].sort((a, b) => a - b);
  const ledger = (Array.isArray(stats?.ledger) ? stats.ledger : []).map(Number).sort((a, b) => a - b);
  if (JSON.stringify(ledger) !== JSON.stringify(sortedMapped)) {
    errors.push(`ledger=${JSON.stringify(ledger)}/mapped=${JSON.stringify(sortedMapped)}`);
  }
  const ownedLive = engineSurfaces
    .filter((item) => item.owner === expectedOwner)
    .map((item) => Number(item.id))
    .sort((a, b) => a - b);
  if (JSON.stringify(ownedLive) !== JSON.stringify(sortedMapped)) {
    errors.push(`owned-live=${JSON.stringify(ownedLive)}/mapped=${JSON.stringify(sortedMapped)}`);
  }
  return { ok: errors.length === 0, errors, mappedIds: sortedMapped };
}

/** 같은 원본 크기에는 언제나 같은 급격한 왕복을 만든다. 마지막 단계는 정확한 원복이다. */
export function hostileWindowResizeSizes(original) {
  const w = Math.round(Number(original.w));
  const h = Math.round(Number(original.h));
  const compact = { w: Math.max(1280, w - 720), h: Math.max(900, h - 440) };
  const wide = { w, h: Math.max(900, h - 360) };
  const tall = { w: Math.max(1400, w - 560), h };
  const mid = { w: Math.max(1360, w - 420), h: Math.max(940, h - 260) };
  const originalSize = { w, h };
  return [
    compact, originalSize, wide, tall, compact, mid, originalSize,
    tall, wide, compact, originalSize, mid, compact, originalSize,
  ].map((size) => ({ ...size }));
}

/** 플러그인 command 봉투의 eval 결과를 구현별 포장 차이 없이 페이지 반환값으로 푼다. */
export function unwrapEvalValue(result) {
  if (!result || typeof result !== "object") return result;
  if ("active" in result || "ledger" in result) return result;
  return Object.prototype.hasOwnProperty.call(result, "viewId")
    && Object.prototype.hasOwnProperty.call(result, "value")
    ? result.value
    : result;
}

/**
 * 브라우저 구현 공통 resize 기계 판정.
 *
 * 공개 DOM 슬롯과 페이지가 스스로 보고한 viewport/CSS marker만 비교한다. PNG는 사람이 보는
 * visual evidence이고 이 판정의 입력이 아니다. 슬롯↔viewport는 좌표계 반올림 1px만, fixture의
 * fixed CSS marker는 선언값 그대로여야 한다.
 */
export function viewportGeometryVerdict({ slot, viewport, marker }) {
  const errors = [];
  for (const key of ["w", "h"]) {
    const slotValue = Number(slot?.[key]);
    const viewportValue = Number(viewport?.[key]);
    if (!Number.isFinite(slotValue) || !Number.isFinite(viewportValue)) {
      errors.push(`viewport.${key}=${viewport?.[key]}/slot.${key}=${slot?.[key]}`);
    } else if (Math.abs(slotValue - viewportValue) > 1) {
      errors.push(`viewport.${key}=${viewport[key]}/slot.${key}=${slot[key]}`);
    }
  }
  for (const key of ["width", "height"]) {
    const actual = Number(marker?.[key]);
    const expected = Number(fixtureMarkerSize[key]);
    if (!Number.isFinite(actual) || Math.abs(actual - expected) > 0.01) {
      errors.push(`marker.${key}=${marker?.[key]}/${expected}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** PNG marker 크기는 개발자가 보는 진단값이다. machine gate에 넣지 않는다. */
export function viewportPixelDiagnostic({ markerPixels, marker = fixtureMarkerSize, scale }) {
  const errors = [];
  const expectedWidth = Number(marker.width) * Number(scale);
  const expectedHeight = Number(marker.height) * Number(scale);
  if (!Number.isFinite(Number(markerPixels?.width))
      || Math.abs(Number(markerPixels.width) - expectedWidth) > 4) {
    errors.push(`marker.width=${markerPixels?.width}/${expectedWidth}`);
  }
  if (!Number.isFinite(Number(markerPixels?.height))
      || Math.abs(Number(markerPixels.height) - expectedHeight) > 4) {
    errors.push(`marker.height=${markerPixels?.height}/${expectedHeight}`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * explicit-view full capture의 기계 판정. 파일 내용의 픽셀은 여기서 읽지 않는다.
 */
export function fullCaptureReceiptVerdict({
  requestedViewId,
  outputPath,
  fileBytes,
  before,
  after,
  result,
}) {
  const errors = [];
  if (result?.viewId !== requestedViewId) errors.push(`viewId=${result?.viewId}/${requestedViewId}`);
  if (result?.path !== outputPath) errors.push(`path=${result?.path}/${outputPath}`);
  const receiptBytes = Number(result?.bytes);
  if (!Number.isSafeInteger(receiptBytes) || receiptBytes <= 0 || receiptBytes !== Number(fileBytes)) {
    errors.push(`bytes=${result?.bytes}/${fileBytes}`);
  }
  const compare = (name, actual, expected, tolerance = 0) => {
    const a = Number(actual);
    const e = Number(expected);
    if (!Number.isFinite(a) || !Number.isFinite(e) || Math.abs(a - e) > tolerance) {
      errors.push(`${name}=${actual}/${expected}`);
    }
  };
  compare("width", result?.width, before?.document?.w, 1);
  compare("height", result?.height, before?.document?.h, 1);
  compare("scroll", after?.y, before?.y);
  for (const key of ["w", "h"]) {
    compare(`viewport.${key}`, after?.viewport?.[key], before?.viewport?.[key], 1);
    compare(`document.${key}`, after?.document?.[key], before?.document?.[key], 1);
  }
  if (Number(before?.y) !== 0) errors.push(`before.scroll=${before?.y}/0`);
  if (!(Number(before?.document?.h) > Number(before?.viewport?.h) + 960)) {
    errors.push(`document.scrollable=${before?.document?.h}/${before?.viewport?.h}`);
  }
  return { ok: errors.length === 0, errors };
}

/** WindowServer가 창 전체의 이전 backing을 한 epoch 재투영한 것과 브라우저 표면만의 stretch를
 * 분리한다. 서로 다른 CSS 크기는 고유 크기로 정규화하고, DOM 기준자끼리 먼저 한 epoch인지 판정한다. */
export function transitionFrameAlignment({ browser, dom }) {
  const errors = [];
  const domEpochs = (Array.isArray(dom) ? dom : [dom]).filter(Boolean);
  const scale = (value, intrinsic) => ({
    width: Number(value.width) / Number(intrinsic.width),
    height: Number(value.height) / Number(intrinsic.height),
  });
  const browserScale = scale(browser, fixtureMarkerSize);
  const domScales = domEpochs.map((value) => scale(value, compositorCalibrationSize));
  const dimensions = (value) => `${Number(value.width)}x${Number(value.height)}`;
  const scaleTolerance = 4 / Math.min(fixtureMarkerSize.width, compositorCalibrationSize.width);
  const first = domScales[0];
  const torn = domScales.find((candidate) =>
    Math.abs(Number(candidate.width) - Number(first?.width)) > scaleTolerance
    || Math.abs(Number(candidate.height) - Number(first?.height)) > scaleTolerance);
  if (first && torn) errors.push(`chrome-epoch-tear=${dimensions(first)}/${dimensions(torn)}`);
  const browserMatchesDom = domScales.some((candidate) =>
    Math.abs(browserScale.width - candidate.width) <= scaleTolerance
    && Math.abs(browserScale.height - candidate.height) <= scaleTolerance);
  if (first && !browserMatchesDom) {
    errors.push(`browser-only-stretch=${dimensions(browserScale)}/dom:${dimensions(first)}`);
  }
  return { ok: errors.length === 0, errors };
}

/** 정본 fixture 문서의 제목이자 h1. 신원을 대조하는 쪽이 이 값을 다시 적지 않는다. */
export const FIXTURE_PAGE_TITLE = "Browser Boundary";

/** 세 구현이 같은 문서·같은 입력 사건을 실행하는 정적 fixture. */
export function fixtureHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${FIXTURE_PAGE_TITLE}</title>
    <style>
      html,body{margin:0;min-height:100%;background:#181818;color:#f7f4df;font:24px system-ui}
      main{min-height:100vh;display:grid;place-items:center;background:linear-gradient(135deg,#181818 0 50%,#242424 50%)}
      section{box-sizing:border-box;width:min(520px,100%);padding:16px;border:8px solid #f7f4df;background:#292929;box-shadow:20px 20px 0 #111}
      h1{font-size:48px;margin:0 0 8px}p{margin:0 0 20px}
      label{display:grid;gap:8px;font-size:18px}input{box-sizing:border-box;width:100%;font:28px system-ui;padding:10px 12px;border:4px solid #e0704f;background:#fff;color:#181818}
      #motion-marker{position:fixed;z-index:2147483647;left:0;top:0;width:${fixtureMotionMarkerSize.width}px;height:${fixtureMotionMarkerSize.height}px;background:var(--motion-marker,#00ffff)}
      #lighting-marker{position:fixed;z-index:2147483647;right:8px;top:8px;width:32px;height:32px;background:#ff0000}
      .marker-row{display:flex;gap:8px;margin:0 0 16px}
      .fixture-marker{flex:0 0 auto;width:${fixtureMarkerSize.width}px;height:${fixtureMarkerSize.height}px;background:var(--marker,#ff00ff)}
      #typed-marker{height:24px;margin-top:10px;background:#000}
      #scroll-track{box-sizing:border-box;height:1440px;padding:32px;background:linear-gradient(#123 0 33%,#234 33% 66%,#345 66%);color:#fff}
      #scroll-tail{margin-top:1280px;height:64px;background:#ff8000;color:#181818;font-weight:700}
      output{display:block;min-height:1.4em;margin-top:10px;font-size:18px;color:#f7f4df}
      @media(max-height:520px){h1{font-size:36px}p{font-size:20px;margin-bottom:10px}label{gap:4px}input{font-size:24px;padding:6px 8px}.marker-row{margin-bottom:10px}output{margin-top:4px}#typed-marker{margin-top:4px}}
    </style></head><body>
    <div id="motion-marker"></div><div id="lighting-marker"></div><main><section><h1>${FIXTURE_PAGE_TITLE}</h1><p>DOM slot ↔ live browser surface</p><div class="marker-row"><div id="marker" class="fixture-marker"></div><div class="fixture-marker"></div><div class="fixture-marker"></div></div>
      <label>IME input<input id="ime" autocomplete="off" spellcheck="false"></label>
      <output id="events">beforeinput:0 input:0</output><div id="typed-marker"></div>
    </section></main><div id="scroll-track">wheel input track<div id="scroll-tail">full-page tail</div></div>
    <script>
      window.__browserFixture = { beforeInput: 0, inputEvents: 0, values: [] };
      const slot = Number(new URLSearchParams(location.search).get("slot") || 0);
      document.documentElement.dataset.slot = String(slot);
      document.documentElement.style.setProperty("--marker", ${JSON.stringify(fixtureMarkers)}[slot] || ${JSON.stringify(fixtureMarkers)}[0]);
      document.documentElement.style.setProperty("--motion-marker", ${JSON.stringify(fixtureMotionMarkers)}[slot] || ${JSON.stringify(fixtureMotionMarkers)}[0]);
      const ime = document.getElementById("ime");
      const events = document.getElementById("events");
      const typedMarker = document.getElementById("typed-marker");
      const render = () => { events.textContent = "beforeinput:" + window.__browserFixture.beforeInput + " input:" + window.__browserFixture.inputEvents; };
      let scrollEvents = 0;
      const recordScroll = () => {
        scrollEvents += 1;
        document.documentElement.dataset.scrollY = String(Math.round(scrollY));
        document.documentElement.dataset.scrollSeq = String(scrollEvents);
      };
      document.documentElement.dataset.scrollY = "0";
      document.documentElement.dataset.scrollSeq = "0";
      addEventListener("scroll", recordScroll, { passive: true });
      ime.addEventListener("beforeinput", () => { window.__browserFixture.beforeInput += 1; render(); });
      ime.addEventListener("input", () => { window.__browserFixture.inputEvents += 1; window.__browserFixture.values.push(ime.value); typedMarker.style.background=${JSON.stringify(fixtureInputMarkers)}[slot]; render(); });
    </script></body></html>`;
}
