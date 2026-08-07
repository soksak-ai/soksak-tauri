import fs from "node:fs";
import path from "node:path";
import { decodePng } from "./png.mjs";
import {
  calibrationFrameScale,
  completeCalibrationComponents,
  compositorCalibrationMarker,
  fixtureInputMarkerSize,
  fixtureInputMarkers,
  fixtureMarkerRowVerdict,
  fixtureMarkerSize,
  fixtureMarkers,
  fixtureMotionMarkers,
  markerEvidence,
  motionMarkerAlignment,
  selectFixtureMarkerComponent,
  snapshotCssScale,
  summarizeFrameSequence,
  transitionFrameAlignment,
  viewportPixelDiagnostic,
} from "./browser-matrix.mjs";
import { capturedScaleObservation, displayScaleFact, usableFrameScale } from "./surface-scale.mjs";

const MARKER_SAMPLE_STEP = 2;
const MIN_MARKER_HEIGHT = 16;
const MIN_MARKER_COMPONENT = 200;

const messageOf = (error) => error instanceof Error ? error.message : String(error);

/**
 * 이 실행의 배율 사실과, 캡처에서 다시 잰 사본을 맞대 본 진단.
 *
 * `scale`은 언제나 창이 말한 사실이다. PNG 좌표계 산출이 실패해도 그 자리를 1로 메우지 않는다 —
 * 예전에는 메웠고, 그 1이 `windowedSurfaceCompositionVerdict`의 반올림 기준까지 흘러가
 * 캡처가 실패할수록 기계 판정이 느슨해졌다.
 *
 * 창이 배율을 말하지 않으면 그것은 **측정 불가**다. 진단으로 돌리지 않고 던진다.
 */
export function snapshotScaleForVisualEvidence(file, windowInfo) {
  const scale = displayScaleFact(windowInfo);
  const errors = [];
  let capturedScale = null;
  try {
    capturedScale = snapshotCssScale(fs.readFileSync(file), windowInfo);
  } catch (error) {
    errors.push(messageOf(error));
  }
  const observation = capturedScaleObservation(scale, capturedScale);
  if (observation.error) errors.push(observation.error);
  return {
    kind: "human-visual-evidence",
    automatedVerdict: false,
    scale,
    capturedScale: observation.captured,
    errors,
  };
}

function inspectFixtureMarkers(bytes, name, scale, {
  requireInput = true,
  compareDomEpoch = false,
  slots = [0, 1],
} = {}) {
  const domEvidence = compareDomEpoch
    ? completeCalibrationComponents(markerEvidence(bytes, compositorCalibrationMarker, 24, MARKER_SAMPLE_STEP)
      .components.filter((component) => component.count >= MIN_MARKER_COMPONENT
        && component.width >= 40 && component.height >= MIN_MARKER_HEIGHT))
    : null;
  if (compareDomEpoch && !domEvidence.length) {
    throw new Error(`${name}: DOM compositor calibration 소실(${JSON.stringify(domEvidence)})`);
  }
  const frameScale = compareDomEpoch
    ? calibrationFrameScale(domEvidence) ?? scale
    : scale;
  const kinds = [["page", fixtureMarkers]];
  if (requireInput) kinds.push(["input", fixtureInputMarkers]);
  for (const [kind, markers] of kinds) {
    for (const slot of slots) {
      const expectedWidth = (kind === "input" ? fixtureInputMarkerSize.minWidth : fixtureMarkerSize.width)
        * frameScale;
      const expectedHeight = (kind === "input" ? fixtureInputMarkerSize.height : fixtureMarkerSize.height)
        * frameScale;
      const raw = markerEvidence(bytes, markers[slot], 24, MARKER_SAMPLE_STEP);
      const selected = selectFixtureMarkerComponent(raw.components, {
        expectedWidth,
        expectedHeight,
        minWidth: kind === "input",
        tolerance: 4,
        minCount: MIN_MARKER_COMPONENT,
      });
      if (!selected) {
        throw new Error(`${name}: slot ${slot} ${kind} marker 소실(${JSON.stringify(raw.largest)})`);
      }
      const evidence = { ...selected, width: selected.bodyWidth, height: selected.bodyHeight };
      if (kind === "page" && compareDomEpoch) {
        const aligned = transitionFrameAlignment({ browser: evidence, dom: domEvidence });
        if (!aligned.ok) throw new Error(`${name}: compositor epoch 불일치 — ${aligned.errors.join(", ")}`);
      } else if (kind === "page" && scale) {
        const aligned = viewportPixelDiagnostic({
          marker: fixtureMarkerSize,
          markerPixels: evidence,
          scale: frameScale,
        });
        if (!aligned.ok) throw new Error(`${name}: slot ${slot} stale-frame stretch — ${aligned.errors.join(", ")}`);
      }
    }
  }
  return frameScale;
}

