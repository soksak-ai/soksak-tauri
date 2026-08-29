// settings.* / theme.* — 설정과 테마 카탈로그(분권 — 단일 진실은 동일 registry).
//
// 코어 카탈로그에서 분리한다: 봉인된 파일 길이(scripts/gates/baseline-file-length.txt)가
// catalog.ts 를 1500줄 이하로 쪼개라고 요구했고, 이 블록은 이미 자기 축이 뚜렷하다
// (설정 값 하나와 그 적용 자리). 선례와 같은 모양이다(catalogCapture·catalogDebug).
//
// 터미널 외형(shell/font/cursor/scrollback/renderer)은 여기 없다 — 코어 설정이 아니라
// 터미널 플러그인이 소유한다(manifest configuration → plugin.<id>.settings.*).

import { invoke, frameworkPath } from "../framework";
import { recordWindowFrames } from "./windowRecorder";
import { suggestLayout, type MonitorFact, type WindowFact } from "../lib/layoutSuggest";
import { tmsg } from "../i18n";
import { register } from "./registry";
import { notFound } from "./refuse";
import { serialize, useSettings } from "../state/settings";
import { useTheme } from "../state/theme";
import { useIconRegistry } from "../ui/icons/registry";
import { applyWindowZoom } from "../lib/zoomIntent";

