// 화면 캡처 — registerCatalog() 말미에서 등록(catalog 분할 — catalogHealth 선례).
//
// 자르기(rect·node)와 저장(path·base64)은 **서로 다른 축**이라 자유롭게 조합된다. 여태 자르면
// path 를 통째로 무시하고 base64 만 답했다: 부른 쪽은 ok:true 를 받고 파일은 없었다(실측
// 2026-07-31). 조용한 무시라 어디서 어긋났는지 밖에서 읽을 수 없었다.

import { invoke, frameworkPath } from "../framework";
import { tmsg } from "../i18n";
import { settleAnimationsForCapture } from "./captureSettle";
import { contentViewHost, hasContentViewHost } from "../lib/contentViews";
import { isLayoutMotionActive, onLayoutMotion } from "../lib/layoutMotion";
import { resolveExposed } from "./catalogDom";
import { surfaceRectOf } from "../lib/surfaceRect";
import { register } from "./registry";
import { formatAddress } from "./address";
import { currentWindowLabel } from "../lib/webviewLabels";
import { locateTab } from "./catalog";
import { useSessions } from "../state/sessions";
import {
  recordWindowFrames,
  readWindowRecordingSession,
  startWindowRecordingSession,
  validWindowRecordFrameTimeoutMs,
  validWindowRecordFrames,
  validWindowRecordIntervalMs,
  validWindowRecordMaxBytes,
  WINDOW_RECORD_DEFAULT_FRAME_TIMEOUT_MS,
  WINDOW_RECORD_MAX_FRAMES,
  WINDOW_RECORD_MAX_FRAME_TIMEOUT_MS,
  WINDOW_RECORD_MAX_INTERVAL_MS,
  WINDOW_RECORD_MAX_BYTES,
} from "./windowRecorder";
import { CAPTURE_CALIBRATION_ID, setCaptureCalibration } from "./captureCalibration";
import { setCaptureMotionAnchors } from "./captureMotionAnchors";

/**
 * 탭의 본문 슬롯 절대 주소 — GroupArea 가 `layout/tab/<viewId>` 로 노출한다(그 자리와 한 벌).
 *
 * 상대 주소로는 못 찾는다: 주소는 창·프로젝트를 포함한 절대 형태가 정본이고(공리 A1),
 * 조립은 formatAddress 한 곳이 한다 — 손으로 이어 붙이면 규칙이 두 벌이 된다.
 */
function nodeOfTab(projectId: string, viewId: string): string {
  return formatAddress({
    window: currentWindowLabel(),
    project: projectId,
    chrome: `layout/tab/${viewId}`,
  });
}

/**
 * 레이아웃 모션이 끝날 때까지 — 사건이 끝을 말한다.
 *
 * 이미 정지해 있으면 즉시 답한다(멱등). 도는 중이면 종료 통지 한 번을 기다린다.
 */
function settledLayout(): Promise<void> {
  if (!isLayoutMotionActive()) return Promise.resolve();
  return new Promise((resolve) => {
    const off = onLayoutMotion((active) => {
      if (active) return;
      off();
      resolve();
    });
  });
}

/**
 * "보여야 할 최종 프레임"과 "지금 이 순간"은 다른 요구다.
 *
 * 기본은 정착이다 — 명령을 받으면 상태 불문 정확한 결과를 내야 한다. 그런데 정착은 진행 중인
 * 유한 애니메이션을 끝으로 보내므로, **전이 중에만 어긋나는 것**은 이 경로로 영영 볼 수 없다
 * (실사고 2026-08-02: 여러 층이 서로 다른 프레임에 따라붙는 어긋남을 앱 캡처로 재는데 전부
 * 정착 뒤 그림만 나와 "정상"으로 읽혔다).
 */
const SETTLE_PARAM = {
  type: "boolean" as const,
  description:
    "Finish in-flight finite animations before capturing (default true — a command must yield the frame that should be showing). Pass false to capture the CURRENT instant instead: required to see mismatches that exist only mid-transition, because settling ends them.",
};

