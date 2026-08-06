import { describe, expect, it } from "vitest";
import { PluginViewSlotRegistry } from "./pluginViewSlots";

const frame = {
  label: "b-main-v1", x: 0, y: 28, w: 500, h: 372, rootW: 500, rootH: 400,
  revision: 1, reportedAtUnixMs: 1,
};

describe("plugin renderer slot event barrier", () => {
  it("이미 보고된 slot을 즉시 돌려준다", async () => {
    const slots = new PluginViewSlotRegistry();
    slots.report(frame);
    await expect(slots.wait(frame.label, 50)).resolves.toEqual(frame);
  });

  it("open이 먼저 와도 뒤따른 slot 사건으로 이어서 진행한다", async () => {
    const slots = new PluginViewSlotRegistry();
    const waiting = slots.wait(frame.label, 100);
    queueMicrotask(() => slots.report(frame));
    await expect(waiting).resolves.toEqual(frame);
  });

  it("수치 관측면은 child revision과 부모 수신 시각을 함께 보존한다", () => {
    const slots = new PluginViewSlotRegistry();
    slots.report(frame);
    expect(slots.frames()).toEqual([{ ...frame, receivedAtUnixMs: expect.any(Number) }]);
  });

  it("slot 사건이 없으면 유한 시간 뒤 실패한다", async () => {
    const slots = new PluginViewSlotRegistry();
    await expect(slots.wait(frame.label, 5)).rejects.toThrow("content slot 시간 초과");
  });

  it("보고만 된 slot은 native commit 배리어를 통과하지 않는다", async () => {
    const slots = new PluginViewSlotRegistry();
    slots.report(frame);
    await expect(slots.waitCommittedRoot(frame.label, 500, 400, 5))
      .rejects.toThrow('native commit 시간 초과: b-main-v1 root=500x400 reported={"rootW":500');
  });

  it("현재 viewport에 적용된 native commit 사건으로 배리어를 해제한다", async () => {
    const slots = new PluginViewSlotRegistry();
    const waiting = slots.waitCommittedRoot(frame.label, 500, 400, 100);
    queueMicrotask(() => slots.commit(frame));
    await expect(waiting).resolves.toEqual(frame);
  });

  it("이전 viewport의 늦은 commit은 현재 viewport 배리어를 해제하지 않는다", async () => {
    const slots = new PluginViewSlotRegistry();
    const current = { ...frame, rootW: 740, rootH: 520, revision: 3 };
    const waiting = slots.waitCommittedRoot(frame.label, 740, 520, 100);
    slots.commit({ ...frame, revision: 2 });
    queueMicrotask(() => slots.commit(current));
    await expect(waiting).resolves.toEqual(current);
  });
});
