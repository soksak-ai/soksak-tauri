import {
  displayValue,
  finishMachineVerdict,
  hasText,
  isRecord,
  notRunVerdict,
  requireEvidenceEnvelope,
  requireExactKeys,
  requireUniqueViewId,
} from "./browser-machine-judge-support.mjs";

// B11이 요구하는 페이지 축의 정본. probe와 mapper는 이 목록에서 파생한다 —
// 손으로 다시 나열하면 반드시 하나가 빠진다.
export const B11_PAGE_KEYS = Object.freeze([
  "scrollX",
  "scrollY",
  "viewportWidth",
  "viewportHeight",
  "documentWidth",
  "documentHeight",
]);

/** pane 폭 왕복의 세 순간. 이름은 하니스가 측정한 순서 그대로다. */
export const B11_PANE_STAGES = Object.freeze(["baseline", "wider", "restored"]);

/** 한 순간에 함께 읽어야 하는 축. 따로 재면 하나가 제자리에 남은 사실이 다른 값에 가린다. */
export const B11_PANE_STAGE_KEYS = Object.freeze([
  "settledAtUnixMs",
  "paneX",
  "paneWidth",
  "surfaceX",
  "surfaceWidth",
  "viewportWidth",
]);

export const B11_WHEEL_LEDGER_STAGES = Object.freeze(["before", "after", "restored"]);

export const B11_WHEEL_LEDGER_KEYS = Object.freeze(["scrollSeq", "wheelEvents", "wheelDeltaY"]);

export const B11_CAPTURE_RECEIPT_KEYS = Object.freeze([
  "requestedViewId",
  "returnedViewId",
  "requestedPath",
  "returnedPath",
  "reportedBytes",
  "fileBytes",
  "width",
  "docHeight",
  "capturedWidth",
  "capturedHeight",
]);

const PANE_DELTA_AXES = Object.freeze([
  "paneX",
  "paneWidth",
  "surfaceX",
  "surfaceWidth",
  "viewportWidth",
]);

// gutter를 dx만큼 오른쪽으로 끌면 왼쪽 pane은 x를 지키며 dx만큼 넓어지고, 오른쪽 pane은
// x가 dx만큼 밀리며 dx만큼 좁아진다. 그 pane 위의 native surface와 그 안의 문서 뷰포트는
// 자기 pane을 따라간다 — 하나라도 제자리에 남으면 pane resize가 표면까지 닿지 않은 것이다.
const PANE_WIDER_FACTORS = Object.freeze({
  left: Object.freeze({ paneX: 0, paneWidth: 1, surfaceX: 0, surfaceWidth: 1, viewportWidth: 1 }),
  right: Object.freeze({ paneX: 1, paneWidth: -1, surfaceX: 1, surfaceWidth: -1, viewportWidth: -1 }),
});

const PANE_DELTA_TOLERANCE = 1;
const CAPTURE_SCALE_TOLERANCE = 0.01;
const WHEEL_POSITIONS = Object.freeze([0, 480, 0]);
const WHEEL_REQUESTED_DY = Object.freeze([480, -480]);

function sameNumbers(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && expected.every((item, index) => value[index] === item);
}

function inspectB11Page(page, path, failures) {
  if (!requireExactKeys(page, B11_PAGE_KEYS, path, failures)) return;
  for (const field of B11_PAGE_KEYS) {
    const value = page[field];
    const positive = !field.startsWith("scroll");
    if (!Number.isFinite(value) || (positive ? value <= 0 : value < 0)) {
      failures.push(`${path}.${field}=${positive ? "finite>0" : "finite>=0"}/${displayValue(value)}`);
    }
  }
}

/**
 * 휠 사건 원장. 좌표만 보면 프로그램으로 옮긴 스크롤과 휠이 옮긴 스크롤이 같은 값을 만든다.
 * 구간마다 실제 wheel/scroll 사건이 새로 나야 하고 누적 델타의 방향이 요청과 같아야 한다.
 */
