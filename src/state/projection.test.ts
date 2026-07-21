// 사이드바 투영 코어(plans/sidebar-projection-spec.md §4·R1~R7) — 해소는 순수 파생, 스토어는
// focusHistory·pins 만 소유(A8: 결부 정본 = 세션 활성 체인, 이중진실 금지).
import { beforeEach, describe, expect, it } from "vitest";
import {
  resolveProjection,
  useProjection,
  type BoundView,
  type ProjectionDeps,
} from "./projection";
import type { ContributedSidebar } from "../plugins/spec";

const P = "proj-1";

function deps(over: Partial<ProjectionDeps> = {}): ProjectionDeps {
  return {
    resolveContract: () => null,
    isRailView: () => false,
    consumesOf: () => [],
    ...over,
  };
}

function bound(sidebar: ContributedSidebar | null, viewId = "v1", owner = "termplug"): BoundView {
  return { viewId, groupId: "g1", contentId: "c1", ownerPluginId: owner, sidebar };
}

const NO_PINS = { left: [], right: [] };

describe("resolveProjection — 슬롯 해소(R1·R5)", () => {
  it("결부 null → 빈 좌 슬롯 + 우 null(핀만 남는 상태)", () => {
    const p = resolveProjection(P, null, NO_PINS, deps());
    expect(p.binding.viewId).toBeNull();
    expect(p.left.slots).toEqual([]);
    expect(p.right).toBeNull();
  });

  it("선언 부재 → 좌 단일 degraded 슬롯(source undeclared), 우 null", () => {
    const p = resolveProjection(P, bound(null), NO_PINS, deps());
    expect(p.left.slots).toEqual([
      {
        source: "undeclared",
        resolvedRef: null,
        instance: "shared",
        instanceKey: null,
        status: "degraded",
      },
    ]);
    expect(p.right).toBeNull();
  });

  it("self 참조 live — shared/per-view instanceKey 형식", () => {
    const sb: ContributedSidebar = {
      left: [
        { ref: "self.tree", instance: "shared" },
        { ref: "self.blocks", instance: "per-view" },
      ],
      right: [],
      template: "stack",
    };
    const p = resolveProjection(
      P,
      bound(sb, "v9"),
      NO_PINS,
      deps({ isRailView: (k) => k === "termplug.tree" || k === "termplug.blocks" }),
    );
    expect(p.left.slots[0]).toMatchObject({
      source: "self:termplug.tree",
      resolvedRef: "termplug.tree",
      instanceKey: `${P}|termplug.tree`,
      status: "live",
    });
    expect(p.left.slots[1]).toMatchObject({
      resolvedRef: "termplug.blocks",
      instanceKey: `${P}|termplug.blocks|v9`,
      status: "live",
    });
    expect(p.left.template).toBe("stack");
    expect(p.right).toBeNull(); // right 빈 배열 = 없음
  });

  it("self 참조 대상이 rail 로 등록돼 있지 않으면 degraded", () => {
    const sb: ContributedSidebar = {
      left: [{ ref: "self.tree", instance: "shared" }],
      right: [],
      template: "stack",
    };
    const p = resolveProjection(P, bound(sb), NO_PINS, deps({ isRailView: () => false }));
    expect(p.left.slots[0].status).toBe("degraded");
    expect(p.left.slots[0].instanceKey).toBeNull();
  });

  it("contract 슬롯 — consumes 미선언이면 구현체가 있어도 degraded(계약-핀 게이트)", () => {
    const sb: ContributedSidebar = {
      left: [
        { contract: "soksak-spec-plugin-sidebar-file-tree", range: "^0.0.1", view: "tree", instance: "shared" },
      ],
      right: [],
      template: "stack",
    };
    const p = resolveProjection(
      P,
      bound(sb),
      NO_PINS,
      deps({
        resolveContract: () => "filetree",
        isRailView: () => true,
        consumesOf: () => [], // 미선언
      }),
    );
    expect(p.left.slots[0].status).toBe("degraded");
  });

  it("contract 슬롯 — 활성 구현체 0 이면 degraded, 있으면 live(resolvedRef=구현체.view)", () => {
    const sb: ContributedSidebar = {
      left: [
        { contract: "soksak-spec-plugin-sidebar-file-tree", range: "^0.0.1", view: "tree", instance: "shared" },
      ],
      right: [],
      template: "stack",
    };
    const consumes = () => ["soksak-spec-plugin-sidebar-file-tree"];
    const none = resolveProjection(
      P, bound(sb), NO_PINS,
      deps({ resolveContract: () => null, isRailView: () => true, consumesOf: consumes }),
    );
    expect(none.left.slots[0].status).toBe("degraded");
    const live = resolveProjection(
      P, bound(sb), NO_PINS,
      deps({
        resolveContract: (req) =>
          req.id === "soksak-spec-plugin-sidebar-file-tree" ? "filetree" : null,
        isRailView: (k) => k === "filetree.tree",
        consumesOf: consumes,
      }),
    );
    expect(live.left.slots[0]).toMatchObject({
      source: "contract:soksak-spec-plugin-sidebar-file-tree",
      resolvedRef: "filetree.tree",
      instanceKey: `${P}|filetree.tree`,
      status: "live",
    });
  });

  it("핀 흡수(R4) — shared live 슬롯의 ref 가 핀에 있으면 satisfied-by-pin, per-view 는 핀 무시", () => {
    const sb: ContributedSidebar = {
      left: [
        { ref: "self.tree", instance: "shared" },
        { ref: "self.blocks", instance: "per-view" },
      ],
      right: [],
      template: "stack",
    };
    const p = resolveProjection(
      P,
      bound(sb, "v2"),
      { left: ["termplug.tree", "termplug.blocks"], right: [] },
      deps({ isRailView: () => true }),
    );
    expect(p.left.slots[0].status).toBe("satisfied-by-pin");
    expect(p.left.slots[0].instanceKey).toBe(`${P}|termplug.tree`); // 핀이 같은 인스턴스를 렌더
    expect(p.left.slots[1].status).toBe("live"); // per-view 는 흡수 대상 아님
  });

  it("우측 선언 시 해소, 슬롯 1개면 template=single", () => {
    const sb: ContributedSidebar = {
      left: [{ ref: "self.tree", instance: "shared" }],
      right: [{ ref: "self.inspector", instance: "per-view" }],
      template: "tabs",
    };
    const p = resolveProjection(P, bound(sb, "v3"), NO_PINS, deps({ isRailView: () => true }));
    expect(p.left.template).toBe("single"); // 1개 슬롯 → single
    expect(p.right).not.toBeNull();
    expect(p.right?.slots[0]).toMatchObject({
      resolvedRef: "termplug.inspector",
      instanceKey: `${P}|termplug.inspector|v3`,
      status: "live",
    });
    expect(p.right?.template).toBe("single");
  });
});