/**
 * 칠해진 픽셀의 통계 — 그림이 아니라 숫자.
 *
 * 넓은 영역을 전부 읽지 않는다: 표본이 충분하면 평균은 안 흔들리고, 전수는 그저 느리다.
 * 격자로 고르게 훑는다(무작위 금지 — 같은 화면은 같은 답이어야 한다).
 *
 * 휘도는 **표시값 기준**이다(감마 해제 안 함). 여기서 답할 질문이 "사람 눈에 얼마나 어두워
 * 보이나"이고, 검은 베일 alpha a 는 표시값에 (1 − a) 를 곱하므로 이 축에서 정확히 읽힌다.
 */
async function pixelStats(pngBase64: string): Promise<{
  w: number;
  h: number;
  samples: number;
  mean: { r: number; g: number; b: number };
  luminance: number;
  min: number;
  max: number;
}> {
  const img = new Image();
  img.src = `data:image/png;base64,${pngBase64}`;
  await img.decode();
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2d 컨텍스트를 못 얻었다 — 픽셀을 읽을 수 없다");
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, w, h);
  // 표본 상한 — 격자 간격은 넓이에서 나온다(값이 아니라 규칙).
  const MAX_SAMPLES = 200_000;
  const step = Math.max(1, Math.ceil(Math.sqrt((w * h) / MAX_SAMPLES)));
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let n = 0;
  let min = 1;
  let max = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      sr += r;
      sg += g;
      sb += b;
      n += 1;
      const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      if (l < min) min = l;
      if (l > max) max = l;
    }
  }
  const round = (v: number) => Math.round(v * 1000) / 1000;
  const mean = { r: Math.round(sr / n), g: Math.round(sg / n), b: Math.round(sb / n) };
  return {
    w,
    h,
    samples: n,
    mean,
    luminance: round((0.2126 * mean.r + 0.7152 * mean.g + 0.0722 * mean.b) / 255),
    min: round(min),
    max: round(max),
  };
}

/** 자른 자리와 되돌릴 일 — 자르기 축의 답. */
type Region = {
  rect?: { x: number; y: number; w: number; h: number };
  tabId?: string;
  restore: (() => void) | null;
};

type Refusal = { ok: false; code: string; message: string };

const isRefusal = (v: Region | Refusal): v is Refusal => "ok" in v;

/**
 * 자르기 축을 해소한다 — rect(좌표) · node(주소) · tab(탭 이름) 셋이 같은 답으로 모인다.
 *
 * 이 자리가 한 곳이어야 한다: 픽셀을 찍는 명령과 픽셀을 재는 명령이 각자 해소하면, 같은
 * 주소가 두 자리를 답하는 날이 온다. 되돌릴 일(restore)도 답의 일부다 — 관측은 변경이
 * 아니므로, 활성화해서 찍었으면 원래 활성이던 것을 되돌린다.
 */