function inspectWheelLedger(ledger, path, failures) {
  if (!requireExactKeys(ledger, B11_WHEEL_LEDGER_STAGES, path, failures)) return;
  const read = {};
  for (const stage of B11_WHEEL_LEDGER_STAGES) {
    const at = `${path}.${stage}`;
    if (!requireExactKeys(ledger[stage], B11_WHEEL_LEDGER_KEYS, at, failures)) return;
    const counts = {};
    for (const key of B11_WHEEL_LEDGER_KEYS) {
      const value = ledger[stage][key];
      const ok = key === "wheelDeltaY"
        ? Number.isFinite(value)
        : Number.isInteger(value) && value >= 0;
      if (ok) counts[key] = value;
      else failures.push(`${at}.${key}=${key === "wheelDeltaY" ? "finite" : "integer>=0"}/${displayValue(value)}`);
    }
    read[stage] = counts;
  }
  for (const [from, to, forward] of [["before", "after", true], ["after", "restored", false]]) {
    const start = read[from];
    const end = read[to];
    for (const key of ["scrollSeq", "wheelEvents"]) {
      if (Number.isFinite(start?.[key]) && Number.isFinite(end?.[key]) && end[key] <= start[key]) {
        failures.push(`${path}.${to}.${key}=greater-than-${from}/${displayValue({ [from]: start[key], [to]: end[key] })}`);
      }
    }
    if (Number.isFinite(start?.wheelDeltaY) && Number.isFinite(end?.wheelDeltaY)) {
      const delta = end.wheelDeltaY - start.wheelDeltaY;
      if (forward ? !(delta > 0) : !(delta < 0)) {
        failures.push(`${path}.${to}.wheelDeltaY=${forward ? "forward" : "backward"}/${displayValue(delta)}`);
      }
    }
  }
}

/** @returns 이 반쪽을 측정한 layout settle epoch(못 읽으면 null). */
function inspectWheel(wheel, path, failures) {
  if (!requireExactKeys(wheel, ["positions", "requestedDy", "ledger", "settledAtUnixMs"], path, failures)) {
    return null;
  }
  const positions = wheel.positions;
  const requested = wheel.requestedDy;
  const validPositions = sameNumbers(positions, WHEEL_POSITIONS);
  const validRequest = sameNumbers(requested, WHEEL_REQUESTED_DY);
  if (!validPositions) {
    failures.push(`${path}.positions=${WHEEL_POSITIONS.join(",")}/${displayValue(positions)}`);
  }
  if (!validRequest) {
    failures.push(`${path}.requestedDy=${WHEEL_REQUESTED_DY.join(",")}/${displayValue(requested)}`);
  }
  if (validPositions && validRequest) {
    // 요청한 델타와 관측한 이동량을 맞댄다. 한쪽만 적으면 영수증이 자기 입력을 되돌려준다.
    [[positions[1] - positions[0], requested[0]], [positions[2] - positions[1], requested[1]]]
      .forEach(([observed, request], leg) => {
        if (observed !== request) {
          failures.push(`${path}.leg[${leg}]=${displayValue(request)}/${displayValue(observed)}`);
        }
      });
  }
  inspectWheelLedger(wheel.ledger, `${path}.ledger`, failures);
  const settledAt = wheel.settledAtUnixMs;
  if (!Number.isFinite(settledAt) || settledAt <= 0) {
    failures.push(`${path}.settledAtUnixMs=finite>0/${displayValue(settledAt)}`);
    return null;
  }
  return settledAt;
}

/**
 * 산출물이 문서 전체를 담았는지는 산출물 자신의 크기로만 답한다. 요청에 쓴 문서 크기를
 * 되돌려준 영수증과 하니스가 같은 식으로 읽은 문서 크기를 맞대면 순환이다.
 *
 * IHDR 정수는 픽셀을 푼 값이 아니라 파일이 스스로 밝힌 크기다. 마커·색·성분 같은 픽셀 판정은
 * 여전히 기계 입력이 아니고 사람의 시각 검토가 소유한다.
 *
 * 배율은 파이프라인마다 다르다(WebKit PDF는 1x, Electron 타일 합성은 device pixel).
 * 그래서 절대 크기가 아니라 두 축의 배율이 같은지와 문서를 줄이지 않았는지를 요구한다.
 */
function inspectCapturedImage(receipt, page, path, failures) {
  const width = receipt.capturedWidth;
  const height = receipt.capturedHeight;
  const documentWidth = page.documentWidth;
  const documentHeight = page.documentHeight;
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) return;
  if (!(documentWidth > 0) || !(documentHeight > 0)) return;
  const xScale = width / documentWidth;
  const yScale = height / documentHeight;
  if (Math.abs(xScale - yScale) > CAPTURE_SCALE_TOLERANCE) {
    failures.push(`${path}.captured=uniform-scale/${displayValue({ xScale, yScale })}`);
  }
  if (width + 1 < documentWidth || height + 1 < documentHeight) {
    failures.push(`${path}.captured=covers-document/${displayValue({
      captured: { width, height },
      document: { width: documentWidth, height: documentHeight },
    })}`);
  }
}

