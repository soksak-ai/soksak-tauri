// 창 표면 명령 — 자리·크기·포커스·열기/닫기·모니터·레이어.
//
// 카탈로그에서 갈라 둔다: 창은 프레임워크가 소유하는 표면이고(AppFramework), 그 축의 명령이
// 한 덩어리로 모여 있어야 "창에 무엇을 물을 수 있나"를 한 자리에서 읽는다.
//
// 공용 해소(`windowTarget`·`P`·`notFound`)는 카탈로그가 소유한다 — 여기서 다시 정의하면
// 같은 규칙이 파일마다 갈린다(생략 = 지금 대상).
import { invoke, currentWindow, windowByLabel } from "../framework";
import { tmsg } from "../i18n";
import { register } from "./registry";
import { browserLabelPrefix, currentWindowLabel } from "../lib/webviewLabels";
import { validateProjectRoot } from "../lib/projectRoot";
import { forgetWindowSlot } from "../state/windowBoot";
import {
  previousGenerationKey,
  snapshotSize,
  type WindowSnapshotLike,
} from "../state/snapshotGeneration";
import { windowTarget, P, notFound } from "./catalog";

export function registerWindowCatalog(): void {
  register("window.info", {
    description: "Get window screen position, size, and scale factor (for automation validation — outerPosition is physical pixels).",
    params: {},
    returns: "{ x, y, w, h, scale }",
    message: (d) => tmsg("msg.window.info", { w: Number(d.w), h: Number(d.h) }),
    examples: ["window.info"],
    handler: async () => {
      const win = currentWindow();
      const [pos, size, scale] = await Promise.all([
        win.outerPosition(),
        win.outerSize(),
        win.scaleFactor(),
      ]);
      return { x: pos.x, y: pos.y, w: size.width, h: size.height, scale };
    },
  });

  register("window.move", {
    description: "Move the window to a screen position in physical pixels (for automation and multi-monitor validation).",
    params: {
      x: { type: "number", description: "Physical x coordinate", required: true },
      y: { type: "number", description: "Physical y coordinate", required: true },
    },
    returns: "{ x, y }",
    message: (d) => tmsg("msg.window.move", { x: Number(d.x), y: Number(d.y) }),
    examples: ['window.move \'{"x":0,"y":0}\''],
    handler: async (p) => {
      await currentWindow().setPhysicalPosition(p.x as number, p.y as number);
      return { x: p.x, y: p.y };
    },
  });

  register("window.resize", {
    description: "Resize the window to a physical pixel size (for automation and resize-path E2E — drives the native window resize, the same path as edge-drag, which pane.resize does not exercise).",
    params: {
      w: { type: "number", description: "Physical width", required: true },
      h: { type: "number", description: "Physical height", required: true },
    },
    returns: "{ w, h }",
    message: (d) => tmsg("msg.window.resize", { w: Number(d.w), h: Number(d.h) }),
    examples: ['window.resize \'{"w":1200,"h":800}\''],
    handler: async (p) => {
      await currentWindow().setPhysicalSize(p.w as number, p.h as number);
      return { w: p.w, h: p.h };
    },
  });

  register("window.focus", {
    description:
      "Bring a window to the front and focus it. Without label, focuses the window this command runs in (clears inactive state for automation); with label, focuses that window (see window.list).",
    triggers: { ko: "창 포커스 창 활성화 창 앞으로" },
    params: { label: P.windowLabel },
    returns: "{ focused: true }",
    message: () => tmsg("msg.window.focus"),
    examples: ["window.focus", 'window.focus \'{"label":"w-<uuid>"}\''],
    errors: ["TARGET_NOT_FOUND"],
    handler: async (p) => {
      const label = windowTarget(p);
      const labels = await invoke<string[]>("window_list");
      if (!labels.includes(label)) return notFound(`창 없음: ${label}`);
      if (label !== currentWindowLabel()) {
        await invoke("window_focus", { label });
        return { focused: true };
      }
      // setFocus 는 창을 key 로 만들 뿐 — 앱 전면 전환은 네이티브 자기 활성화로.
      await invoke("window_activate");
      await currentWindow().setFocus();
      return { focused: true };
    },
  });

  register("window.maximize", {
    description:
      "Maximize a window to fill the screen (native window maximize — distinct from tab.maximize, which only enlarges one tab within a space). Without label, targets the window this command runs in; with label, targets that window (see window.list). Pass off:true to restore (unmaximize).",
    triggers: { ko: "창 최대화 전체화면 창 키우기 최대화 해제" },
    params: {
      label: P.windowLabel,
      off: { type: "boolean", description: "Restore (unmaximize) instead of maximizing" },
    },
    returns: "{ maximized: boolean }",
    message: (d) =>
      d.maximized ? tmsg("msg.window.maximize") : tmsg("msg.window.maximize.off"),
    errors: ["TARGET_NOT_FOUND"],
    examples: [
      "window.maximize",
      'window.maximize \'{"off":true}\'',
      'window.maximize \'{"label":"w-<uuid>"}\'',
    ],
    handler: async (p) => {
      const off = p.off === true;
      const label = windowTarget(p);
      const win = await windowByLabel(label);
      if (!win) return notFound(`창 없음: ${label}`);
      if (off) await win.unmaximize();
      else await win.maximize();
      return { maximized: !off };
    },
  });

  register("window.reload", {
    description:
      "Fully reload the app webview (location.reload). Picks up core/plugin code changes during development — including modules HMR misses (e.g. already-activated plugin API surfaces). Active plugins are re-activated automatically after reload (install and consent are persisted).",
    triggers: { ko: "앱 리로드 새로고침 플러그인 재시작 코드 반영" },
    params: {},
    returns: "{ reloaded: true }",
    message: () => tmsg("msg.window.reload"),
    examples: ["window.reload"],
    handler: async () => {
      // 리로드 전에 이 창의 child 표면(브라우저)을 먼저 숨긴다 — 렌더러 재부팅 구간
      // (JS 공백 ~150ms)에 이전 브라우저가 그대로 떠 있던 유령 창은 부트 서두 숨김만으로는
      // 닫히지 않는다(그 숨김은 새 렌더러 진입 후에야 돈다). 숨김 완료가 리로드보다 먼저다.
      try {
        const stale = await invoke<string[]>("webview_list");
        const prefix = browserLabelPrefix();
        const mine = stale.filter((l) => l.startsWith(prefix));
        await Promise.all(
          mine.map((l) =>
            invoke("webview_visible", { label: l, visible: false }).catch(() => {}),
          ),
        );
        if (mine.length > 0)
          await invoke("activity_publish", {
            kind: "webview.lifecycle",
            source: "webview",
            payload: {
              event: "hidden-at-reload",
              labels: mine,
              origin: "internal",
              message: `· webview hidden before reload ×${mine.length}`,
            },
          }).catch(() => {});
      } catch {
        /* 표면 없음/조회 실패 — 리로드를 막지 않는다 */
      }
      // 소켓 응답을 먼저 흘려보낸 뒤 다음 틱에 리로드(응답 유실 방지).
      setTimeout(() => window.location.reload(), 30);
      return { reloaded: true };
    },
  });

  // ── 멀티 윈도우 ──────────────────────────────────────────────────────────
  register("window.open", {
    description:
      "Open a new project window for a project root (P6: if the root is already open in some window, no window is created — that window is focused and returned as existingWindow). root is required unless mode orchestrator, which brings the control plane (main) forward instead — opening and creating projects live there; empty project windows do not exist.",
    triggers: { ko: "새 창 창 열기 새 윈도우 프로젝트 새 창 오케스트레이터 창" },
    params: {
      root: {
        type: "string",
        description: "Project root to open in the new window (absolute path).",
      },
      alias: {
        type: "string",
        description: "Display alias for the project tab (defaults to the folder name).",
      },
      shell: {
        type: "string",
        description: "Shell binary for the project's terminals (defaults to the user shell).",
      },
      mode: {
        type: "string",
        description:
          "orchestrator = bring the control plane (main) forward. Mutually exclusive with root.",
        enum: ["orchestrator"],
      },
    },
    returns: "{ label } | { existingWindow } (root already open — focused instead)",
    message: (d) =>
      d.existingWindow ? tmsg("msg.window.open.existing") : tmsg("msg.window.open.created"),
    errors: ["INVALID_PARAMS"],
    hint: (d) => {
      if (d.code) return [];
      // 새 창의 라벨을 겨냥해 명령을 보내는 법을 제시한다(--window <label>).
      const label = (d.label as string | undefined) ?? (d.existingWindow as string | undefined);
      if (!label) return [];
      return [
        {
          cmd: `--window ${label} state.tree`,
          why: tmsg("hint.flow.window.open.target", { label }),
        },
      ];
    },
    examples: [
      'window.open \'{"root":"/Users/me/work"}\'',
      'window.open \'{"mode":"orchestrator"}\'',
    ],
    handler: async (p) => {
      if (p.mode === "orchestrator") {
        if (p.root) {
          return {
            ok: false as const,
            code: "INVALID_PARAMS" as const,
            message: "mode=orchestrator 는 root 와 함께 쓸 수 없음",
          };
        }
        // 컨트롤 플레인은 main 하나뿐(NAMING 4b 예약어) — 있으면 앞으로, 사용자가 닫았으면
        // 같은 예약 라벨로 재개설한다(부트가 라벨로 분기하므로 init 불요).
        const labels = await invoke<string[]>("window_list");
        if (labels.includes("main")) {
          await invoke("window_focus", { label: "main" }).catch(() => {});
          return { existingWindow: "main" };
        }
        await invoke("window_create", { label: "main" });
        return { label: "main" };
      }
      // 빈 워크스페이스 창은 없다 — 프로젝트 열기·생성은 컨트롤 플레인(main)의 표면이다.
      if (!p.root) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: "root 필요 — 프로젝트 열기·생성은 오케스트레이터(main)에서",
        };
      }
      let root: string;
      try {
        root = await validateProjectRoot(p.root as string);
      } catch (e) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: String(e),
        };
      }
      // P6 선검사: 이미 열려 있으면 창을 만들지 않고 소유 창 포커스(중복 창 0).
      // 검사↔생성 사이 레이스는 새 창 부트의 claim 이 최종 시행(실패 시 빈 상태로 열화).
      const owners = await invoke<{ owners: { root: string; window: string }[] }>(
        "project_owners",
      );
      const owner = owners.owners.find((o) => o.root === root)?.window;
      if (owner) {
        await invoke("window_focus", { label: owner }).catch(() => {});
        return { existingWindow: owner };
      }
      let init = `root=${encodeURIComponent(root)}`;
      if (typeof p.alias === "string" && p.alias) init += `&alias=${encodeURIComponent(p.alias)}`;
      if (typeof p.shell === "string" && p.shell) init += `&shell=${encodeURIComponent(p.shell)}`;
      return { label: await invoke<string>("window_create", { init }) };
    },
  });

  register("window.list", {
    description: "List open window labels. Use to discover targets for commands that accept a window argument.",
    triggers: { ko: "창 목록 윈도우 목록 열린 창" },
    params: {},
    returns: "{ labels }",
    message: (d) => tmsg("msg.window.list", { n: ((d.labels as unknown[]) ?? []).length }),
    examples: ["window.list"],
    handler: async () => ({ labels: await invoke<string[]>("window_list") }),
  });

  // 보존된 직전 세대를 사람이 볼 수 있어야 안전망이다 — 못 꺼내는 백업은 백업이 아니다.
  register("window.restorePrevious", {
    description:
      "Inspect or restore the previous workspace generation for a window. Saves that lose content (projects or tabs disappearing) preserve the prior snapshot first, because the store overwrites in place and the backup ring only rotates hourly. Without `apply` this only reports what is there.",
    triggers: { ko: "이전 워크스페이스 복구 직전 세대 되돌리기 작업 복구" },
    params: {
      label: P.windowLabel,
      apply: {
        type: "boolean",
        description: "Write the previous generation back (default false = report only).",
      },
    },
    returns: "{ found, projects, tabs, applied }",
    message: (d) =>
      d.found
        ? tmsg("msg.window.restorePrevious.found", {
            n: Number(d.projects ?? 0),
            applied: String(d.applied),
          })
        : tmsg("msg.window.restorePrevious.none"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["window.restorePrevious", 'window.restorePrevious \'{"apply":true}\''],
    handler: async (p) => {
      const label = windowTarget(p);
      const key = `window/${label}`;
      const prev = await invoke<WindowSnapshotLike | null>("data_kv_get", {
        ns: "core",
        key: previousGenerationKey(key),
      });
      if (!prev) return { found: false, projects: 0, tabs: 0, applied: false };
      const size = snapshotSize(prev);
      if (p.apply !== true) return { found: true, ...size, applied: false };
      // 되돌리는 것도 잃는 쓰기일 수 있다 — 지금 값을 그 자리에 남기고 바꾼다(왕복 가능).
      const now = await invoke<WindowSnapshotLike | null>("data_kv_get", { ns: "core", key });
      await invoke("data_kv_set", { ns: "core", key, value: prev });
      await invoke("data_kv_set", { ns: "core", key: previousGenerationKey(key), value: now });
      return { found: true, ...size, applied: true };
    },
  });

  register("window.projects", {
    description:
      "Map open windows to the project each one hosts (root path + name + window label). The meaning layer over window.list — use it first to pick the right window before targeting commands with --window. Same answer from any window (process-wide registry).",
    triggers: { ko: "창 프로젝트 매핑 어느 창 프로젝트 열림 창별 프로젝트" },
    params: {},
    returns: "{ projects: [{ root, name, window }] }",
    message: (d) => tmsg("msg.window.projects", { n: ((d.projects as unknown[]) ?? []).length }),
    examples: ["window.projects"],
    handler: async () => {
      const owners = await invoke<{ owners: { root: string; window: string }[] }>(
        "project_owners",
      );
      const projects = owners.owners.map((o) => ({
        root: o.root,
        name: o.root.split("/").filter(Boolean).pop() ?? o.root,
        window: o.window,
      }));
      return { projects };
    },
  });

  register("window.close", {
    description:
      "Close a window. Omit label to close the window this command is addressed to — the envelope already names it, so the common case needs no argument. An unknown label is TARGET_NOT_FOUND, not an internal failure.",
    triggers: { ko: "창 닫기 윈도우 닫기" },
    params: { label: P.windowLabel },
    returns: "{ ok, label }",
    message: () => tmsg("msg.window.close"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["window.close", 'window.close \'{"label":"w-<uuid>"}\''],
    handler: async (p) => {
      // 봉투가 이미 대상 창을 지목했는데 label 을 또 요구하면, 그 창에 대고 부른 close 가
      // 인자 누락으로 죽는다(실측: e2e 가 자기 창을 못 닫아 실행할 때마다 뷰가 쌓였다).
      // 나머지 표면과 같은 규칙을 따른다 — 생략 = 지금 대상.
      const label = windowTarget(p);
      const labels = await invoke<string[]>("window_list");
      if (!labels.includes(label)) return notFound(`창 없음: ${label}`);
      // 닫으라는 명령은 장부도 고친다 — 창만 없애면 다음 부팅이 되살린다(forgetWindowSlot).
      // 자기 창을 닫는 경로에서도 파괴보다 먼저다: 파괴 뒤엔 이 코드가 살아 있지 않다.
      await forgetWindowSlot(label);
      if (label === currentWindowLabel()) {
        // 자기를 파괴하는 명령은 답을 먼저 흘린다 — 답할 통로가 그 파괴로 함께 죽기 때문이다
        // (실측: 자기 창 close 가 WINDOW_DESTROYED 로 돌아와, 닫혔는데도 호출자는 실패로 읽었다).
        // window.reload 가 같은 이유로 같은 모양을 쓴다.
        setTimeout(() => void invoke("window_close", { label }), 30);
        return { ok: true, label };
      }
      await invoke("window_close", { label });
      return { ok: true, label };
    },
  });

  register("window.occlusion", {
    description:
      "Toggle occlusion detection. When false, rendering continues even when fully covered by other apps (for continuous background capture — note battery cost). Not needed for normal use; snapshot/record disable it automatically during capture.",
    params: {
      enabled: {
        type: "boolean",
        description: "Occlusion detection on (default) / off",
        required: true,
      },
    },
    returns: "{ occlusion }",
    message: (d) =>
      d.occlusion ? tmsg("msg.window.occlusion.on") : tmsg("msg.window.occlusion.off"),
    examples: ['window.occlusion \'{"enabled":false}\''],
    handler: async (p) => {
      const enabled = !!p.enabled;
      await invoke("plugin:webview-capture|set_occlusion", { enabled });
      return { occlusion: enabled };
    },
  });

  register("window.layers", {
    description:
      "Dump the window's native view hierarchy (class / frame / hidden, indented text). Ground truth for layer diagnostics — verify a native child webview's actual bounds and z-order against the DOM slot (e.g. divider-drag freeze, hole-punch mismatch).",
    triggers: {
      ko: "네이티브 뷰 계층 레이어 덤프 child 위치 진단",
    },
    params: {},
    returns: "{ hierarchy } — indented text, one view per line",
    message: () => tmsg("msg.window.layers"),
    examples: ["window.layers"],
    handler: async () => {
      const hierarchy = await invoke<string>("webview_debug_hierarchy");
      return { hierarchy };
    },
  });

  register("window.monitors", {
    description:
      "Monitor and window placement facts (physical px): every monitor's rect/scale/name and every window's rect, focus state, and owning monitor index. Facts only — placement strategy is layout.suggest, execution is window.place (same coordinate space).",
    triggers: {
      ko: "모니터 목록 해상도 창 배치 현황 듀얼 모니터 파악",
    },
    params: {},
    returns:
      "{ monitors: [{index,name,x,y,w,h,scale}], windows: [{label,title,x,y,w,h,focused,monitor}] }",
    message: (d) =>
      tmsg("msg.window.monitors", {
        n: ((d.monitors as unknown[]) ?? []).length,
        m: ((d.windows as unknown[]) ?? []).length,
      }),
    examples: ["window.monitors"],
    handler: async () => {
      return (await invoke("window_monitors")) as object;
    },
  });

  register("window.place", {
    description:
      "Place a window at an exact frame (physical px — the window.monitors coordinate space). Position and size applied once. Use layout.suggest output directly. The OS may clamp frames into the usable area (e.g. below the macOS menu bar) — read back window.monitors for the settled frame.",
    triggers: {
      ko: "창 배치 이동 모니터로 옮기기 위치 지정",
    },
    params: {
      label: P.windowLabel,
      x: { type: "number", description: "Left edge (physical px)", required: true },
      y: { type: "number", description: "Top edge (physical px)", required: true },
      w: { type: "number", description: "Width (physical px)", required: true },
      h: { type: "number", description: "Height (physical px)", required: true },
    },
    returns: "{ ok }",
    message: () => tmsg("msg.window.place"),
    errors: ["TARGET_NOT_FOUND"],
    examples: [
      'window.place \'{"x":0,"y":0,"w":2560,"h":1440}\'',
      'window.place \'{"label":"main","x":2560,"y":0,"w":2560,"h":1440}\'',
    ],
    handler: async (p) => {
      const label = windowTarget(p);
      const labels = await invoke<string[]>("window_list");
      if (!labels.includes(label)) return notFound(`창 없음: ${label}`);
      await invoke("window_place", { label, x: p.x, y: p.y, w: p.w, h: p.h });
      return {};
    },
  });
}
