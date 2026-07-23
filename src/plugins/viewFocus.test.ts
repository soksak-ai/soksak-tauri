import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PluginViewContext,
  PluginViewProvider,
} from "./viewRegistry";
import { ViewFocusCoordinator } from "./viewFocus";

const context = {
  projectId: "t1",
  root: null,
  paneId: null,
  viewId: null,
  boundViewId: null,
  command: null,
  restore: null,
  setBadge: () => {},
  setStatus: () => {},
  setTitle: () => {},
  setIcon: () => {},
  setRestoreState: () => {},
} satisfies PluginViewContext;

function provider(
  hooks: Partial<PluginViewProvider>,
): PluginViewProvider {
  return { mount: () => {}, ...hooks };
}

function fixture() {
  const frames: FrameRequestCallback[] = [];
  const coordinator = new ViewFocusCoordinator({
    schedule: (cb) => {
      frames.push(cb);
      return frames.length;
    },
    onError: (error) => {
      throw error;
    },
  });
  const flushFrame = () => {
    const pending = frames.splice(0);
    for (const cb of pending) cb(performance.now());
  };
  return { coordinator, frames, flushFrame };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("view focus ownership", () => {
  it("commits the source before activation and focuses the target after the click boundary", () => {
    const { coordinator, flushFrame } = fixture();
    const source = document.createElement("section");
    const sourceInput = document.createElement("textarea");
    source.appendChild(sourceInput);
    const target = document.createElement("section");
    const targetInput = document.createElement("textarea");
    target.appendChild(targetInput);
    document.body.append(source, target);

    const order: string[] = [];
    let composing = true;
    let commits = 0;
    sourceInput.addEventListener("focusout", () => {
      if (!composing) return;
      composing = false;
      commits += 1;
    });

    coordinator.registerMountedView(
      "source",
      source,
      provider({
        prepareFocusTransfer: (ownContainer) => {
          expect(ownContainer).toBe(source);
          order.push("prepare");
          if (!composing) return;
          composing = false;
          commits += 1;
        },
      }),
      () => context,
    );
    coordinator.registerMountedView(
      "target",
      target,
      provider({
        focus: (ownContainer, _ctx, request) => {
          expect(ownContainer).toBe(target);
          order.push("focus");
          if (!request.signal.aborted) targetInput.focus();
        },
      }),
      () => context,
    );

    sourceInput.focus();
    coordinator.transferFocus("source", "target", () => {
      order.push("activate");
    });

    expect(order).toEqual(["prepare", "activate"]);
    expect(commits).toBe(1);
    expect(document.activeElement).toBe(sourceInput);

    flushFrame();

    expect(order).toEqual(["prepare", "activate", "focus"]);
    expect(commits).toBe(1);
    expect(document.activeElement).toBe(targetInput);
  });

  it("restores a repeatedly activated view even when activation state is a no-op", () => {
    const { coordinator, flushFrame } = fixture();
    const target = document.createElement("section");
    const input = document.createElement("textarea");
    const outside = document.createElement("button");
    target.appendChild(input);
    document.body.append(target, outside);
    const focus = vi.fn(() => input.focus());

    coordinator.registerMountedView(
      "target",
      target,
      provider({ focus }),
      () => context,
    );

    coordinator.transferFocus("target", "target", () => {});
    flushFrame();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(input);

    outside.focus();
    coordinator.transferFocus("target", "target", () => {});
    flushFrame();
    expect(focus).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(input);
  });

  it("preserves a descendant focused by the trusted click default action", () => {
    const { coordinator, flushFrame } = fixture();
    const target = document.createElement("section");
    const clickedInput = document.createElement("input");
    target.appendChild(clickedInput);
    document.body.appendChild(target);
    const focus = vi.fn();
    const setFocused = vi.fn();

    coordinator.registerMountedView(
      "target",
      target,
      provider({ focus, setFocused }),
      () => context,
    );

    coordinator.requestFocus("target");
    expect(setFocused).toHaveBeenLastCalledWith(target, context, true);
    clickedInput.focus();
    flushFrame();

    expect(focus).not.toHaveBeenCalled();
    expect(setFocused).toHaveBeenCalledOnce();
    expect(setFocused).toHaveBeenLastCalledWith(target, context, true);
    expect(document.activeElement).toBe(clickedInput);
  });

  it("publishes focus ownership independently from keyboard focus execution", () => {
    const { coordinator, flushFrame } = fixture();
    const source = document.createElement("section");
    const target = document.createElement("section");
    document.body.append(source, target);
    const sourceFocused = vi.fn();
    const targetFocused = vi.fn();
    coordinator.registerMountedView(
      "source",
      source,
      provider({ setFocused: sourceFocused }),
      () => context,
    );
    coordinator.registerMountedView(
      "target",
      target,
      provider({ setFocused: targetFocused }),
      () => context,
    );

    coordinator.transferFocus("source", "target", () => {});
    expect(sourceFocused).toHaveBeenLastCalledWith(source, context, false);
    expect(targetFocused).toHaveBeenLastCalledWith(target, context, true);
    flushFrame();
  });

  it("lets only the latest request focus after delayed mount or async readiness", () => {
    const { coordinator, frames, flushFrame } = fixture();
    const a = document.createElement("section");
    const b = document.createElement("section");
    document.body.append(a, b);
    const focused: string[] = [];
    const delayedA: { run?: () => void } = {};

    coordinator.requestFocus("a");
    coordinator.requestFocus("b");
    coordinator.registerMountedView(
      "a",
      a,
      provider({ focus: () => focused.push("a") }),
      () => context,
    );
    expect(frames).toHaveLength(0);

    coordinator.registerMountedView(
      "b",
      b,
      provider({ focus: () => focused.push("b") }),
      () => context,
    );
    flushFrame();
    expect(focused).toEqual(["b"]);

    coordinator.requestFocus("a-async");
    coordinator.registerMountedView(
      "a-async",
      a,
      provider({
        focus: (_container, _ctx, request) => {
          delayedA.run = () => {
            if (!request.signal.aborted) focused.push("a-async");
          };
        },
      }),
      () => context,
    );
    flushFrame();
    coordinator.requestFocus("b");
    delayedA.run?.();
    flushFrame();

    expect(focused).toEqual(["b", "b"]);
  });
});

describe("delivery lands or reports", () => {
  it("미착지 배달은 다음 프레임 1회 재시도해 착지시킨다", () => {
    const { coordinator, flushFrame } = fixture();
    const container = document.createElement("div");
    const input = document.createElement("input");
    container.append(input);
    document.body.append(container);
    let calls = 0;
    coordinator.registerMountedView(
      "v1",
      container,
      provider({
        focus: () => {
          calls += 1;
          if (calls >= 2) input.focus(); // 1차는 준비 전(무연산) — 실측: ghostty 미착지 시그니처
        },
      }),
      () => context,
    );
    coordinator.requestFocus("v1");
    flushFrame(); // 1차 배달 — 미착지
    expect(document.activeElement).not.toBe(input);
    flushFrame(); // 재시도 — 착지해야 한다
    expect(document.activeElement).toBe(input);
    expect(coordinator.snapshot().delivered).toBe(true);
  });

  it("재시도 후에도 미착지면 어느 뷰인지 보고한다 — 침묵 금지", () => {
    const errors: unknown[] = [];
    const frames: FrameRequestCallback[] = [];
    const coordinator = new ViewFocusCoordinator({
      schedule: (cb) => {
        frames.push(cb);
        return frames.length;
      },
      onError: (error) => errors.push(error),
    });
    const flushFrame = () => {
      const pending = frames.splice(0);
      for (const cb of pending) cb(performance.now());
    };
    const container = document.createElement("div");
    document.body.append(container);
    coordinator.registerMountedView(
      "v9",
      container,
      provider({ focus: () => {} }), // 영원히 미착지
      () => context,
    );
    coordinator.requestFocus("v9");
    flushFrame();
    flushFrame();
    expect(errors.length).toBe(1);
    expect(String(errors[0])).toContain("v9");
  });
});
