// 사이드바 투영 명령 표면(plans/sidebar-projection-spec.md §4.2) — ui.projection.* / ui.intent.open.
// registerCatalog() 말미에서 등록(catalog 분할 — catalogUi 선례).

import { tmsg } from "../i18n";
import { register } from "./registry";
import { err, ok, useSessions } from "../state/sessions";
import { useProjection } from "../state/projection";
import { projectionFor } from "../state/projectionWiring";
import { getRegisteredView } from "../plugins/viewRegistry";
import { emitPluginEvent } from "../plugins/hooks";

const SIDES = ["left", "right"] as const;
type Side = (typeof SIDES)[number];

function targetProject(p: Record<string, unknown>): string {
  return (p.project as string | undefined) ?? useSessions.getState().activeId;
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
    handler: (p) => {
      const pid = targetProject(p);
      const proj = projectionFor(pid);
      if (!proj) return err("TARGET_NOT_FOUND", `프로젝트 없음: ${pid}`);
      return ok({ projectId: pid, ...proj });
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
    handler: (p) => {
      const pid = targetProject(p);
      if (!useSessions.getState().tabs.some((t) => t.id === pid)) {
        return err("TARGET_NOT_FOUND", `프로젝트 없음: ${pid}`);
      }
      const side = ((p.side as string | undefined) ?? "left") as Side;
      if (!SIDES.includes(side)) {
        return err("INVALID_PARAMS", "side 는 left|right");
      }
      const ref = p.ref as string;
      const reg = getRegisteredView(ref);
      if (!reg || !reg.decl.placements.includes("rail")) {
        return err(
          "INVALID_PARAMS",
          `rail 뷰가 아님: ${ref} — 핀은 rail 배치로 등록된 뷰만(R4)`,
        );
      }
      useProjection.getState().pin(pid, side, ref);
      emitPluginEvent("projection.changed", {
        projectId: pid,
        viewId: projectionFor(pid)?.binding.viewId ?? null,
      });
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
    handler: (p) => {
      const pid = targetProject(p);
      if (!useSessions.getState().tabs.some((t) => t.id === pid)) {
        return err("TARGET_NOT_FOUND", `프로젝트 없음: ${pid}`);
      }
      const side = ((p.side as string | undefined) ?? "left") as Side;
      if (!SIDES.includes(side)) {
        return err("INVALID_PARAMS", "side 는 left|right");
      }
      useProjection.getState().unpin(pid, side, p.ref as string);
      emitPluginEvent("projection.changed", {
        projectId: pid,
        viewId: projectionFor(pid)?.binding.viewId ?? null,
      });
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
    handler: (p) => {
      const pid = targetProject(p);
      return useSessions.getState().openFileView(pid, p.path as string);
    },
  });
}
