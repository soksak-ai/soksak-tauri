// webview 건강(서킷 브레이커) 커맨드 — 렌더러 프로세스 크래시 감지·자동 복구의 관측/수동
// 복구 표면(플랜 W6). 상태의 단일 진실은 코어 Rust(webview_health.rs) — 여기는 노출만.
// 자동 복구는 per-label 브레이커(60s 윈도우 상한 3회, 지수 백오프)가 코어에서 수행하고,
// 상한 소진(open)은 activity(webview.crash.exhausted)+창 배지로 드러난다 — 이 명령들이
// 에이전트/사람의 나머지 반쪽(읽기·수동 복구)이다.

import { invoke } from "../framework";
import { register, type CommandHint } from "./registry";
import { tmsg } from "../i18n";
import { allViews, useSessions } from "../state/sessions";
import { browserLabelPrefix, browserViewIdFromLabel, orphanBrowserLabels } from "../lib/webviewLabels";
import { CONTENT_VIEW_BODY, contentViewHost } from "../lib/contentViews";

interface LabelHealth {
  label: string;
  state: "closed" | "recovering" | "open";
  attempt: number | null;
  crashesInWindow: number;
  totalCrashes: number;
  lastCrashAgoMs: number | null;
  lastReason: string | null;
}

export function registerWebviewCatalog(): void {
  register("webview.surfaces", {
    description:
      "Reconcile this window's state (which views exist) against the browser content views actually alive for this window. ghosts = views whose view no longer exists in state — a stale surface floating over the window (the 'browser over an empty window' mismatch). detached = content surfaces that live in the document but not inside the slot that declared them — they are being pushed by coordinates, so slot and surface are two clocks and one of them is always late (empty pane, edge afterimage). A non-empty ghosts or detached list is always a defect fact. Judged from the same sources the app itself uses (state store + the content view host), no pixels involved.",
    triggers: { ko: "표면 정합 유령 웹뷰 잔존 브라우저 대조 확인" },
    params: {},
    returns:
      "{ window, actual: [label], ghosts: [label], orphans: [label], engine: {registered, hostPresent}, bodies: [{node,x,y,w,h,children,overlay,…}], contentViews: {inDocument, detached: [label]}, stateViews }",
    message: (d) => {
      const bad =
        Number((d.ghosts as string[] | undefined)?.length ?? 0) +
        Number((d.orphans as string[] | undefined)?.length ?? 0) +
        Number((d.contentViews as { detached?: string[] } | undefined)?.detached?.length ?? 0);
      return bad > 0
        ? tmsg("msg.webview.surfaces.ghost", { n: bad })
        : tmsg("msg.webview.surfaces.clean", { n: Number(d.stateViews ?? 0) });
    },
    examples: ["webview.surfaces"],
    handler: async () => {
      // **호스트에게 묻는다.** 프레임워크의 네이티브 목록(webview_list)만 보면, 콘텐츠가 문서
      // 안에 사는 구현에서는 살아 있는 표면이 셋인데 목록이 비어 답이 통째로 공짜가 된다 —
      // 유령 판정이 빈 집합에서 나오니 언제나 "유령 없음"이다(실측 2026-08-03: 브라우저 뷰 3개가
      // 떠 있는데 actual: []). 호스트는 두 구현 모두 자기 목록을 안다.
      const labels = await contentViewHost().list();
      const mine = labels.filter((l) => l.startsWith(browserLabelPrefix()));
      // 전역 고아 — 부모 창이 이미 닫힌 child(b-<win>-…)는 어느 창의 접두사에도 안 걸려
      // 창-로컬 대조가 영영 못 본다(실사고: 빈 main 창 위에 닫힌 하니스 창의 브라우저가
      // 떠 있었다). 부모 생존은 창 목록 접두사 매칭으로 판정한다 — label 문법 b-<창>-<view>.
      const windows = await invoke<string[]>("window_list").catch(() => [] as string[]);
      const orphans = orphanBrowserLabels(labels, windows);
      const viewIds = new Set<string>();
      for (const t of useSessions.getState().projects)
        for (const c of t.spaces) for (const v of allViews(c.layout)) viewIds.add(v.id);
      const ghosts = mine.filter((l) => {
        const v = browserViewIdFromLabel(l);
        return v !== null && !viewIds.has(v);
      });
      if (ghosts.length > 0 || orphans.length > 0) {
        // 유령은 발견 즉시 활동 허브에 사실로 남는다 — 픽셀 없이 판독 가능(sok events).
        void invoke("activity_publish", {
          kind: "surface.ghost",
          source: "webview",
          payload: {
            ghosts,
            orphans,
            stateViews: viewIds.size,
            message: `· surface ghost ×${ghosts.length} orphan ×${orphans.length}: ${[...ghosts, ...orphans].join(", ")}`,
            origin: "internal",
          },
        }).catch(() => {});
      }
      // 엔진(CEF) 축 — WKWebView 목록이 못 보는 표면(실사고: reload 후 이전 브라우저
      // 프레임 잔존을 "유령 없음"으로 오판). registered = 코어 layer 에 등록된 서피스 수.
      const engine = await invoke<{ registered: number; hostPresent: boolean }>(
        "engine_surface_stats",
      ).catch(() => ({ registered: -1, hostPresent: false }));
      // 뷰 본문 사실 — "빈 공간"의 분기(정상 렌더/사유 카드/plugin-empty/진짜 빈 마운트)를
      // 기계가 구분한다(실사고: 검은 구글의 분기를 픽셀로만 추측했다). 렌더러 명령이라 DOM 직독.
      const bodies: Record<string, unknown>[] = [];
      for (const el of document.querySelectorAll<HTMLElement>(".tab-viewer.plugin-view-container")) {
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.x + r.width <= 0 || r.x >= window.innerWidth) continue;
        const body = el.parentElement;
        bodies.push({
          node: el.getAttribute("data-node") ?? el.getAttribute("data-view-addr") ?? "?",
          // 자리도 사실이다 — 크기만 실은 rect 는 반쪽이고, "표면이 접힌 자리에 정확히
          // 섰는가"를 물을 수 없다. 콘텐츠가 페이지 안에 사는 프레임워크에서는 이 넷이
          // 네이티브 자식 프레임과 같은 축의 답이다.
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
          children: el.childElementCount,
          shadowChildren: el.shadowRoot ? el.shadowRoot.childElementCount : null,
          firstClass: (el.firstElementChild?.className ?? "").toString().slice(0, 60),
          firstHtml: (el.firstElementChild?.outerHTML ?? "").slice(0, 160),
          overlay: body?.querySelector(".plugin-error")
            ? "error"
            : body?.querySelector(".plugin-empty")
              ? "empty"
              : body?.querySelector(".plugin-loading")
                ? "loading"
                : "none",
        });
      }
      // 표면이 **자기 자리에 사는가.** 문서 안에 사는 표면은 선언된 자리의 자손이어야 한다 —
      // 자리 밖에 있으면 그 표면은 좌표로 밀리고 있다는 뜻이고, 자리와 표면이 두 기준이 되어
      // 하나는 반드시 늦는다(슬롯은 새 자리, 표면은 옛 자리 = 빈 판·경계의 잔상).
      //
      // 프레임워크를 묻지 않는다: 문서에 표면이 없으면 셋 다 0 이고 그것이 사실이다. 있는데
      // 자리 밖이면 detached 에 이름이 남는다 — "없음"과 "밖에 있음"이 갈린다.
      const detached: string[] = [];
      const inDocument = document.querySelectorAll("[data-content-view]");
      for (const el of inDocument) {
        const own = el.getAttribute("data-content-view") ?? "";
        if (el.parentElement?.closest(`[${CONTENT_VIEW_BODY}]`)?.getAttribute(CONTENT_VIEW_BODY) !== own)
          detached.push(own);
      }
      return {
        actual: mine,
        ghosts,
        orphans,
        engine,
        bodies,
        stateViews: viewIds.size,
        contentViews: { inDocument: inDocument.length, detached },
      };
    },
  });

  register("webview.health.query", {
    description:
      "Report webview renderer-process health per label: circuit-breaker state (closed / recovering / open), crash counts in the rolling 60s window, lifetime total, and the last termination reason if the platform provided one. Labels: a window label is that window's main webview, b-<win>-<view> is a browser child. state=open means automatic recovery is exhausted — recover it manually with webview.recover.",
    triggers: { ko: "웹뷰 건강 웹뷰 상태 크래시 조회 복구 상태" },
    params: {},
    returns:
      "{ count, entries: [{label, state, attempt, crashesInWindow, totalCrashes, lastCrashAgoMs, lastReason}] }",
    message: (d) => tmsg("msg.webview.health.query", { n: Number(d.count ?? 0) }),
    hint: (d) => {
      const entries = Array.isArray(d.entries) ? (d.entries as LabelHealth[]) : [];
      return entries
        .filter((e) => e.state === "open")
        .slice(0, 3)
        .map<CommandHint>((e) => ({
          cmd: `webview.recover '{"label":"${e.label}"}'`,
          why: `${e.label} 는 자동 복구가 중단된 상태(open)입니다 — 수동 복구로 되살립니다`,
        }));
    },
    examples: ["webview.health.query"],
    handler: async () => {
      const entries = await invoke<LabelHealth[]>("webview_health_query");
      return { count: entries.length, entries };
    },
  });

  register("webview.recover", {
    description:
      "Manually recover a webview: reset its circuit breaker (clears the crash window and the open state) and reload it in place. Use after webview.health.query shows state=open, or any time a webview is blank/wedged. The window's main webview reloads through the normal boot path (terminals survive — PTYs live in the core); a browser child (b-<win>-<view>) reloads in place without being re-created.",
    triggers: { ko: "웹뷰 복구 웹뷰 되살리기 크래시 복구 화면 복구" },
    params: {
      label: {
        type: "string",
        description:
          "webview label — a window label for that window's main webview, or b-<win>-<view> for a browser child (list via webview.health.query or window.list)",
        required: true,
      },
    },
    primary: "label",
    returns: "{ label, reloaded: true }",
    message: (d) => tmsg("msg.webview.recover", { label: String(d.label) }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['webview.recover \'{"label":"b-w-1234-v7"}\''],
    handler: async (p) => {
      try {
        await invoke("webview_recover", { label: p.label });
      } catch (e) {
        const msg = String(e);
        // 코어 존재 검사 실패("webview 없음")를 typed 에러로 승격(R9 — raw 에러 누출 금지).
        if (msg.includes("webview 없음"))
          return { ok: false as const, code: "TARGET_NOT_FOUND" as const, message: msg };
        throw e;
      }
      return { label: p.label, reloaded: true };
    },
  });
}