function inspectCapture(capture, path, viewId, failures) {
  if (!requireExactKeys(capture, ["before", "receipt", "after"], path, failures)) return;
  inspectB11Page(capture.before, `${path}.before`, failures);
  inspectB11Page(capture.after, `${path}.after`, failures);
  if (isRecord(capture.before) && isRecord(capture.after)) {
    for (const field of B11_PAGE_KEYS) {
      if (capture.before[field] !== capture.after[field]) {
        failures.push(`${path}.${field}=preserved/${displayValue({
          before: capture.before[field],
          after: capture.after[field],
        })}`);
      }
    }
    if (capture.before.scrollY !== 0) {
      failures.push(`${path}.before.scrollY=0/${displayValue(capture.before.scrollY)}`);
    }
  }

  const receiptPath = `${path}.receipt`;
  const receipt = capture.receipt;
  if (!requireExactKeys(receipt, B11_CAPTURE_RECEIPT_KEYS, receiptPath, failures)) return;
  if (receipt.requestedViewId !== viewId || receipt.returnedViewId !== viewId) {
    failures.push(`${receiptPath}.viewId=${displayValue(viewId)}/${displayValue({
      requested: receipt.requestedViewId,
      returned: receipt.returnedViewId,
    })}`);
  }
  if (!hasText(receipt.requestedPath) || receipt.returnedPath !== receipt.requestedPath) {
    failures.push(`${receiptPath}.path=exact/${displayValue({
      requested: receipt.requestedPath,
      returned: receipt.returnedPath,
    })}`);
  }
  for (const field of ["reportedBytes", "fileBytes", "width", "docHeight", "capturedWidth", "capturedHeight"]) {
    if (!Number.isInteger(receipt[field]) || receipt[field] <= 0) {
      failures.push(`${receiptPath}.${field}=integer>0/${displayValue(receipt[field])}`);
    }
  }
  if (receipt.reportedBytes !== receipt.fileBytes) {
    failures.push(`${receiptPath}.bytes=exact/${displayValue({
      reported: receipt.reportedBytes,
      file: receipt.fileBytes,
    })}`);
  }
  if (!isRecord(capture.before)) return;
  if (receipt.width !== capture.before.documentWidth) {
    failures.push(`${receiptPath}.width=documentWidth/${displayValue({
      receipt: receipt.width,
      document: capture.before.documentWidth,
    })}`);
  }
  if (receipt.docHeight !== capture.before.documentHeight) {
    failures.push(`${receiptPath}.docHeight=documentHeight/${displayValue({
      receipt: receipt.docHeight,
      document: capture.before.documentHeight,
    })}`);
  }
  if (!(capture.before.documentHeight > capture.before.viewportHeight + 960)) {
    failures.push(`${path}.document=scrollable/${displayValue({
      documentHeight: capture.before.documentHeight,
      viewportHeight: capture.before.viewportHeight,
    })}`);
  }
  inspectCapturedImage(receipt, capture.before, receiptPath, failures);
}

/** @returns {{side:string,baselinePaneX:number|null}|null} 교차 검사에 쓸 이 탭의 pane 신원. */
function inspectPaneResize(paneResize, path, wheelSettledAtUnixMs, failures) {
  if (!requireExactKeys(paneResize, ["paneId", "side", "requestedDx", "stages"], path, failures)) {
    return null;
  }
  if (!hasText(paneResize.paneId)) {
    failures.push(`${path}.paneId=non-empty/${displayValue(paneResize.paneId)}`);
  }
  const side = paneResize.side === "left" || paneResize.side === "right" ? paneResize.side : null;
  if (side === null) failures.push(`${path}.side=left|right/${displayValue(paneResize.side)}`);
  const dx = paneResize.requestedDx;
  if (!Number.isFinite(dx) || Math.abs(dx) < 1) {
    failures.push(`${path}.requestedDx=finite,abs>=1/${displayValue(dx)}`);
  }
  if (!requireExactKeys(paneResize.stages, B11_PANE_STAGES, `${path}.stages`, failures)) return null;

  const stages = {};
  for (const name of B11_PANE_STAGES) {
    const at = `${path}.stages.${name}`;
    if (!requireExactKeys(paneResize.stages[name], B11_PANE_STAGE_KEYS, at, failures)) return null;
    const read = {};
    for (const key of B11_PANE_STAGE_KEYS) {
      const value = paneResize.stages[name][key];
      const positive = key !== "paneX" && key !== "surfaceX";
      if (Number.isFinite(value) && (positive ? value > 0 : true)) read[key] = value;
      else failures.push(`${at}.${key}=${positive ? "finite>0" : "finite"}/${displayValue(value)}`);
    }
    stages[name] = read;
  }

  // 세 stage는 서로 다른 순간이고, 그 앞에 wheel/full capture 반쪽이 따로 있었다.
  // 같은 epoch로 뭉개면 보고서를 읽는 사람이 두 사건을 하나로 읽는다.
  for (let index = 1; index < B11_PANE_STAGES.length; index += 1) {
    const previous = stages[B11_PANE_STAGES[index - 1]].settledAtUnixMs;
    const current = stages[B11_PANE_STAGES[index]].settledAtUnixMs;
    if (Number.isFinite(previous) && Number.isFinite(current) && !(current > previous)) {
      failures.push(`${path}.stages.${B11_PANE_STAGES[index]}.settledAtUnixMs=after-${B11_PANE_STAGES[index - 1]}/${displayValue({ previous, current })}`);
    }
  }
  const baselineEpoch = stages.baseline.settledAtUnixMs;
  if (Number.isFinite(wheelSettledAtUnixMs) && Number.isFinite(baselineEpoch)
      && !(baselineEpoch > wheelSettledAtUnixMs)) {
    failures.push(`${path}.stages.baseline.settledAtUnixMs=after-wheel/${displayValue({
      wheel: wheelSettledAtUnixMs,
      baseline: baselineEpoch,
    })}`);
  }

  if (side !== null && Number.isFinite(dx)) {
    const factors = PANE_WIDER_FACTORS[side];
    for (const axis of PANE_DELTA_AXES) {
      const baseline = stages.baseline[axis];
      const wider = stages.wider[axis];
      const restored = stages.restored[axis];
      if (![baseline, wider, restored].every((value) => Number.isFinite(value))) continue;
      const expected = factors[axis] * dx;
      if (Math.abs((wider - baseline) - expected) > PANE_DELTA_TOLERANCE) {
        failures.push(`${path}.wider.${axis}=${displayValue(expected)}/${displayValue(wider - baseline)}`);
      }
      if (Math.abs(restored - baseline) > PANE_DELTA_TOLERANCE) {
        failures.push(`${path}.restored.${axis}=0/${displayValue(restored - baseline)}`);
      }
    }
  }
  return side === null ? null : { side, baselinePaneX: stages.baseline.paneX ?? null };
}

