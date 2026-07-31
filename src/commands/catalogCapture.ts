// 화면 캡처 — registerCatalog() 말미에서 등록(catalog 분할 — catalogHealth 선례).
//
// 자르기(rect·node)와 저장(path·base64)은 **서로 다른 축**이라 자유롭게 조합된다. 여태 자르면
// path 를 통째로 무시하고 base64 만 답했다: 부른 쪽은 ok:true 를 받고 파일은 없었다(실측
// 2026-07-31). 조용한 무시라 어디서 어긋났는지 밖에서 읽을 수 없었다.

import { invoke, frameworkPath } from "../framework";
import { tmsg } from "../i18n";
import { settleAnimationsForCapture } from "./captureSettle";
import { isLayoutMotionActive, onLayoutMotion } from "../lib/layoutMotion";
import { resolveExposed } from "./catalogDom";
import { surfaceRectOf } from "../lib/surfaceRect";
import { register } from "./registry";
import { formatAddress } from "./address";
import { currentWindowLabel } from "../lib/webviewLabels";
import { locateTab } from "./catalog";
import { useSessions } from "../state/sessions";

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

export function registerCaptureCatalog(): void {
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
    errors: ["INVALID_PARAMS"],
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
      settleAnimationsForCapture();
      let rect = p.rect as
        | { x: number; y: number; w: number; h: number }
        | undefined;
      // 탭을 이름으로 담는다 — 비활성 탭은 창 밖으로 파킹되므로(실측 x=-3490) 주소만으로는
      // 캡처할 픽셀이 없다. 부른 쪽에 "먼저 활성화하라"를 떠넘기지 않는다: 이 명령이 활성화하고,
      // 찍고, **원래 활성이던 것을 되돌린다**. 캡처는 관측이지 변경이 아니다.
      let restore: (() => void) | null = null;
      let tabId: string | undefined;
      let nodeAddr = p.node as string | undefined;
      if (typeof p.tab === "string" && p.tab) {
        const loc = locateTab(p.tab);
        if (!loc || !loc.tab) {
          return {
            ok: false as const,
            code: "TARGET_NOT_FOUND" as const,
            message: `탭 없음: ${p.tab}`,
          };
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
          return found;
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
            ok: false as const,
            code: "INVALID_PARAMS" as const,
            message: `노드가 화면에 크기를 갖지 않습니다(${Math.round(r.width)}x${Math.round(r.height)}): ${nodeAddr}`,
          };
        }
        // 화면 밖은 캡처할 픽셀이 없다 — 비활성 슬롯은 창 밖으로 파킹된다(실측: x=-3490).
        // 이것을 캡처 계층까지 흘려보내면 "빈/무효 crop rect" 라는 INTERNAL 로 뭉개져, 부른
        // 쪽은 무엇을 고쳐야 할지 알 수 없다. 이름과 사유로 거절하고 회복 경로를 준다.
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
            ok: false as const,
            code: "OFFSCREEN" as const,
            message: `노드가 화면 밖입니다(x=${cropped.x}, y=${cropped.y} · 뷰포트 ${vw}x${vh}) — 비활성 슬롯은 창 밖으로 파킹됩니다. 먼저 그 스페이스/탭을 활성화하세요: ${nodeAddr}`,
          };
        }
        rect = { x: cropped.x, y: cropped.y, w: cropped.w, h: cropped.h };
      }
      if (rect || p.base64) {
        if (
          rect &&
          (typeof rect.x !== "number" ||
            typeof rect.y !== "number" ||
            typeof rect.w !== "number" ||
            typeof rect.h !== "number")
        ) {
          return {
            ok: false as const,
            code: "INVALID_PARAMS" as const,
            message: "rect 는 {x,y,w,h} 숫자 필수",
          };
        }
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
      frames: { type: "number", description: "Number of frames (default 40, max 600)" },
      intervalMs: { type: "number", description: "Interval between frames in ms (default 40)" },
    },
    returns: "{ dir, frames }",
    message: (d) => tmsg("msg.window.record", { n: Number(d.frames) }),
    examples: [
      'window.record \'{"dir":"/tmp/rec"}\'',
      'window.record \'{"dir":"/tmp/rec","frames":120,"intervalMs":33}\'',
    ],
    handler: async (p) => {
      const dir = p.dir as string;
      const frames = (p.frames as number | undefined) ?? 40;
      const intervalMs = (p.intervalMs as number | undefined) ?? 40;
      const n = await invoke<number>("plugin:webview-capture|record", {
        dir,
        frames,
        intervalMs,
      });
      return { dir, frames: n };
    },
  });
}
