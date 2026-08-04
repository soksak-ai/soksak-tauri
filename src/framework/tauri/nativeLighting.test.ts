// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { collectNativeLighting, createNativeLightingSync } from "./nativeLighting";

function surface(label: string, amount: number): HTMLElement {
  const body = document.createElement("div");
  body.className = "tab-body";
  body.dataset.dim = amount === 0 ? "clear" : "idle";
  body.style.setProperty("--dim", String(amount));
  const slot = document.createElement("div");
  slot.dataset.contentViewBody = label;
  body.append(slot);
  document.body.append(body);
  return body;
}

describe("Tauri native surface lighting", () => {
  it("공개 content slot identity와 tab-body의 공개 dim 상태만 읽는다", () => {
    document.body.innerHTML = "";
    surface("b-main-a", 0.5);
    surface("b-main-b", 0);
    expect(collectNativeLighting(document)).toEqual([
      { label: "b-main-a", amount: 0.5 },
      { label: "b-main-b", amount: 0 },
    ]);
  });

  it("바뀐 surface만 보내고 사라진 surface는 clear한다", async () => {
    document.body.innerHTML = "";
    const a = surface("b-main-a", 0.5);
    const send = vi.fn(async () => undefined);
    const sync = createNativeLightingSync(send);
    await sync(document);
    await sync(document);
    expect(send.mock.calls).toEqual([["b-main-a", 0.5]]);
    a.remove();
    await sync(document);
    expect(send.mock.calls).toEqual([
      ["b-main-a", 0.5],
      ["b-main-a", 0],
    ]);
  });

  it("native 적용이 실패하면 같은 사실을 성공할 때까지 재시도한다", async () => {
    document.body.innerHTML = "";
    surface("b-main-a", 0.5);
    const send = vi
      .fn<(label: string, amount: number) => Promise<void>>()
      .mockRejectedValueOnce(new Error("native commit failed"))
      .mockResolvedValue(undefined);
    const sync = createNativeLightingSync(send);
    await expect(sync(document)).rejects.toThrow("native commit failed");
    await expect(sync(document)).resolves.toBeUndefined();
    expect(send.mock.calls).toEqual([
      ["b-main-a", 0.5],
      ["b-main-a", 0.5],
    ]);
  });
});
