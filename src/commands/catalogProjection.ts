// 사이드바 투영 명령 표면(plans/sidebar-projection-spec.md §4.2) — ui.projection.* / ui.intent.open.
// registerCatalog() 말미에서 등록(catalog 분할 — catalogUi 선례).

import { tmsg } from "../i18n";
import { register } from "./registry";
import { err, ok, projectIdOfView, useSessions } from "../state/sessions";
import { useProjection } from "../state/projection";
import { projectionFor } from "../state/projectionWiring";
import { getRegisteredView } from "../plugins/viewRegistry";

const SIDES = ["left", "right"] as const;
type Side = (typeof SIDES)[number];

import type { CommandContext } from "./registry";

// 대상 프로젝트: 명시 param > 호출자 pane 의 프로젝트(ctx) > 활성 프로젝트.
function targetProject(p: Record<string, unknown>, ctx?: CommandContext): string {
  return (
    (p.project as string | undefined) ??
    (ctx?.pane ? projectIdOfView(ctx.pane) ?? undefined : undefined) ??
    useSessions.getState().activeId
  );
}

function pinsOf(projectId: string) {
  return (
    useProjection.getState().byProject[projectId]?.pins ?? { left: [], right: [] }
  );
}

export function registerProjectionCatalog(): void {
  register("ui.projection.state", {
    description:
      "Read the sidebar projection state of a project: the bound content view (binding follows the session active chain — switching the active tab inside a group changes the binding too), resolved left/right rail slots with instanceKey and status (live|degraded|satisfied-by-pin), and pinned refs.",
    triggers: { ko: "투영상태 결부 사이드바상태 레일상태 projection binding rail" },
    params: {
      project: {
        type: "string",
        description: "Project id (omit for the active project)",
      },
    },
    returns:
      "{ projectId, binding: {viewId|null}, left: {slots:[{source,resolvedRef,instance,instanceKey,status}], template}, right|null, pins: {left,right} }",
    message: (d) =>
      tmsg("msg.ui.projection.state", {
        view: String((d.binding as { viewId?: string | null })?.viewId ?? "-"),
      }),
    examples: ["ui.projection.state", 'ui.projection.state \'{"project":"t1"}\''],
    handler: (p, ctx) => {
      const pid = targetProject(p, ctx);
      const proj = projectionFor(pid);
      if (!proj) return err("TARGET_NOT_FOUND", `프로젝트 없음: ${pid}`);
      const focusHistory =
        useProjection.getState().byProject[pid]?.focusHistory ?? [];
      return ok({ projectId: pid, ...proj, focusHistory });
    },
  });

  register("ui.projection.pin", {
    description:
      "Pin a rail view ref to a rail side. Pins are user-owned state that persists across binding changes; a pinned shared ref absorbs the matching projection slot (satisfied-by-pin). Only registered views carrying the rail placement are pinnable.",
    triggers: { ko: "핀 고정 레일핀 pin rail" },
    params: {
      ref: {
        type: "string",
        description: 'Rail view ref "<pluginId>.<viewId>"',
        required: true,
      },
      side: { type: "string", description: '"left" (default) | "right"' },
      project: {
        type: "string",
        description: "Project id (omit for the active project)",
      },
    },
    returns: "{ pins: {left, right} }",
    message: () => tmsg("msg.ui.projection.pin"),
    examples: ['ui.projection.pin \'{"ref":"<pluginId>.<viewId>"}\''],
    handler: (p, ctx) => {
      const pid = targetProject(p, ctx);
      if (!useSessions.getState().tabs.some((t) => t.id === pid)) {
        return err("TARGET_NOT_FOUND", `프로젝트 없음: ${pid}`);
      }
      const side = ((p.side as string | undefined) ?? "left") as Side;
      if (!SIDES.includes(side)) {
        return err("INVALID_PARAMS", "side 는 left|right");
      }
      // [임시] 우측 핀 스택 렌더러가 아직 없다 — 렌더 없는 흡수(뷰 소실)를 막기 위해 거부.
      // 제거 조건: PluginSidebar 가 pins.right 스택을 렌더하는 유닛이 병합되는 즉시 개방.
      if (side === "right") {
        return err(
          "INVALID_PARAMS",
          "우측 핀은 아직 지원 전(우 핀 스택 렌더러 부재) — 좌측만 가능",
        );
      }
      const ref = p.ref as string;
      const reg = getRegisteredView(ref);
      // 핀 대상 = 상주형뿐(② — 사이드바 임의 탑재 제한): resident:true 를 선언한 rail 뷰,
      // 또는 앨리어스 기간의 레거시 sidebar-* placement 뷰(상주형 함대의 구 매니페스트).
      // 그 외 rail 뷰는 선언-투영 전용 — 콘텐츠 기능에 종속된다.
      const legacyResident =
        !!reg &&
        ["sidebar-left", "sidebar-right", "sidebar-footer"].some((pl) =>
          reg.decl.placements.includes(pl as never),
        );
      const pinnable = !!reg && (reg.decl.resident || legacyResident);
      if (!pinnable) {
        return err(
          "INVALID_PARAMS",
          `핀 불가: ${ref} — 핀은 상주형(resident) 뷰만. 그 외 사이드바는 콘텐츠 기능의 선언으로만 나타난다(R4·②)`,
        );
      }
      // per-view 인스턴스는 핀 불가(R4) — 현재 투영에서 이 ref 가 per-view 슬롯로 해소 중이면 거부.
      const cur = projectionFor(pid);
      const perView = [
        ...(cur?.left.slots ?? []),
        ...(cur?.right?.slots ?? []),
      ].some((sl) => sl.resolvedRef === ref && sl.instance === "per-view");
      if (perView) {
        return err(
          "INVALID_PARAMS",
          `per-view 참조는 핀 불가(R4): ${ref} — shared 참조·상주형만 핀 가능`,
        );
      }
      // 발화는 스토어 구독(추적 sweep 지문)이 단일 경로로 담당 — 여기서 emit 하지 않는다
      // (no-op 핀이면 스토어 무변경 → 무발화).
      useProjection.getState().pin(pid, side, ref);
      return ok({ pins: pinsOf(pid) });
    },
  });

  register("ui.projection.unpin", {
    description:
      "Remove a pinned ref from a rail side. Idempotent — unpinning an absent ref succeeds. No rail-registration check: a ref must stay removable after its plugin is gone.",
    triggers: { ko: "핀해제 언핀 unpin" },
    params: {
      ref: { type: "string", description: "Pinned ref", required: true },
      side: { type: "string", description: '"left" (default) | "right"' },
      project: {
        type: "string",
        description: "Project id (omit for the active project)",
      },
    },
    returns: "{ pins: {left, right} }",
    message: () => tmsg("msg.ui.projection.unpin"),
    examples: ['ui.projection.unpin \'{"ref":"<pluginId>.<viewId>"}\''],
    handler: (p, ctx) => {
      const pid = targetProject(p, ctx);
      if (!useSessions.getState().tabs.some((t) => t.id === pid)) {
        return err("TARGET_NOT_FOUND", `프로젝트 없음: ${pid}`);
      }
      const side = ((p.side as string | undefined) ?? "left") as Side;
      if (!SIDES.includes(side)) {
        return err("INVALID_PARAMS", "side 는 left|right");
      }
      useProjection.getState().unpin(pid, side, p.ref as string);
      return ok({ pins: pinsOf(pid) });
    },
  });

  register("ui.intent.open", {
    description:
      "Open a resource through the binding context (R2): places the view as a tab in the bound group without replacing existing panels, reusing the existing view for the same resource (idempotent). The same path the rail's open affordance uses. With no binding (empty project) it places into the active group.",
    triggers: { ko: "인텐트열기 결부열기 intent open" },
    params: {
      path: {
        type: "string",
        description: "Absolute file path to open",
        required: true,
      },
      project: {
        type: "string",
        description: "Project id (omit for the active project)",
      },
    },
    returns: "{ viewId, groupId, existing }",
    message: (d) =>
      tmsg(d.existing ? "msg.ui.intent.open.existing" : "msg.ui.intent.open"),
    examples: ['ui.intent.open \'{"path":"/work/notes/plan.md"}\''],
    handler: (p, ctx) => {
      const pid = targetProject(p, ctx);
      return useSessions.getState().openFileView(pid, p.path as string);
    },
  });
}
