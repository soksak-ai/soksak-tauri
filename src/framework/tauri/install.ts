// Tauri 전용 장치 — **이 프레임워크가 자기 사정을 스스로 갚는 자리.**
//
// 이 프레임워크의 콘텐츠는 문서 밖에 산다(OS 자식 뷰). 문서 밖 표면은 DOM 전체보다 뒤에
// 합성되고, 좌표를 써 줘야 움직이고, 그 위의 마우스는 이 문서에 오지 않는다. 그래서 이
// 프레임워크에는 그 셋을 갚는 장치가 필요하다 — 홀·스탠드인·클립·네이티브 마우스.
//
// **그 장치는 코어의 것이 아니다.** 콘텐츠가 문서 안에 사는 프레임워크에는 갚을 빚이 없고,
// 거기서 같은 장치가 돌면 멀쩡한 판을 가리고 비운다(실측 2026-08-03: 판 활성 전이의 한
// 프레임에서 브라우저 판 둘이 통째로 비었다 — 스탠드인·베일이 문서 안 게스트에게도 걸렸다).
//
// 그래서 규칙은 하나다: **코어 표면은 둘 다 동일하고, 그 표면에 자기 fix 를 거는 것은 각
// 프레임워크다.** 코어는 무엇이 걸렸는지 묻지 않는다 — 안 걸리면 아무 일도 안 일어난다.
// 새 프레임워크가 오면 자기 파일에 자기 것을 적는다. 남의 fix 를 물려받지 않는다.
import { invoke } from "@tauri-apps/api/core";
import styles from "./styles.css?inline";
import {
  installNativeContentViewComposition,
  nativeContentViewCompositionStatus,
  nativeHost,
  prepareNativeContentViewMove,
} from "./contentViews";
import { adoptFrameworkStyles } from "../styles";
import { registerContentViewHost } from "../../lib/contentViews";
import { registerLayoutTransitionHost } from "../../lib/layoutTransitionHost";
import {
  awaitPluginViewComposition,
  awaitPluginViewPresentation,
  installPluginViewPresentation,
  pluginViewCompositionStatus,
  pluginViewNativeContractStatus,
  pluginViewPresentationStatus,
  preparePresentedPluginViewMove,
} from "./pluginViewPresentation";
import { registerWindowResizeProbe } from "../../lib/windowResizeProbe";
import { combineTauriCompositionProbe } from "./compositionProbe";
import { installRailHoleClip } from "./railHoleClipHost";
import { installSurfaceAudit, surfaceCompositionSnapshot } from "./surfaceAudit";
import {
  collectHoleFacts,
  compareHoles,
  installDomHoles,
  type Hole,
} from "./domHoles";
import {
  installTauriHoleMarkers,
  isTauriRectMotionExcluded,
} from "./holeMarkers";
import { useUi } from "../../state/ui";
import { useGutterHover } from "../../state/gutterHover";
import { bindPaneUnder } from "../../lib/bindPaneUnder";
import { onLayoutMotion } from "../../lib/layoutMotion";
import { registerRectMotionExclusion } from "../../lib/layoutRectMotion";
import { listenThisWindow } from "../../lib/windowEvents";
import { register } from "../../commands/registry";
import { tmsg } from "../../i18n";

/**
 * 오버레이 히트테스트 게이트 — 모달·메뉴가 떠 있는 동안 아래 표면이 마우스를 못 가져가게 한다.
 *
 * 콘텐츠가 문서 밖이라 필요한 장치다. 이 문서의 hitTest 가 nil 을 돌려주는 자리에서는 아래
 * 네이티브가 마우스를 가져가므로, "바깥 클릭 = 닫기"가 성립하려면 그 통과를 막아야 한다.
 * 문서 안에 사는 콘텐츠는 평범한 쌓임으로 이미 막힌다 — 거기서는 걸 것이 없다.
 *
 * 0↔1 경계에서만 보낸다(불필요 IPC 억제). 카운터는 코어의 사실이고, 그 반응이 여기 있다.
 */