function inspectMotion(bytes, name, scale, presentationMarkers = []) {
  for (let slot = 0; slot < fixtureMotionMarkers.length; slot += 1) {
    const verdict = motionMarkerAlignment(bytes, fixtureMotionMarkers[slot], scale);
    if (!verdict.ok) {
      throw new Error(`${name}: slot ${slot} DOM/surface 궤적 불일치 — ${verdict.errors.join(", ")}`);
    }
    const expected = 12 * scale;
    const motion = markerEvidence(bytes, fixtureMotionMarkers[slot], 16, 1).components.filter((component) =>
      Math.abs(component.width - expected) <= 4 && Math.abs(component.height - expected) <= 4);
    const renderer = markerEvidence(bytes, presentationMarkers[slot], 16, 1).components.filter((component) =>
      Math.abs(component.width - expected) <= 4 && Math.abs(component.height - expected) <= 4);
    if (renderer.length !== 1) throw new Error(`${name}: slot ${slot} plugin renderer 기준자 ${renderer.length}/1`);
    const rendererX = renderer[0].x - 16 * scale;
    const split = motion.filter((component) => Math.abs(component.x - rendererX) > 4);
    if (split.length) {
      throw new Error(
        `${name}: slot ${slot} projection/renderer/page 삼자 불일치 — renderer-x=${rendererX} motion-x=${motion.map((item) => item.x).join("/")}`,
      );
    }
  }
}

function inspectAnchor(bytes, name, color, scale, point) {
  const expected = 12 * scale;
  const components = markerEvidence(bytes, color, 16, 1).components.filter((component) => {
    if (Math.abs(component.width - expected) > 4 || Math.abs(component.height - expected) > 4) return false;
    if (!point) return true;
    return Math.abs(component.x - point.x * scale) <= 4
      && Math.abs(component.y - point.y * scale) <= 4;
  });
  if (!components.length) throw new Error(`${name}: visual anchor ${color} 소실`);
}

/**
 * 녹화/스크린샷을 사람이 검토할 진단으로 변환한다. 오류를 수집할 뿐 machine gate를 던지지 않는다.
 */
export function observeFrameSequence(files, name, scale, options = {}) {
  const frames = files.map((file) => {
    const errors = [];
    let motionDx = 0;
    try {
      // 쓸 수 없는 배율로 기대 기하를 만들면 0과 NaN이 되어 "마커 소실"이라는 엉뚱한 이름으로
      // 샌다. 배율을 잃었다는 사실은 그 이름으로 남긴다.
      if (!usableFrameScale(scale)) {
        errors.push(`frame scale이 쓸 수 없는 값이다: ${JSON.stringify(scale)}`);
      }
      const bytes = fs.readFileSync(file);
      let frameScale = scale;
      if (options.requireFixture !== false) {
        try { frameScale = inspectFixtureMarkers(bytes, path.join(name, path.basename(file)), scale, options); }
        catch (error) { errors.push(messageOf(error)); }
      }
      if (options.motion) {
        try { inspectMotion(bytes, path.join(name, path.basename(file)), scale, options.presentationMarkers); }
        catch (error) { errors.push(messageOf(error)); }
        for (const color of fixtureMotionMarkers) {
          const verdict = motionMarkerAlignment(bytes, color, scale);
          if (Number.isFinite(verdict.dx)) motionDx = Math.max(motionDx, verdict.dx);
        }
      }
      for (const color of options.chromeAnchors ?? []) {
        try { inspectAnchor(bytes, path.join(name, path.basename(file)), color, frameScale); }
        catch (error) { errors.push(messageOf(error)); }
      }
      for (const probe of options.pointAnchors ?? []) {
        try { inspectAnchor(bytes, path.join(name, path.basename(file)), probe.color, frameScale, probe.point); }
        catch (error) { errors.push(messageOf(error)); }
      }
    } catch (error) {
      errors.push(messageOf(error));
    }
    return { frame: path.basename(file), errors, motionDx };
  });
  const summary = summarizeFrameSequence(frames);
  return {
    kind: "human-visual-evidence",
    automatedVerdict: false,
    name,
    frames,
    ...summary,
  };
}

/** full PNG의 문서 꼬리/단일 identity는 사람이 확인할 시각 진단일 뿐 machine gate가 아니다. */
export function observeFullCapture(file, name, { identityMarker, receipt } = {}) {
  const errors = [];
  let image = null;
  try {
    const bytes = fs.readFileSync(file);
    const decoded = decodePng(bytes);
    const width = Number(receipt?.width);
    const height = Number(receipt?.height);
    const xScale = decoded.w / width;
    const yScale = decoded.h / height;
    const tail = markerEvidence(bytes, "#ff8000", 24, 2).components
      .find((component) => component.width >= 100 && component.height >= 40
        && component.y >= decoded.h * 0.75);
    const identity = fixtureMarkerRowVerdict(markerEvidence(bytes, identityMarker, 24, 1).components, {
      scale: (xScale + yScale) / 2,
    });
    image = { w: decoded.w, h: decoded.h, xScale, yScale, tail: Boolean(tail), identity };
    if (!(decoded.h > decoded.w && Math.abs(xScale - yScale) <= 0.03 && tail && identity.ok)) {
      errors.push(`full capture visual mismatch: ${JSON.stringify(image)}`);
    }
  } catch (error) {
    errors.push(messageOf(error));
  }
  return {
    kind: "human-visual-evidence",
    automatedVerdict: false,
    name,
    errors,
    image,
  };
}
