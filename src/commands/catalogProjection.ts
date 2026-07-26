// 사이드바 투영 명령 표면(plans/sidebar-projection-spec.md §4.2) — ui.projection.* / ui.intent.open.
// registerCatalog() 말미에서 등록(catalog 분할 — catalogUi 선례).

import { tmsg } from "../i18n";
import { register } from "./registry";
import { asSurface } from "./catalog";
import { err, ok, projectIdOfView, useSessions } from "../state/sessions";
import { useProjection } from "../state/projection";
import { projectionFor } from "../state/projectionWiring";

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
      "Reserved. The left rail is projection-only — it renders the bound content view's declared sidebar and nothing user-pinned, so left pins are always rejected. Right-side pinning is the reserved plugin surface and stays rejected until the right pin stack renderer ships. Use unpin to clean stale pins from old snapshots.",
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
      if (!useSessions.getState().projects.some((t) => t.id === pid)) {
        return err("TARGET_NOT_FOUND", `프로젝트 없음: ${pid}`);
      }
      const side = ((p.side as string | undefined) ?? "left") as Side;
      if (!SIDES.includes(side)) {
        return err("INVALID_PARAMS", "side 는 left|right");
      }
      // 좌 레일은 결부된 기능의 투영 전용이다(2026-07-22 결정) — 사용자 핀 축이 없다.
      // 상주(플러그인 소유) 표면은 우측 레일의 몫으로만 남는다.
      if (side === "left") {
        return err(
          "INVALID_PARAMS",
          "좌 레일은 결부된 기능의 투영 전용 — 핀이 없습니다. 상주 표면은 우측 레일의 몫입니다",
        );
      }
      // [임시] 우측 핀 스택 렌더러가 아직 없다 — 렌더 없는 흡수(뷰 소실)를 막기 위해 거부.
      // 제거 조건: PluginSidebar 가 pins.right 스택을 렌더하는 유닛이 병합되는 즉시 개방.
      return err("INVALID_PARAMS", "우측 핀은 아직 지원 전(우 핀 스택 렌더러 부재)");
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
      if (!useSessions.getState().projects.some((t) => t.id === pid)) {
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
    returns: "{ viewId, panelId, existing }",
    message: (d) =>
      tmsg(d.existing ? "msg.ui.intent.open.existing" : "msg.ui.intent.open"),
    examples: ['ui.intent.open \'{"path":"/work/notes/plan.md"}\''],
    handler: (p, ctx) => {
      const pid = targetProject(p, ctx);
      // 공개 어휘 사상(groupId → panelId)은 asSurface 한 곳이 소유한다 — 이 명령만 세션 내부
      // 이름을 그대로 흘려 명령 표면의 어휘가 갈려 있었다(docs 감사 게이트가 잡음).
      return asSurface(useSessions.getState().openFileView(pid, p.path as string));
    },
  });
}