function installOverlayGate(): void {
  // 부트 정렬: 이 문서의 재적재는 카운터를 0부터 다시 시작하지만 네이티브 게이트엔 직전
  // 상태(true)가 남을 수 있다 — 시작 시 1회 false 로 맞춘다.
  let up = false;
  const send = (active: boolean) => {
    void invoke("webview_overlay_active", { active }).catch(() => {});
  };
  send(false);
  useUi.subscribe((s) => {
    const now = s.overlayCount > 0;
    if (now === up) return;
    up = now;
    // 코어가 호출 창을 자동 인지(window 주입)하므로 label 전달 불요 — 이 창의 게이트만 갱신.
    send(now);
  });
}

/**
 * 표면 위의 마우스를 문서가 되찾는다.
 *
 * 콘텐츠가 OS 자식 뷰라 그 위의 mousedown/move/up 이 이 문서에 오지 않는다. 그래서 둘이 끊긴다:
 * ① 포커스 — 표면을 눌러도 그 아래 칸이 활성화되지 않는다.
 * ② 분할 드래그 — 표면 위를 지나는 골을 잡을 수 없다.
 *
 * 프레임워크의 입력 모니터가 좌표를 낸다. 좌표의 요소는 `elementFromPoint` 가 답하고(그것은
 * DOM 만 보므로 표면 아래의 골도 반환한다), 골이면 합성 마우스 사건을 재생해 **기존 드래그
 * 로직을 그대로** 구동한다 — 골을 감추거나 표면을 숨기는 우회 없이 화면을 꽉 채운 채 끌린다.
 *
 * 칸을 짚는 판정은 코어의 한 함수를 부른다(lib/bindPaneUnder) — 콘텐츠 뷰 활성화로 들어오는
 * 길과 같은 자리다. 갈리면 한쪽만 고쳐지고 그 어긋남은 오류로 안 보인다.
 */
function installNativeMouse(): void {
  const fire = (target: EventTarget, type: string, x: number, y: number) =>
    target.dispatchEvent(
      new MouseEvent(type, {
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: type === "mouseup" ? 0 : 1,
        view: window, // React 위임이 SyntheticEvent 를 만들려면 view(defaultView)가 필요할 수 있다.
      }),
    );
  let dragging = false;
  // 이 창에 emit_to 된 것만 받는다(전역 listen 이면 다른 창 사건도 받아 엉뚱한 창을 건드린다).
  listenThisWindow<{ x: number; y: number }>("native-mousedown", (e) => {
    const { x, y } = e.payload;
    const el = document.elementFromPoint(x, y);
    // 중계 대상: 분할 골 + `[data-native-drag]` 선언 요소(범용 계약 — 플러그인 내부 리사이저 등).
    const divider = el?.closest<HTMLElement>(".pane-gutter, [data-native-drag]");
    if (divider) {
      dragging = true;
      fire(divider, "mousedown", x, y);
      return;
    }
    bindPaneUnder(el);
  });
  listenThisWindow<{ x: number; y: number }>("native-mousemove", (e) => {
    if (dragging) {
      fire(window, "mousemove", e.payload.x, e.payload.y);
      return;
    }
    // hover(버튼 안 누름) — 표면 위에선 골의 :hover 가 발동하지 않으므로 좌표의 골을 기록한다.
    // 발행(GroupArea data-gutter-key)과 같은 이름을 읽는다 — 개명에서 이 판독부만 남아
    // dataset.dividerKey 가 항상 undefined 였다(표면 위 골 강조 무음 사망, 감사 적발).
    const el = document.elementFromPoint(e.payload.x, e.payload.y);
    const div = el?.closest<HTMLElement>(".pane-gutter");
    useGutterHover.getState().set(div?.dataset.gutterKey ?? null);
  });
  listenThisWindow<{ x: number; y: number }>("native-mouseup", (e) => {
    if (!dragging) return;
    dragging = false;
    fire(window, "mouseup", e.payload.x, e.payload.y);
  });
  // 포인터 부재 — 창 resignKey·앱 resignActive 에서 온다. hover 는 "있음"만 말하는 소스에서
  // 오므로 이 짝이 없으면 꺼질 방법이 없다: 포인터가 창 밖으로 나가면 mousemove 가 끊기고,
  // 끊긴 것과 그 자리에 멈춘 것이 구별되지 않아 강조가 영원히 남는다(실측: accent 세로선이
  // 브라우저를 가로지른 채 굳음).
  listenThisWindow("native-mouseleave", () => {
    dragging = false;
    useGutterHover.getState().set(null);
  });
}