export function registerSettingsCatalog(): void {
  // splitHeaderMode 는 탭 모드 고정(2026-06 결정)으로 표면에서 제외.
  const SETTING_KEYS = [
    "language",
    "projectTabPosition",
    "contentTabPosition",
    "iconSet",
    "iconBox",
    "focusIndicator",
    "railRelation",
    "railFill",
    "focusDim",
    "railSeamStyle",
    "railPullFocused",
    "railSolidColor",
    "dimIdle",
    "dimBlocked",
    "appFontFamily",
    "windowZoom",
    "orchestratorAgent",
    "orchestratorModel",
  ] as const;

  register("settings.get", {
    description: "Retrieve all application settings.",
    triggers: { ko: "설정 확인 앱 설정 조회 환경설정" },
    params: {},
    returns: "{ <every persisted setting>, iconSets[], theme, themeMode }",
    message: () => tmsg("msg.settings.get"),
    examples: ["settings.get"],
    handler: () => {
      const s = useSettings.getState();
      return {
        // **저장되는 것은 전부 읽힌다.** 쓰기 목록(SETTING_KEYS)에서 파생하면 전용 명령을 가진
        // 설정들이 조용히 빠지고, 그중 하나(railLook)는 아예 물어볼 자리가 없었다. 읽기의
        // 원천은 영속 스냅샷 하나다 — 저장 목록이 자라면 읽기도 함께 자란다.
        ...serialize(s),
        // 선택 가능한 아이콘 셋 목록(내장 + 활성 플러그인 등록분).
        iconSets: Object.values(useIconRegistry.getState().sets).map((x) => ({
          id: x.id,
          name: x.name,
        })),
        theme: useTheme.getState().current,
        themeMode: useTheme.getState().effectiveMode,
      };
    },
  });

  register("settings.set", {
    description: `Change an application setting. key: ${SETTING_KEYS.join("|")}`,
    triggers: { ko: "설정 변경 설정 바꾸기 환경설정 변경 폰트 크기 언어" },
    params: {
      key: {
        type: "string",
        description: "Setting key",
        enum: SETTING_KEYS,
        required: true,
      },
      value: {
        type: "json",
        description:
          "Value — language:ko|en, projectTabPosition:top|left, contentTabPosition:top|left, iconSet:string (registered set id — unregistered falls back to lucide), iconBox:boolean, focusIndicator:outline|corners, railRelation:tint|moment|stroke (rail-pane relation surface — tint fill only, moment flash on rebind, stroke outline+label), railFill:none|faint (bound-pane background in stroke mode — none is the default, faint is a 1% accent tint), focusDim:boolean (spotlight — every pane dims except the active one), railSeamStyle:seam|edge (how a manufactured FLOW adjacency is marked: seam dashes the inner shared edge, edge dashes the outer right edge), railPullFocused:boolean (FLOW-only blocked-line policy: true minimally swaps a leaf pane to preserve adjacency; false preserves pane order and stops the rail at the nearest clean line. PIN always preserves both the rail station and pane layout), railSolidColor:string (CSS color for a solid relation seam — empty leaves it to the theme), dimIdle:number (0-1 — how far a pane that is not focused sinks), dimBlocked:number (0-1 — how far a pane stranded between the rail and the focused pane sinks; deeper than dimIdle, or being covered is invisible), appFontFamily:string (CSS font-family stack), windowZoom:number (0.5-2.0 — whole-window zoom factor applied to the main webview and every child webview), orchestratorAgent:string (agent CLI command or path the natural-language console spawns), orchestratorModel:string (--model alias for the agent; empty = CLI default)",
        required: true,
      },
    },
    returns: "{ key, value }",
    message: (d) => tmsg("msg.settings.set", { key: String(d.key) }),
    errors: ["INVALID_PARAMS"],
    examples: [
      'settings.set \'{"key":"projectTabPosition","value":"left"}\'',
      'settings.set \'{"key":"contentTabPosition","value":"left"}\'',
      'settings.set \'{"key":"iconBox","value":true}\'',
    ],
    handler: async (p) => {
      const s = useSettings.getState();
      const key = p.key as (typeof SETTING_KEYS)[number];
      const v = p.value;
      const bad = (need: string) => ({
        ok: false as const,
        code: "INVALID_PARAMS" as const,
        message: `${key}: ${need} 이어야 함`,
      });
      switch (key) {
        case "language":
          if (v !== "ko" && v !== "en") return bad("ko|en");
          s.setLanguage(v);
          break;
        case "projectTabPosition":
          if (v !== "top" && v !== "left") return bad("top|left");
          s.setProjectTabPosition(v);
          break;
        case "contentTabPosition":
          if (v !== "top" && v !== "left") return bad("top|left");
          s.setContentTabPosition(v);
          break;
        case "iconSet":
          if (typeof v !== "string" || !v.trim())
            return bad("string(셋 id — settings.get 의 iconSets 참조)");
          s.setIconSet(v.trim());
          break;
        case "iconBox":
          if (typeof v !== "boolean") return bad("boolean");
          s.setIconBox(v);
          break;
        case "focusIndicator":
          if (v !== "outline" && v !== "corners") return bad("outline|corners");
          s.setFocusIndicator(v);
          break;
        case "railRelation":
          if (v !== "tint" && v !== "moment" && v !== "stroke")
            return bad("tint|moment|stroke");
          s.setRailRelation(v);
          break;
        case "railFill":
          if (v !== "none" && v !== "faint") return bad("none|faint");
          s.setRailFill(v);
          break;
        case "focusDim":
          if (typeof v !== "boolean") return bad("boolean");
          s.setFocusDim(v);
          break;
        case "railSeamStyle":
          if (v !== "seam" && v !== "edge") return bad("seam|edge");
          s.setRailSeamStyle(v);
          break;
        case "railPullFocused":
          if (typeof v !== "boolean") return bad("boolean");
          s.setRailPullFocused(v);
          break;
        case "railSolidColor": // "" = 테마에 맡긴다
          if (typeof v !== "string") return bad("string(CSS 색)");
          s.setRailSolidColor(v.trim());
          break;
        // 세기 두 축은 같은 규칙 — 따로 적으면 한쪽만 고쳐진다. 숫자 아닌 값을 0 으로 접지
        // 않는다: 0 은 "안 흐림"이라는 뜻이 있어 조용한 성공이 된다.
        case "dimIdle":
        case "dimBlocked":
          if (typeof v !== "number" || !Number.isFinite(v)) return bad("number(0~1)");
          (key === "dimIdle" ? s.setDimIdle : s.setDimBlocked)(v);
          break;
        case "appFontFamily":
          if (typeof v !== "string" || !v.trim())
            return bad("string(CSS font-family 스택)");
          s.setAppFontFamily(v.trim());
          break;
        case "windowZoom":
          if (typeof v !== "number" || !Number.isFinite(v))
            return bad("number(0.5~2.0 클램프)");
          s.setWindowZoom(v);
          await applyWindowZoom(useSettings.getState().windowZoom);
          break;
        case "orchestratorAgent":
          if (typeof v !== "string" || !v.trim())
            return bad("string(에이전트 CLI 명령 또는 경로)");
          s.setOrchestratorAgent(v.trim());
          break;
        case "orchestratorModel":
          if (typeof v !== "string") return bad('string(모델 별칭 — "" = CLI 기본)');
          s.setOrchestratorModel(v.trim());
          break;
        default:
          // **키 목록에 올리고 분기를 빠뜨리면 조용히 성공한다.** 그러면 부른 쪽은 설정이
          // 바뀌었다고 믿고 그 위에 흐름을 세우는데 값은 그대로다(실측 2026-08-02:
          // railPullFocused 가 OK 를 받고 안 바뀌었다). 안 다루는 키는 이름을 달고 거절한다.
          return {
            ok: false as const,
            code: "INVALID_PARAMS" as const,
            message: `이 설정은 아직 적용 자리가 없습니다: ${key}`,
          };
      }
      return { key, value: v };
    },
  });

  register("layout.suggest", {
    description:
      "Suggest window placements from current monitor/window facts (pure strategy — nothing moves). strategy spread: orchestrator windows take a monitor free of project windows whole (or the right third alongside on a single monitor); project windows fill their own monitor. strategy grid: tile all windows on the first monitor. Feed each placement to window.place to execute.",
    triggers: {
      ko: "창 배치 제안 전략 모니터 분배 오케스트레이터 배치",
    },
    params: {
      strategy: {
        type: "string",
        description: "Placement strategy",
        enum: ["spread", "grid"],
        default: "spread",
      },
      roles: {
        type: "json",
        description:
          'Optional label→role map, e.g. {"main":"orchestrator"} — unlisted windows count as project windows',
      },
    },
    returns: "{ placements: [{label,monitor,x,y,w,h}] }",
    message: (d) => tmsg("msg.layout.suggest", { n: ((d.placements as unknown[]) ?? []).length }),
    examples: [
      'layout.suggest \'{"strategy":"spread","roles":{"main":"orchestrator"}}\'',
    ],
    handler: async (p) => {
      const facts = (await invoke("window_monitors")) as {
        monitors: MonitorFact[];
        windows: WindowFact[];
      };
      const placements = suggestLayout({
        monitors: facts.monitors,
        windows: facts.windows,
        strategy: (p.strategy as "spread" | "grid") ?? "spread",
        roles: (p.roles as Record<string, "orchestrator" | "project">) ?? undefined,
      });
      return { placements };
    },
  });

  register("activity.recent", {
    description:
      "Query the app-wide activity stream (P12 execution visibility): registry command executions (command/source/danger/duration/outcome — param keys only, no values), terminal command start/finish, AI turn ends, view activations. Cursor with since (exclusive seq) to fetch only new entries; entries carry monotonic seq + epoch-ms ts. Same answer from any window (process-wide singleton hub).",
    triggers: {
      ko: "활동 피드 실행 기록 최근 명령 스트림 조회 오케스트레이터",
    },
    params: {
      since: {
        type: "number",
        description: "Return entries with seq greater than this (backfill cursor). Omit for latest.",
      },
      limit: {
        type: "number",
        description: "Maximum entries to return (default 200)",
        default: 200,
      },
    },
    // 답은 주인이 정한다 — 어느 창에서 돌든 같다(registry.ts windowScoped).
    windowScoped: false,
    returns: "{ entries: [{ seq, ts, kind, source, payload }] }",
    message: (d) => tmsg("msg.activity.recent", { n: ((d.entries as unknown[]) ?? []).length }),
    examples: [
      'activity.recent \'{"limit":20}\'',
      'activity.recent \'{"since":1234}\'',
    ],
    // §5 R2: 조회도 사실이다 — 기록된다(선형 증가일 뿐 되먹임 아님. 낭독 루프는 tts 축이
    // 차단). 컴포넌트 자기 백필은 호출측이 origin:"internal" 로 선언(노출만 낮아짐).
    handler: async (p) => {
      const entries = await invoke("activity_recent", {
        since: p.since ?? null,
        limit: p.limit ?? 200,
      });
      return { entries };
    },
  });

  register("window.themeScan", {
    description:
      "Measure whether a dark/light theme transition is atomic across screen regions. Records the toggle, then reports each region's transition frame and how many frames they are out of sync (a torn frame is chrome already switched while content has not). Idempotent — replaces ad-hoc capture scripts. Restores the original theme when done.",
    triggers: {
      ko: "테마 전환 검사 원자성 깜빡임 tear 측정 다크 라이트 토글 회귀",
    },
    params: {
      theme: {
        type: "string",
        description: "Theme name to scan (default: current theme)",
      },
      from: {
        type: "string",
        description: "Starting mode (default dark)",
        enum: ["light", "dark"],
      },
      to: {
        type: "string",
        description: "Ending mode (default light)",
        enum: ["light", "dark"],
      },
      frames: { type: "number", description: "Frames to capture (default 40)" },
      intervalMs: {
        type: "number",
        description: "Frame interval in ms (default 16 ≈ one display frame)",
      },
      applyAtMs: {
        type: "number",
        description: "Delay after recording starts before toggling (default 250)",
      },
      settleMs: {
        type: "number",
        description: "Settle wait after setting the start mode (default 800)",
      },
      skipCapture: {
        type: "boolean",
        description:
          "Measure latency only (applyJsMs, applyReflowMs) and skip frame capture — fast, robust even when the window is backgrounded. For A/B latency tuning.",
      },
      regions: {
        type: "json",
        description:
          "Named fractional rects {name:{x0,y0,x1,y1}} (0..1). Default samples chrome top bar, center content, and left sidebar.",
      },
    },
    returns:
      "{ frames, frameMs (measured capture interval), spreadFrames, spreadMs, atomic, regions:[{name,start,end,transitionFrame}] }",
    message: (d) =>
      d.atomic !== undefined
        ? d.atomic
          ? tmsg("msg.window.themeScan.atomic")
          : tmsg("msg.window.themeScan.torn", { n: Number(d.spreadFrames) })
        : tmsg("msg.window.themeScan"),
    examples: [
      "window.themeScan",
      'window.themeScan \'{"theme":"Midnight","frames":48}\'',
    ],
    handler: async (p) => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const ts = useTheme.getState();
      const theme = (p.theme as string | undefined) ?? ts.current;
      const startMode = (p.from as "light" | "dark" | undefined) ?? "dark";
      const endMode = (p.to as "light" | "dark" | undefined) ?? "light";
      // 기본값은 RPC 10s 안에 여유로 들어오게 보수적으로(네이티브 캡처가 프레임당 ~55ms 로
      // intervalMs 보다 느리고 가끔 stall — 전환은 3~5프레임이라 20프레임이면 충분).
      const frames = (p.frames as number | undefined) ?? 20;
      const intervalMs = (p.intervalMs as number | undefined) ?? 16;
      const applyAtMs = (p.applyAtMs as number | undefined) ?? 180;
      const settleMs = (p.settleMs as number | undefined) ?? 600;
      const regionMap =
        (p.regions as Record<
          string,
          { x0: number; y0: number; x1: number; y1: number }
        >) ?? {
          // 크롬 상단바 / 중앙 콘텐츠(에디터·터미널) / 좌측 사이드바 — tear 를 드러내는 세 구역.
          top: { x0: 0.3, y0: 0.0, x1: 0.95, y1: 0.06 },
          center: { x0: 0.45, y0: 0.15, x1: 0.95, y1: 0.85 },
          left: { x0: 0.02, y0: 0.2, x1: 0.22, y1: 0.85 },
        };
      const names = Object.keys(regionMap);
      const regionList = names.map((n) => regionMap[n]);

      // 원래 테마/모드 — 검사 후 복원(부수효과 없는 멱등 호출).
      const prevTheme = ts.current;
      const prevMode = ts.effectiveMode;

      let stage = "start";
      try {
        stage = "path";
        const { tempDir, join } = frameworkPath;
        const dir = await join(
          await tempDir(),
          "soksak",
          `themescan-${Date.now()}`,
        );

        // 1) 시작 모드로 세팅 + settle.
        stage = "applyStart";
        useTheme.getState().apply(theme, startMode);
        await sleep(settleMs);
        // 1b) clean 지연 측정(캡처 전, 동시 캡처가 rAF 를 느리게 해 오염되지 않게). rAF 대신 강제
        // reflow(offsetHeight)로 동기 style recalc+layout 을 잰다 — 백그라운드 창에서도 견고
        // (paint/composite 는 제외되나 recalc+layout 이 테마 변경의 주 비용). applyJsMs=동기 JS
        // (플러그인 theme.changed 핸들러), applyReflowMs=그 위에 recalc+layout 까지.
        stage = "measurePaint";
        const applyT0 = performance.now();
        useTheme.getState().apply(theme, endMode);
        const applyJsMs = performance.now() - applyT0;
        void document.documentElement.offsetHeight;
        const applyReflowMs = performance.now() - applyT0;
        // skipCapture: 캡처 없이 지연만 — 빠르고 견고(가려진 창·헤드리스에서도). 최적화 A/B 용.
        if (p.skipCapture) {
          useTheme.getState().apply(prevTheme, prevMode);
          return {
            applyJsMs: Math.round(applyJsMs),
            applyReflowMs: Math.round(applyReflowMs),
            skipped: "capture",
          };
        }
        // 캡처 패스를 위해 다시 startMode 로 되돌리고 짧게 settle.
        useTheme.getState().apply(theme, startMode);
        await sleep(250);
        // 2) 녹화 시작(비대기) → applyAtMs 후 끝 모드로 토글 → 녹화 완료 대기.
        stage = "record";
        const recT0 = performance.now();
        const recP = recordWindowFrames({
          dir,
          frames,
          intervalMs,
        });
        await sleep(applyAtMs);
        useTheme.getState().apply(theme, endMode);
        const n = await recP;
        // 실측 프레임 간격(네이티브 캡처가 intervalMs 보다 느릴 수 있음 — tear ms 는 이것 기준).
        const realFrameMs = n > 0 ? (performance.now() - recT0) / n : intervalMs;
        // 3) 프레임별 영역 명도 → tear 판정.
        stage = "analyze";
        const grid = await invoke<number[][]>(
          "plugin:webview-capture|analyze_regions",
          { dir, regions: regionList },
        );
        // 4) 원래 테마 복원.
        useTheme.getState().apply(prevTheme, prevMode);

        stage = "interpret";
        const round = (v: number) => Math.round(v);
        const per = names.map((name, c) => {
          const start = grid[0]?.[c] ?? 0;
          const end = grid[grid.length - 1]?.[c] ?? 0;
          const mid = (start + end) / 2;
          const rising = end >= start;
          let transitionFrame = -1;
          for (let f = 0; f < grid.length; f++) {
            const v = grid[f]?.[c] ?? 0;
            if (rising ? v >= mid : v <= mid) {
              transitionFrame = f;
              break;
            }
          }
          return { name, start: round(start), end: round(end), transitionFrame };
        });
        const tfs = per.map((r) => r.transitionFrame).filter((f) => f >= 0);
        const minTf = tfs.length ? Math.min(...tfs) : 0;
        const maxTf = tfs.length ? Math.max(...tfs) : 0;
        const spreadFrames = maxTf - minTf;
        return {
          frames: n,
          frameMs: Math.round(realFrameMs),
          applyJsMs: Math.round(applyJsMs),
          applyReflowMs: Math.round(applyReflowMs),
          spreadFrames,
          spreadMs: Math.round(spreadFrames * realFrameMs),
          atomic: spreadFrames === 0,
          regions: per,
        };
      } catch (e) {
        // 행이 아니라 실패면 단계와 함께 회신(타임아웃으로 침묵하지 않게).
        try {
          useTheme.getState().apply(prevTheme, prevMode);
        } catch {
          /* 복원 실패는 부차 */
        }
        return { error: String(e), stage };
      }
    },
  });

  register("theme.list", {
    description:
      "List available themes (built-in + external ~/.soksak/themes), including files that failed validation and their reasons.",
    triggers: { ko: "테마 목록 테마 보기 사용 가능 테마" },
    params: {},
    returns:
      "{ current, mode, themes:[{name,defaultMode,modes,source,warnings,relation}], rejected }",
    message: (d) => tmsg("msg.theme.list", { n: ((d.themes as unknown[]) ?? []).length }),
    examples: ["theme.list"],
    handler: () => {
      const s = useTheme.getState();
      return {
        current: s.current,
        mode: s.effectiveMode,
        themes: Object.values(s.themes).map((th) => ({
          name: th.name,
          defaultMode: th.defaultMode,
          modes: th.colorsAlt ? ["light", "dark"] : [th.defaultMode],
          source: th.source,
          warnings: s.warnings[th.name] ?? [],
          relation: th.relation,
        })),
        rejected: s.rejected,
      };
    },
  });

  register("theme.apply", {
    description: "Apply a theme (replaces all token slots). Omit mode to keep the current mode.",
    triggers: { ko: "테마 적용 테마 바꾸기 다크 모드 라이트 모드 색 테마" },
    params: {
      name: { type: "string", description: "Theme name (see theme.list)", required: true },
      mode: { type: "string", description: "Color mode", enum: ["light", "dark"] },
    },
    returns: "{ name, mode }",
    message: (d) => tmsg("msg.theme.apply", { name: String(d.name) }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['theme.apply \'{"name":"Paper"}\'', 'theme.apply \'{"name":"Midnight","mode":"light"}\''],
    handler: (p) => {
      const s = useTheme.getState();
      const ok2 = s.apply(p.name as string, p.mode as "light" | "dark" | undefined);
      if (!ok2) return notFound(`테마 없음: ${p.name}`);
      const cur = useTheme.getState();
      return { name: cur.current, mode: cur.effectiveMode };
    },
  });

  register("theme.reload", {
    description: "Re-scan the external theme directory (~/.soksak/themes) and re-apply the current theme.",
    triggers: { ko: "테마 새로고침 테마 리로드 외부 테마 재스캔" },
    params: {},
    returns: "{ count, rejected }",
    message: (d) => tmsg("msg.theme.reload", { n: Number(d.count) }),
    examples: ["theme.reload"],
    handler: async () => {
      await useTheme.getState().reload();
      const s = useTheme.getState();
      return { count: Object.keys(s.themes).length, rejected: s.rejected };
    },
  });

  register("theme.install", {
    description: "Install a theme JSON file into ~/.soksak/themes (immediately usable if validation passes).",
    triggers: { ko: "테마 설치 테마 추가 외부 테마 설치" },
    params: {
      path: { type: "string", description: "Absolute path to theme .json file", required: true },
    },
    returns: "{ installed(install path), rejected? }",
    message: (d) =>
      d.rejected
        ? tmsg("msg.theme.install.rejected")
        : tmsg("msg.theme.install.installed", { path: String(d.installed) }),
    errors: ["INTERNAL"],
    examples: ['theme.install \'{"path":"<local-evidence>/dracula.json"}\''],
    handler: async (p) => {
      const installed = await useTheme.getState().install(p.path as string);
      const s = useTheme.getState();
      const reject = s.rejected.find((r) => r.file === installed);
      return reject ? { installed, rejected: reject.errors } : { installed };
    },
  });

}