async function resolveRegion(p: Record<string, unknown>): Promise<Region | Refusal> {
  let rect = p.rect as { x: number; y: number; w: number; h: number } | undefined;
  let restore: (() => void) | null = null;
  let tabId: string | undefined;
  let nodeAddr = p.node as string | undefined;
  if (typeof p.tab === "string" && p.tab) {
    const loc = locateTab(p.tab);
    if (!loc || !loc.tab) {
      return { ok: false, code: "TARGET_NOT_FOUND", message: `탭 없음: ${p.tab}` };
    }
    const st = useSessions.getState();
    const prevSpace = loc.project.activeSpaceId;
    const prevView = loc.pane.activeTabId;
    if (prevSpace !== loc.space.id || prevView !== loc.tab.id) {
      st.setActiveContent(loc.project.id, loc.space.id);
      st.setActiveView(loc.project.id, loc.tab.id);
      restore = () => {
        const back = useSessions.getState();
        if (prevView) back.setActiveView(loc.project.id, prevView);
        if (prevSpace) back.setActiveContent(loc.project.id, prevSpace);
      };
      // 전환은 레이아웃을 움직인다 — 슬롯이 최종 자리에 선 뒤에 찍어야 한다.
      //
      // 기다림은 **사건으로 끝난다.** rAF 는 못 쓴다(가려진 창은 rAF 가 정지하는데, 창이 앞이
      // 아닐 때 찍는 것이 이 명령의 요점이다 — 실측 2026-07-31: 30초 타임아웃에 되돌리기까지
      // 못 했다). 숫자 타이머도 안 쓴다(얼마를 적든 그 수는 근거가 없다). 레이아웃 모션은
      // 자기 시작·끝을 알리므로 그 끝을 기다린다.
      settleAnimationsForCapture();
      await settledLayout();
    }
    tabId = loc.tab.id;
    nodeAddr = nodeOfTab(loc.project.id, loc.tab.id);
  }
  // 주소로 지목한 영역 — 좌표를 손으로 계산하지 않고 탭·패널 하나를 그대로 담는다.
  // 재는 자리는 ui.measure 와 같다(resolveExposed): 두 벌이면 같은 주소가 다른 자리를 답한다.
  if (nodeAddr) {
    const found = resolveExposed(nodeAddr);
    if (!("el" in found)) {
      restore?.();
      return found as Refusal;
    }
    const r = found.el.getBoundingClientRect();
    // 표면 rect 규칙을 그대로 쓴다(surfaceRectOf — 안쪽으로 접기). 노드 rect 는 거의 항상
    // 분수인데 캡처는 정수 픽셀에만 서므로, 접지 않고 넘기면 "빈/무효 crop rect" 로 거절
    // 당한다(실측 2026-07-31). 접는 규칙이 두 벌이면 캡처와 스탠드인이 다른 자리에 선다.
    const cropped = surfaceRectOf({
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
    });
    if (cropped.w < 1 || cropped.h < 1) {
      restore?.();
      return {
        ok: false,
        code: "INVALID_PARAMS",
        message: `노드가 화면에 크기를 갖지 않습니다(${Math.round(r.width)}x${Math.round(r.height)}): ${nodeAddr}`,
      };
    }
    // 실제 화면 밖 rect는 캡처할 픽셀이 없다. 이름과 사유로 거절하고 회복 경로를 준다.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (
      cropped.x + cropped.w <= 0 ||
      cropped.y + cropped.h <= 0 ||
      cropped.x >= vw ||
      cropped.y >= vh
    ) {
      restore?.();
      return {
        ok: false,
        code: "OFFSCREEN",
        message: `노드가 화면 밖입니다(x=${cropped.x}, y=${cropped.y} · 뷰포트 ${vw}x${vh}). 먼저 그 스페이스/탭을 활성화하세요: ${nodeAddr}`,
      };
    }
    rect = { x: cropped.x, y: cropped.y, w: cropped.w, h: cropped.h };
  }
  if (
    rect &&
    (typeof rect.x !== "number" ||
      typeof rect.y !== "number" ||
      typeof rect.w !== "number" ||
      typeof rect.h !== "number")
  ) {
    restore?.();
    return { ok: false, code: "INVALID_PARAMS", message: "rect 는 {x,y,w,h} 숫자 필수" };
  }
  return { rect, tabId, restore };
}