/**
 * 골 강조바 — 표면 위에서는 DOM 강조가 안 보이므로 프레임워크가 그 자리에 직접 그린다.
 *
 * rAF 추적: 드래그로 골이 움직이면 매 프레임 rect 를 다시 재야 바가 정확히 따라간다(1회성
 * 배치는 드래그 중 바가 제자리에 남는다 — 회귀). rect 가 안 변한 프레임은 보내지 않는다.
 */
function installDividerBar(): void {
  let raf = 0;
  let last = "";
  const send = (rect: { x: number; y: number; w: number; h: number } | null) => {
    void invoke("webview_divider_highlight", { rect }).catch(() => {});
  };
  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    last = "";
    send(null);
  };
  useGutterHover.subscribe((s) => {
    const key = s.key;
    if (!key) return stop();
    if (raf) return; // 이미 추적 중 — 대상만 바뀌면 다음 프레임이 새 rect 를 읽는다
    const tick = () => {
      const sel = `.pane-gutter[data-gutter-key="${CSS.escape(useGutterHover.getState().key ?? "")}"]`;
      const el = document.querySelector(sel);
      if (el instanceof HTMLElement) {
        const r = el.getBoundingClientRect();
        const sig = `${r.left.toFixed(1)},${r.top.toFixed(1)},${r.width.toFixed(1)},${r.height.toFixed(1)}`;
        if (sig !== last) {
          last = sig;
          send({ x: r.left, y: r.top, w: r.width, h: r.height });
        }
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
  });
}

/**
 * 리사이즈 위상 릴레이 — 표면이 문서 밖이라 위상 동안 그 표면을 다루려면 프레임워크가 알아야 한다.
 *
 * 플러그인 채널(layout.resize-gesture)은 코어가 이미 뿌린다 — 그건 두 프레임워크 모두의 사실이다.
 * 여기 있는 것은 **이 프레임워크의 네이티브 쪽**에만 필요한 릴레이다.
 */
function installResizeGestureRelay(): void {
  onLayoutMotion((active) => {
    void invoke("webview_resize_gesture", { active }).catch(() => {
      // 비-macOS 등 릴레이 미지원은 무해 — 플러그인 채널은 이미 전달됐다.
    });
  });
}

/**
 * 이 프레임워크의 입력 브릿지를 소켓에서 구동하는 명령 — 표면 위 골 드래그의 E2E 자가검증.
 *
 * 명령도 **거는 것**이다. 코어 등록부에 걸되 거는 쪽은 이 프레임워크다: 다른 프레임워크에는
 * 그 브릿지가 없고, 거기서 이 이름이 목록에 있으면 부른 쪽은 있는 줄 알고 부른다.
 */
function installNativeBridgeCommand(): void {
  register("webview.emitNative", {
    description:
      "Emit a native mouse-bridge event (native-mousedown/move/up) at viewport x,y — drives divider drag/resize over a content surface that lives outside the document, without a real mouse, for E2E. Pair with ui.input.drag (DOM path); this is the native path. Occluded/unfocused windows pause rAF and may not respond — call window.focus to bring the window forward first.",
    params: {
      kind: {
        type: "string",
        description: "native-mousedown | native-mousemove | native-mouseup",
        required: true,
      },
      x: { type: "number", description: "viewport x", required: true },
      y: { type: "number", description: "viewport y", required: true },
    },
    returns: "{ ok, kind }",
    message: (d) => tmsg("msg.webview.emitNative", { kind: String(d.kind) }),
    examples: ['webview.emitNative \'{"kind":"native-mousedown","x":400,"y":300}\''],
    handler: async (p) => {
      await invoke("webview_emit_native", { kind: p.kind, x: p.x, y: p.y });
      return { ok: true, kind: p.kind };
    },
  });
}

/** DOM 홀과 실제 NSView frame의 일대일 합성 상태 — Tauri에만 존재하는 공개 진단면. */
function installCompositionCommand(): void {
  register("webview.composition", {
    description:
      "Tauri-only composition audit: expose every visible DOM content hole and live native surface frame in both coordinate systems, with one-to-one matches and a strict rounding-only verdict.",
    params: {},
    returns:
      "{ coordinateContract, anchors, surfaces:[{ptr,label,hidden,effectivelyHidden,nativeFrame,domFrame,autoresizingMask,layerContentsRedrawPolicy,layerContentsPlacement}], engine:{preservesContentDuringLiveResize,rendererTopology:{verdict,panelAtomicMotion,sharedPaneHost}}, placement:[{label,opened,desiredVisible,appliedVisible,boundsWrites,slotPresent,slotRect,appliedRect,syncPending}], matches, verdict }",
    message: (d) => {
      const verdict = d.verdict as { misplaced?: unknown[]; stacked?: unknown[]; missing?: unknown[] };
      const bad = (verdict.misplaced?.length ?? 0) + (verdict.stacked?.length ?? 0) + (verdict.missing?.length ?? 0);
      return bad === 0 ? "Tauri DOM 홀과 네이티브 표면이 일치합니다" : `Tauri 합성 불일치 ${bad}건`;
    },
    handler: async () => ({
      ...(await surfaceCompositionSnapshot()),
      placement: nativeContentViewCompositionStatus(),
    }),
  });
}

/** DOM 드래그 선언과 AppKit hit-test 홀 장부의 일대일 상태 — Tauri 전용 공개 진단면. */
function installHoleAuditCommand(): void {
  register("webview.holes", {
    description:
      "Tauri-only input-hole audit: compare every visible DOM drag/sidebar declaration with the AppKit hit-test hole ledger one-to-one. Reports missing native holes and stale native holes separately.",
    params: {},
    returns:
      "{ tolerancePx, dom:[{kind,node,rect}], native:[{x,y,w,h}], verdict:{missingNative,staleNative,matched} }",
    message: (d) => {
      const verdict = d.verdict as { missingNative?: unknown[]; staleNative?: unknown[] };
      const bad = (verdict.missingNative?.length ?? 0) + (verdict.staleNative?.length ?? 0);
      return bad === 0
        ? "Tauri DOM 드래그 영역과 네이티브 홀이 일치합니다"
        : `Tauri 입력 홀 불일치 ${bad}건`;
    },
    handler: async () => {
      const dom = collectHoleFacts();
      const native = await invoke<Hole[]>("webview_holes");
      return {
        tolerancePx: 1,
        dom,
        native,
        verdict: compareHoles(dom, native),
      };
    },
  });
}

/** PaneSurfaceHost 수명·기하·진단을 공개 커맨드로 노출한다. 자동화가 private DOM이나
 * Rust registry를 우회 조회하지 않고 같은 인터페이스로 준비와 판정을 수행하는 경계다. */
function installPaneSurfaceHostCommands(): void {
  register("webview.pane.presentation", {
    description: "Read Tauri pane presentation lifecycle status.",
    params: {}, returns: "{ total, grouped, pending }",
    message: (data) => `plugin presentation ${String(data.grouped)}/${String(data.total)}`,
    handler: async () => pluginViewPresentationStatus(),
  });
  register("webview.pane.wait", {
    description: "Wait on lifecycle events until the requested PaneSurfaceHosts are grouped.",
    params: {
      minGrouped: { type: "number", description: "required grouped count", required: true },
      timeoutMs: { type: "number", description: "finite timeout (default 30000)" },
    },
    returns: "{ total, grouped, pending }",
    message: (data) => `plugin presentation ready ${String(data.grouped)}/${String(data.total)}`,
    handler: async (params) => awaitPluginViewPresentation(
      Number(params.minGrouped), Number(params.timeoutMs ?? 30_000),
    ),
  });
  register("webview.pane.composition", {
    description: "Compare every public pane projection with its native PaneSurfaceHost and member frames.",
    params: {}, returns: "{ window,tolerancePx,matches,orphanNative,foreignNative,matched,verdict }",
    message: (data) => `pane composition ${String(data.verdict)}`,
    handler: async () => pluginViewCompositionStatus(),
  });
  register("webview.pane.composition.wait", {
    description: "Wait for child slot events to be committed to native pane members, then compare live frames.",
    params: {
      settleTimeoutMs: { type: "number", description: "finite event barrier timeout (default 8000)" },
    },
    returns: "{ window,tolerancePx,matches,orphanNative,foreignNative,matched,verdict }",
    message: (data) => `pane composition committed ${String(data.verdict)}`,
    handler: async (params) => awaitPluginViewComposition(Number(params.settleTimeoutMs ?? 8_000)),
  });
  register("webview.pane.group", {
    description: "Group one pane renderer and its native members under one PaneSurfaceHost.",
    params: {
      pane: { type: "string", description: "pane identity", required: true },
      renderer: { type: "string", description: "pane renderer label", required: true },
      members: { type: "string[]", description: "native member labels", required: true },
      x: { type: "number", description: "viewport x", required: true },
      y: { type: "number", description: "viewport y", required: true },
      w: { type: "number", description: "pane width", required: true },
      h: { type: "number", description: "pane height", required: true },
    },
    danger: "inject", returns: "{ pane,renderer,members,grouped:true }",
    message: (data) => `PaneSurfaceHost ${String(data.pane)}를 구성했습니다`,
    handler: async (params) => {
      await invoke("webview_pane_group", params);
      return { ...params, grouped: true };
    },
  });
  register("webview.pane.move", {
    description: "Prepare one atomic PaneSurfaceHost transition at an explicit epoch.",
    params: {
      pane: { type: "string", description: "pane identity", required: true },
      x: { type: "number", description: "target x", required: true },
      y: { type: "number", description: "target y", required: true },
      w: { type: "number", description: "target width", required: true },
      h: { type: "number", description: "target height", required: true },
      startAtUnixMs: { type: "number", description: "absolute start epoch", required: true },
      durationMs: { type: "number", description: "finite duration", required: true },
    },
    danger: "inject", returns: "{ pane,prepared:true }",
    message: (data) => `PaneSurfaceHost ${String(data.pane)} 이동을 준비했습니다`,
    handler: async (params) => {
      await invoke("webview_pane_transition_prepare", params);
      return { pane: params.pane, prepared: true };
    },
  });
  register("webview.pane.hosts", {
    description: "Expose every live PaneSurfaceHost, renderer, member, frame, and renderer topology.",
    params: {}, returns: "{ count,hosts:[{pane,window,renderer,members,cssFrame,rendererTopology}] }",
    message: (data) => `PaneSurfaceHost ${String(data.count)}개`,
    handler: async () => {
      const hosts = await invoke<Record<string, unknown>[]>("webview_pane_hosts");
      return { count: hosts.length, hosts };
    },
  });
  register("webview.pane.eval", {
    description: "Evaluate a diagnostic expression in an explicitly named pane renderer.",
    params: {
      label: { type: "string", description: "renderer label", required: true },
      js: { type: "string", description: "async function body returning a string", required: true },
    },
    danger: "inject", returns: "{ label,result }",
    message: (data) => `Tauri child ${String(data.label)} 진단을 읽었습니다`,
    handler: async (params) => ({
      label: params.label,
      result: await invoke<string>("webview_eval", { label: params.label, js: params.js }),
    }),
  });
}

/** 이 프레임워크가 코어 표면에 거는 것 전부. 고른 어댑터만 불린다(contract.install). */
export function installTauri(): void {
  registerWindowResizeProbe(async () => {
    const [direct, pane] = await Promise.all([
      surfaceCompositionSnapshot(),
      pluginViewNativeContractStatus(),
    ]);
    return combineTauriCompositionProbe(direct, pane);
  });
  // 콘텐츠 뷰 구현 — 이 프레임워크가 줄 수 있는 것은 OS 자식 뷰다.
  registerContentViewHost(nativeHost);
  // DOM 밖 표면이 포함된 배치만 목표 bounds 선확정 + DOM snap 거래로 바꾼다.
  registerLayoutTransitionHost({
    prepareMove: async (moves) => {
      const [direct, presented] = await Promise.all([
        prepareNativeContentViewMove(moves),
        preparePresentedPluginViewMove(moves),
      ]);
      return {
        mode: direct.mode === "snap" || presented.mode === "snap" ? "snap" : "glide",
        startAtUnixMs: direct.startAtUnixMs ?? presented.startAtUnixMs,
        commit: async () => { await Promise.all([direct.commit(), presented.commit()]); },
        cancel: () => { direct.cancel(); presented.cancel(); },
      };
    },
  });
  installPluginViewPresentation();
  // 공개 슬롯 → OS 자식 bounds/가시성/AppKit frame 전환. 플러그인은 슬롯만 선언한다.
  installNativeContentViewComposition();
  // 홀 CSS — 셀렉터에 프레임워크 이름이 없다. 안 걸리면 그 규칙은 애초에 문서에 없다.
  adoptFrameworkStyles("tauri", styles);
  // 공개 슬롯을 Tauri 전용 합성 표식으로 투영한다. 공통 DOM 은 hole 개념을 갖지 않는다.
  installTauriHoleMarkers();
  // 사이드바는 홀 위에 칠하지 않는다 — 문서 밖 표면은 DOM 전체 뒤라 클립 제외만이 유일한 길이다.
  installRailHoleClip();
  // 표면 정합 상시 감사 — 문서 밖 표면은 상태와 따로 살 수 있어(유령) 그 어긋남을 계속 본다.
  installSurfaceAudit();
  // 홀(골·사이드바) 갱신 — 네이티브 층 아래의 마우스 소유를 문서가 되찾는 자리.
  installDomHoles();
  // 오버레이 동안 아래 표면의 마우스 통과를 막는다 — 문서 안 콘텐츠에는 걸 것이 없다.
  installOverlayGate();
  // 표면 위의 마우스를 문서가 되찾는다(포커스·분할 드래그).
  installNativeMouse();
  // 골 강조바 — 표면 위에서는 DOM 강조가 안 보인다.
  installDividerBar();
  // 리사이즈 위상을 네이티브 쪽에 알린다.
  installResizeGestureRelay();
  // 이 프레임워크에만 있는 명령 표면.
  installNativeBridgeCommand();
  installCompositionCommand();
  installHoleAuditCommand();
  installPaneSurfaceHostCommands();
  // 실제 FLIP 추적 프레임(pane·tab-body) 중 native child를 품은 것만 뺀다. bounds 원천인
  // content-view body는 그 자식이라 검사 대상이 아니다. 문서 안 게스트에는 이 표식도 등록도
  // 없으므로 Electron의 DOM 보간은 그대로다.
  registerRectMotionExclusion(isTauriRectMotionExcluded);
}