/** 한 gutter를 끈 사실이므로 두 pane은 서로 반대편이고, 선언한 side는 실측 좌표와 맞아야 한다. */
function inspectPaneSides(panes, failures) {
  if (panes.length !== 2) return;
  const left = panes.filter((pane) => pane.side === "left");
  const right = panes.filter((pane) => pane.side === "right");
  if (left.length !== 1 || right.length !== 1) {
    failures.push(`paneResize.sides=left+right/${displayValue(panes.map((pane) => pane.side))}`);
    return;
  }
  if (Number.isFinite(left[0].baselinePaneX) && Number.isFinite(right[0].baselinePaneX)
      && !(left[0].baselinePaneX < right[0].baselinePaneX)) {
    failures.push(`paneResize.side=measured-order/${displayValue({
      left: left[0].baselinePaneX,
      right: right[0].baselinePaneX,
    })}`);
  }
}

/**
 * B11은 게이트 이름의 세 축을 모두 수치로 요구한다: pane 폭 왕복이 표면과 문서까지 닿았는가,
 * 휠이 실제 사건으로 스크롤을 옮기고 되돌렸는가, 명시한 탭의 full capture 산출물이 문서
 * 전체를 담았는가. PNG 마커·디코드 픽셀·사람의 시각 판정은 입력으로 받지 않는다.
 */
export function judgeB11MachineEvidence(value) {
  if (value == null) return notRunVerdict();
  const failures = [];
  if (!requireExactKeys(value, ["engine", "tabs", "viewportComposition"], "evidence", failures)) {
    return finishMachineVerdict("B11", failures, "B11:unreachable");
  }
  if (!requireEvidenceEnvelope(value, failures)) {
    return finishMachineVerdict("B11", failures, "B11:unreachable");
  }
  if (value.tabs.length !== 2) failures.push(`tabs.length=2/${value.tabs.length}`);
  const seen = new Set();
  const panes = [];
  value.tabs.forEach((tab, index) => {
    const path = `tabs[${index}]`;
    if (!requireExactKeys(tab, ["viewId", "wheel", "capture", "paneResize"], path, failures)) return;
    const viewId = requireUniqueViewId(tab, path, seen, failures);
    const wheelSettledAtUnixMs = inspectWheel(tab.wheel, `${path}.wheel`, failures);
    inspectCapture(tab.capture, `${path}.capture`, viewId, failures);
    const pane = inspectPaneResize(tab.paneResize, `${path}.paneResize`, wheelSettledAtUnixMs, failures);
    if (pane !== null) panes.push(pane);
  });
  inspectPaneSides(panes, failures);
  // 잰 어긋남은 그 칸의 사실이다 — 하니스가 던지면 나머지 칸까지 함께 사라진다.
  if (!Array.isArray(value.viewportComposition)) {
    failures.push(`viewportComposition=names/${displayValue(value.viewportComposition)}`);
  } else {
    for (const row of value.viewportComposition) failures.push(`viewportComposition:${row}`);
  }

  return finishMachineVerdict(
    "B11",
    failures,
    `${value.engine}/B11:tabs=2;wheel=0,480,0+events;pane-resize=both-sides;full-capture=measured`,
  );
}
