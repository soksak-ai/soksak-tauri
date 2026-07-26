// status.query(R8 회신) 통합 — sessions 에 보고된 status 가 execute() 회신에 그대로 오는지.
import { beforeEach, describe, expect, it, vi } from "vitest";

// catalog 가 import 시 settings(localStorage)를 참조할 수 있어 stub 을 먼저.
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
});

import { registerCatalog } from "./catalog";
import { execute } from "./registry";
import { useSessions } from "../state/sessions";

useSessions.getState().bootstrapFirstProject("/tmp/soksak-statusquery");
registerCatalog();
const pristineTabs = JSON.parse(JSON.stringify(useSessions.getState().projects));
const pristineActive = useSessions.getState().activeId;

let seq = 0;
function mkTab(status?: { code: string; message?: string }): string {
  const r = useSessions.getState().openPluginView("t1", "p", `v${seq++}`, "T");
  if (!r.ok) throw new Error("openPluginView 실패");
  if (status) useSessions.getState().setViewStatus("t1", r.viewId, status);
  return r.viewId;
}

type StatusRes = { statuses: { tabId: string; code: string; message?: string }[] };

beforeEach(() => {
  useSessions.setState({
    projects: JSON.parse(JSON.stringify(pristineTabs)),
    activeId: pristineActive,
  });
});

describe("status.query — 보고 == 회신(R8)", () => {
  it("보고한 status 가 회신에 그대로 온다", async () => {
    const tid = mkTab({ code: "busy", message: "작업 중" });
    const res = (await execute("status.query", {}, {})) as unknown as { data: StatusRes };
    expect(res.data.statuses).toContainEqual({
      tabId: tid,
      code: "busy",
      message: "작업 중",
    });
  });

  it("status 미보고 탭만이면 빈 배열", async () => {
    mkTab();
    const res = (await execute("status.query", {}, {})) as unknown as { data: StatusRes };
    expect(res.data.statuses).toEqual([]);
  });

  it("tab 파라미터로 특정 탭만 회신", async () => {
    const a = mkTab({ code: "busy", message: "A" });
    mkTab({ code: "dirty" });
    const res = (await execute(
      "status.query",
      { tab: a },
      {},
    )) as unknown as { data: StatusRes };
    expect(res.data.statuses).toHaveLength(1);
    expect(res.data.statuses[0].tabId).toBe(a);
  });
});