export function registerCaptureCatalog(): void {
  register("capture.calibration", {
    description:
      "Show, hide, or inspect the three fixed 64×40 DOM compositor calibration rulers used to compare chrome pixels with embedded-surface pixels during cropped window transitions. Reapplying the same visibility is idempotent.",
    params: {
      visible: { type: "boolean", description: "true=show, false=remove; omit to inspect current status" },
    },
    returns: "{ visible, color, rect, rects }",
    message: (d) => `DOM compositor calibration: ${d.visible ? "visible" : "hidden"}`,
    examples: ['capture.calibration \'{"visible":true}\'', 'capture.calibration \'{"visible":false}\''],
    handler: async (p) =>
      typeof p.visible === "boolean"
        ? setCaptureCalibration(p.visible)
        : setCaptureCalibration(Boolean(document.getElementById(CAPTURE_CALIBRATION_ID))),
  });

  register("capture.motion-anchors", {
    description:
      "Attach finite E2E pixel anchors to exposed DOM tab slots. Each anchor inherits its slot's layout transform, so a page marker of the same color must share its x coordinate in every recorded PNG. Passing an empty anchors array removes all anchors idempotently.",
    params: {
      anchors: {
        type: "json",
        description: "Complete declaration: [{address,color,x?,y?}]. Addresses must come from ui.tree; x/y are finite CSS-pixel offsets inside the exposed node.",
        required: true,
      },
    },
    returns: "{ visible, count, anchors:[{address,color,rect}] }",
    message: (d) => `DOM motion anchors: ${Number(d.count ?? 0)}`,
    errors: ["NOT_EXPOSED", "INVALID_PARAMS"],
    examples: ['capture.motion-anchors \'{"anchors":[]}\''],
    handler: async (p) => {
      if (!Array.isArray(p.anchors)) {
        return { ok: false, code: "INVALID_PARAMS", message: "anchors must be an array" };
      }
      const targets = [];
      for (const raw of p.anchors) {
        const item = raw as { address?: unknown; color?: unknown; x?: unknown; y?: unknown };
        if (typeof item?.address !== "string" || typeof item.color !== "string") {
          return { ok: false, code: "INVALID_PARAMS", message: "anchor requires string address and color" };
        }
        if ((item.x !== undefined && (typeof item.x !== "number" || !Number.isFinite(item.x)))
          || (item.y !== undefined && (typeof item.y !== "number" || !Number.isFinite(item.y)))) {
          return { ok: false, code: "INVALID_PARAMS", message: "anchor x/y must be finite numbers" };
        }
        const found = resolveExposed(item.address);
        if (!("el" in found)) return found;
        targets.push({ address: item.address, color: item.color, host: found.el, x: item.x, y: item.y });
      }
      const result = setCaptureMotionAnchors(document, targets);
      if (hasContentViewHost()) await contentViewHost().chromePresentationSettled();
      return result;
    },
  });

  register("window.snapshot", {
    description:
      "Capture the window contents to a PNG. Captures even when fully occluded by other apps (occlusion detection is temporarily disabled during capture). Includes WebGL terminal. Parent folder is created automatically. Cropping and saving compose freely: rect (CSS px, window coords — same space as ui.measure), node (an exposed address from ui.tree), or tab (a content tab id) selects the region, and path saves it while base64:true returns it inline. Capturing a tab that is not active activates it for the shot and restores whatever was active afterwards, so the screen returns to where it was. With neither path nor base64, a cropped capture still returns inline.",
    triggers: { ko: "스크린샷 캡처 화면 저장 PNG 저장 스냅샷 부분 영역" },
    params: {
      path: {
        type: "string",
        description: "Output .png path (file mode). Omit to use a temp folder.",
      },
      base64: {
        type: "boolean",
        description: "Return the PNG as base64 instead of writing a file",
      },
      rect: {
        type: "json",
        description:
          "Crop region {x,y,w,h} in CSS px, window coordinates (ui.measure space). Combine with path to save the crop.",
      },
      node: {
        type: "string",
        description:
          "Exposed address (ui.tree) to capture — its rect is measured for you. Use this to capture one panel or element without computing coordinates.",
      },
      tab: {
        type: "string",
        description:
          "Content tab id to capture. Inactive tabs are parked offscreen, so this activates the tab (and its space) for the shot and restores what was active afterwards.",
      },
      settle: SETTLE_PARAM,
    },
    returns:
      "{ tabId?, saved, media:{kind,path} } when path is given (cropped or full) | { tabId?, media:{kind:'image/png',base64} } otherwise — tabId echoes the resolved tab when tab was passed",
    message: (d) =>
      d.saved
        ? tmsg("msg.window.snapshot.saved", { path: String(d.saved) })
        : tmsg("msg.window.snapshot.captured"),
    // 귀의 문장(§3) — 경로는 message(눈)에만. 실패는 message(진단) 에코.
    speak: (out) => (out.ok ? (out.data?.saved ? "화면을 저장했어요." : "화면을 캡처했어요.") : out.message),
    hint: (d) => {
      if (d.code) return [];
      // 재캡처의 두 갈래 — 뷰 최대화로 확대해 담거나, 다른 스페이스로 전환해 화면을 비교한다.
      return [
        { cmd: "tab.maximize", why: tmsg("hint.flow.snapshot.maximize") },
        { cmd: "space.list", why: tmsg("hint.flow.snapshot.switch") },
      ];
    },
    errors: ["INVALID_PARAMS", "OFFSCREEN", "TARGET_NOT_FOUND", "NOT_EXPOSED"],
    examples: [
      "window.snapshot",
      'window.snapshot \'{"path":"/tmp/shot.png"}\'',
      'window.snapshot \'{"rect":{"x":100,"y":80,"w":400,"h":300},"base64":true}\'',
      'window.snapshot \'{"rect":{"x":100,"y":80,"w":400,"h":300},"path":"/tmp/crop.png"}\'',
      'window.snapshot \'{"node":"win/main/proj/p1/chrome/tab/space/0","path":"/tmp/tab.png"}\'',
    ],
    handler: async (p) => {
      // 캡처는 명령 — 창이 앞이든 뒤든 정확한 최종 프레임을 낸다. 비전면 창은 timeline 정지로
      // 진입 애니메이션이 중간 프레임에 갇히므로(arm_capture 의 가림해제만으론 timeline 이 안
      // 흐른다), 캡처 직전 유한 애니메이션을 명시 정착한다. 모든 캡처 경로 공통 앞단.
      if (p.settle !== false) settleAnimationsForCapture();
      // 자르기 축은 한 곳에서 해소한다(resolveRegion) — window.pixels 와 같은 함수다.
      const region = await resolveRegion(p);
      if (isRefusal(region)) return region;
      const { rect, tabId, restore } = region;
      if (rect || p.base64) {
        const pngBase64 = await invoke<string>(
          "plugin:webview-capture|snapshot_region",
          rect ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h } : {},
        );
        // 자른 그림도 **부른 쪽이 말한 자리에 남는다.** 여태 rect 를 주면 path 를 통째로
        // 무시하고 base64 만 답했다: 부른 쪽은 ok:true 를 받고 파일은 없었다(실측 2026-07-31).
        // 자르기와 저장은 서로 다른 축이므로 자유롭게 조합된다.
        const outPath = p.path as string | undefined;
        if (outPath) {
          const w = await invoke<{ path: string; bytes: number }>(
            "write_file_base64",
            { path: outPath, base64: pngBase64 },
          );
          restore?.();
          return {
            ...(tabId ? { tabId } : {}),
            saved: w.path,
            bytes: w.bytes,
            media: { kind: "image/png", path: w.path },
          };
        }
        // 이미지는 봉투 media 로 선언(표준) — 소비자는 키 추측 없이 media 만 렌더한다.
        restore?.();
        return {
          ...(tabId ? { tabId } : {}),
          media: { kind: "image/png", base64: pngBase64 },
        };
      }
      let path = p.path as string | undefined;
      if (!path) {
        const { tempDir, join } = frameworkPath;
        path = await join(
          await tempDir(),
          "soksak",
          `snapshot-${Date.now()}.png`,
        );
      }
      const saved = await invoke<string>("plugin:webview-capture|snapshot", {
        path,
      });
      // 파일 캡처도 media 로 선언 — 피드가 경로를 읽어 이미지로 렌더한다(경로 텍스트만 보이지 않게).
      return { saved, media: { kind: "image/png", path: saved } };
    },
  });

  // 화면에 **실제로 무엇이 칠해졌는가**를 숫자로 답한다.
  //
  // 왜 명령이어야 하는가(실사고 2026-08-02): 흐림이 안 걸린 것을 두 번 연달아 "됐다"고
  // 답했다. 계산된 스타일은 맞았고(베일 alpha 0.22 → 0.7) 캡처도 있었는데, 그 캡처를 **눈으로**
  // 보고 판정했기 때문이다. 눈은 "조금 어두워 보인다"와 "70% 어둡다"를 못 가른다. 잴 수 없는
  // 축은 반드시 때려맞히게 되고, 그 답은 신뢰할 수 없다.
  //
  // 선언(스타일)과 결과(픽셀)는 다른 사실이다. 선언이 맞아도 가려지거나, 클립되거나, 아래
  // 계층에 깔리면 픽셀은 안 바뀐다. 그래서 픽셀을 따로 묻는 자리를 둔다.
  register("window.pixels", {
    description:
      "Measure what is actually painted in a region — mean color and luminance, not a picture. Same region axes as window.snapshot (rect | node | tab), so the address you measure is the address you capture. Use this to verify that a declared style reached the screen: computed style says what was declared, this says what was painted (an overlay can be clipped, covered, or composited under a native surface and the declaration still reads correct). Compare two states or two regions by their luminance.",
    triggers: { ko: "픽셀 색 밝기 실제칠해짐 검증 휘도 평균색" },
    params: {
      rect: {
        type: "json",
        description:
          "Region {x,y,w,h} in CSS px, window coordinates (ui.measure space)",
      },
      node: {
        type: "string",
        description: "Exposed address (ui.tree) — its rect is measured for you",
      },
      tab: {
        type: "string",
        description:
          "Content tab id. Inactive tabs are parked offscreen, so this activates the tab for the shot and restores what was active afterwards",
      },
      settle: SETTLE_PARAM,
    },
    returns:
      "{ tabId?, w, h, samples, mean:{r,g,b}, luminance, min, max } — luminance is 0..1 on displayed (gamma-encoded) values; min/max are the darkest and brightest sampled luminance",
    message: (d) =>
      tmsg("msg.window.pixels", { l: Number(d.luminance ?? 0).toFixed(3) }),
    errors: ["INVALID_PARAMS", "OFFSCREEN", "TARGET_NOT_FOUND", "NOT_EXPOSED"],
    examples: [
      'window.pixels \'{"node":"win/main/proj/p1/chrome/layout/tab/tab-abc"}\'',
      'window.pixels \'{"rect":{"x":100,"y":80,"w":400,"h":300}}\'',
    ],
    handler: async (p) => {
      if (p.settle !== false) settleAnimationsForCapture();
      const region = await resolveRegion(p);
      if (isRefusal(region)) return region;
      const { rect, tabId, restore } = region;
      try {
        const pngBase64 = await invoke<string>(
          "plugin:webview-capture|snapshot_region",
          rect ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h } : {},
        );
        return { ...(tabId ? { tabId } : {}), ...(await pixelStats(pngBase64)) };
      } finally {
        restore?.();
      }
    },
  });

  register("window.record", {
    description:
      "Capture the window as a sequence of PNGs (dir/f0000.png ...) for use as a video source. All frames are rendered even when occluded (occlusion detection disabled for the duration). Folder is created automatically.",
    triggers: { ko: "녹화 연속 캡처 프레임 저장 동영상 소스" },
    params: {
      dir: {
        type: "string",
        description: "Output directory for frames",
        required: true,
      },
      frames: {
        type: "number",
        description: `Number of frames (default 40, range 1..${WINDOW_RECORD_MAX_FRAMES})`,
      },
      intervalMs: {
        type: "number",
        description: `Interval between frames in ms (default 40, range 0..${WINDOW_RECORD_MAX_INTERVAL_MS})`,
      },
      maxBytes: {
        type: "number",
        description: `Optional total encoded PNG byte budget (positive safe integer, max ${WINDOW_RECORD_MAX_BYTES})`,
      },
      frameTimeoutMs: {
        type: "number",
        description: `Per-frame native completion deadline in ms (default ${WINDOW_RECORD_DEFAULT_FRAME_TIMEOUT_MS}, max ${WINDOW_RECORD_MAX_FRAME_TIMEOUT_MS})`,
      },
    },
    returns: "{ dir, frames, maxBytes:number|null, frameTimeoutMs }",
    message: (d) => tmsg("msg.window.record", { n: Number(d.frames) }),
    errors: ["INVALID_PARAMS"],
    examples: [
      'window.record \'{"dir":"/tmp/rec"}\'',
      'window.record \'{"dir":"/tmp/rec","frames":120,"intervalMs":33}\'',
      'window.record \'{"dir":"/tmp/rec","frames":120,"maxBytes":536870912}\'',
    ],
    // **프레임 루프는 정책이지 표면이 아니다.** 프레임워크는 이미 "한 장 담기"를 답한다
    // (snapshot_region). 몇 장을 어떤 간격으로 어떤 이름에 쓸지는 이 앱이 정하는 일이고, 그것을
    // 껍데기마다 다시 구현하면 프레임워크에 따라 되거나 안 된다 — 실제로 한쪽만 답해서 전이 중
    // 결함을 한쪽에서는 볼 수 없었다(실측 2026-08-02: Electron 에서 UNKNOWN, 그래서 토글 순간을
    // 못 봤다). 여기서 한 번 돌면 어느 껍데기에서도 같은 답이 나온다.
    //
    // 정착하지 않는다 — 녹화의 요점이 **전이 중**이다. 정착시키면 보려던 것이 그 순간 끝난다.
    handler: async (p) => {
      const dir = p.dir as string;
      const frames = p.frames ?? 40;
      // 간격은 부른 쪽이 발화한다 — 무엇을 몇 fps 로 봐야 하는지는 이 자리가 모른다.
      const intervalMs = p.intervalMs ?? 40;
      const maxBytes = p.maxBytes;
      const frameTimeoutMs = p.frameTimeoutMs
        ?? WINDOW_RECORD_DEFAULT_FRAME_TIMEOUT_MS;
      if (!validWindowRecordFrames(frames)) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: `frames는 1..${WINDOW_RECORD_MAX_FRAMES} 범위의 정수여야 합니다`,
        };
      }
      if (!validWindowRecordIntervalMs(intervalMs)) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: `intervalMs는 0..${WINDOW_RECORD_MAX_INTERVAL_MS} 범위의 정수여야 합니다`,
        };
      }
      if (maxBytes !== undefined && !validWindowRecordMaxBytes(maxBytes)) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: `maxBytes는 1..${WINDOW_RECORD_MAX_BYTES} 범위의 safe integer여야 합니다`,
        };
      }
      if (!validWindowRecordFrameTimeoutMs(frameTimeoutMs)) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: `frameTimeoutMs는 1..${WINDOW_RECORD_MAX_FRAME_TIMEOUT_MS} 범위의 정수여야 합니다`,
        };
      }
      return {
        dir,
        maxBytes: maxBytes ?? null,
        frameTimeoutMs,
        frames: await recordWindowFrames({
          dir,
          frames,
          intervalMs,
          ...(maxBytes === undefined ? {} : { maxBytes }),
          frameTimeoutMs,
        }),
      };
    },
  });

  register("window.record.start", {
    description:
      "Start one finite window recording and ACK after its first saved frame. The recording continues independently so layout/presentation machine traces can close at their own transaction boundary without waiting for PNG completion.",
    params: {
      id: { type: "string", description: "Caller-owned idempotent recording identity", required: true },
      dir: { type: "string", description: "Output directory for frames", required: true },
      frames: { type: "number", description: `Number of frames (default 40, range 1..${WINDOW_RECORD_MAX_FRAMES})` },
      intervalMs: { type: "number", description: `Interval between frames in ms (default 40, range 0..${WINDOW_RECORD_MAX_INTERVAL_MS})` },
      maxBytes: { type: "number", description: `Optional encoded PNG byte budget (max ${WINDOW_RECORD_MAX_BYTES})` },
      frameTimeoutMs: { type: "number", description: `Per-frame native completion deadline (max ${WINDOW_RECORD_MAX_FRAME_TIMEOUT_MS})` },
    },
    returns: "{ id,ready,dir,requestedFrames }",
    message: (d) => `recording ${String(d.id)} ready=${String(d.ready)}`,
    errors: ["INVALID_PARAMS"],
    handler: async (p) => {
      const frames = p.frames ?? 40;
      const intervalMs = p.intervalMs ?? 40;
      const frameTimeoutMs = p.frameTimeoutMs ?? WINDOW_RECORD_DEFAULT_FRAME_TIMEOUT_MS;
      if (!validWindowRecordFrames(frames)
          || !validWindowRecordIntervalMs(intervalMs)
          || (p.maxBytes !== undefined && !validWindowRecordMaxBytes(p.maxBytes))
          || !validWindowRecordFrameTimeoutMs(frameTimeoutMs)) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "window recording parameters are invalid" };
      }
      return startWindowRecordingSession(String(p.id), {
        dir: String(p.dir), frames, intervalMs,
        ...(p.maxBytes === undefined ? {} : { maxBytes: p.maxBytes }),
        frameTimeoutMs,
      });
    },
  });

  register("window.record.read", {
    description: "Wait for and return the immutable final receipt of a finite window.record.start session.",
    params: { id: { type: "string", description: "Recording identity", required: true } },
    returns: "{ id,report:{status,mode,dir?,requestedFrames?,frames?,reason?} }",
    message: (d) => `recording ${String(d.id)} complete`,
    handler: async (p) => readWindowRecordingSession(String(p.id)),
  });
}