describe("useProjection 스토어 — focusHistory·pins(사용자 소유 상태만)", () => {
  beforeEach(() => {
    useProjection.setState({ byProject: {} });
  });

  it("noteBinding — 최근순 dedupe", () => {
    const s = useProjection.getState();
    s.noteBinding(P, "v1");
    s.noteBinding(P, "v2");
    s.noteBinding(P, "v1");
    expect(useProjection.getState().byProject[P].focusHistory).toEqual(["v1", "v2"]);
  });

  it("forgetView — 닫힌 뷰를 이력에서 제거(R6 승계 재료 정리)", () => {
    const s = useProjection.getState();
    s.noteBinding(P, "v1");
    s.noteBinding(P, "v2");
    s.forgetView(P, "v2");
    expect(useProjection.getState().byProject[P].focusHistory).toEqual(["v1"]);
  });

  it("pin/unpin — 멱등, 좌우 독립", () => {
    const s = useProjection.getState();
    s.pin(P, "left", "filetree.tree");
    s.pin(P, "left", "filetree.tree"); // 멱등
    s.pin(P, "right", "picker.selections");
    expect(useProjection.getState().byProject[P].pins).toEqual({
      left: ["filetree.tree"],
      right: ["picker.selections"],
    });
    s.unpin(P, "left", "filetree.tree");
    s.unpin(P, "left", "filetree.tree"); // 멱등
    expect(useProjection.getState().byProject[P].pins.left).toEqual([]);
  });

  it("dropProject — 프로젝트 닫힘 시 상태 회수", () => {
    const s = useProjection.getState();
    s.noteBinding(P, "v1");
    s.dropProject(P);
    expect(useProjection.getState().byProject[P]).toBeUndefined();
  });
});

describe("핀 마이그레이션(§7.1) — adoptPins·autoPin·seen", () => {
  beforeEach(() => {
    useProjection.setState({ byProject: {} });
  });

  it("adoptPins — 기존 배치(leftLayout) 키를 핀으로 일괄 채용, seen 기록", () => {
    const s = useProjection.getState();
    s.adoptPins(P, "left", ["a.tree", "b.mail"]);
    const e = useProjection.getState().byProject[P];
    expect(e.pins.left).toEqual(["a.tree", "b.mail"]);
    expect(e.seen.left).toEqual(["a.tree", "b.mail"]);
  });

  it("autoPin — 미인지 ref 만 핀, seen 이후엔 재핀 안 함(unpin 유지)", () => {
    const s = useProjection.getState();
    s.autoPin(P, "left", "a.tree");
    expect(useProjection.getState().byProject[P].pins.left).toEqual(["a.tree"]);
    s.unpin(P, "left", "a.tree");
    s.autoPin(P, "left", "a.tree"); // seen — 재핀 금지
    expect(useProjection.getState().byProject[P].pins.left).toEqual([]);
  });

  it("수동 pin 도 seen 을 남긴다", () => {
    const s = useProjection.getState();
    s.pin(P, "left", "a.tree");
    expect(useProjection.getState().byProject[P].seen.left).toEqual(["a.tree"]);
  });
});

describe("seedProject — 복원 씨딩(§4.5·R9)", () => {
  beforeEach(() => {
    useProjection.setState({ byProject: {} });
  });

  it("부재 시에만 씨딩(라이브 상태 클로버 금지), pins·seen 복원", () => {
    const s = useProjection.getState();
    s.seedProject(P, { pins: { left: ["a.t"], right: [] }, seen: { left: ["a.t", "b.m"], right: [] } });
    expect(useProjection.getState().byProject[P].pins.left).toEqual(["a.t"]);
    expect(useProjection.getState().byProject[P].seen.left).toEqual(["a.t", "b.m"]);
    // 이미 있으면 no-op
    s.seedProject(P, { pins: { left: ["x.y"], right: [] }, seen: { left: [], right: [] } });
    expect(useProjection.getState().byProject[P].pins.left).toEqual(["a.t"]);
  });

  it("씨딩된 seen 은 auto-pin 부활을 막는다(R9 동형 — unpin 의사 보존)", () => {
    const s = useProjection.getState();
    s.seedProject(P, { pins: { left: [], right: [] }, seen: { left: ["mail.inbox"], right: [] } });
    s.autoPin(P, "left", "mail.inbox");
    expect(useProjection.getState().byProject[P].pins.left).toEqual([]);
  });
});
