// 코어는 프레임워크가 **없다고 적어 둔 것**을 부르지 않고, 있다고 적어 둔 것의 거절을 삼키지 않는다.
//
// 예전 자리(theme.ts): 어느 프레임워크든 무조건 `titlebar_backing` 을 부르고 `.catch(() => {})`
// 로 통째로 삼켰다. Electron 은 그 개념이 없다고 사유까지 적어 두었는데 코어가 그 선언을 읽지
// 않았고, 거절도 남지 않아 "선언은 있는데 아무 일도 안 난다"가 어디에도 안 보였다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TitlebarCompositionProvision } from "../framework/contract";

const absent = (reason: string) => ({ provided: false as const, reason });
const provided = { provided: true as const };

const harness = vi.hoisted(() => ({
  provision: {
    buttonPositions: { provided: false as const, reason: "no public button rect" },
    backingPlane: { provided: false as const, reason: "no backing plane" },
    paintOwner: { provided: false as const, reason: "no paint owner ledger" },
  } as TitlebarCompositionProvision,
  invoked: [] as { cmd: string; args?: Record<string, unknown> }[],
  reject: null as string | null,
  themeModes: [] as string[],
}));

vi.mock("../framework", () => ({
  titlebarComposition: harness.provision,
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    harness.invoked.push({ cmd, args });
    if (cmd === "titlebar_backing" && harness.reject !== null) {
      return Promise.reject(new Error(harness.reject));
    }
    if (cmd === "themes_scan") return Promise.resolve([]);
    return Promise.resolve(undefined);
  },
  currentWindow: () => ({
    setTheme: (mode: string) => {
      harness.themeModes.push(mode);
      return Promise.resolve();
    },
  }),
}));

import { useTheme } from "./theme";
import {
  clearTitlebarProvisionBreaches,
  titlebarProvisionBreaches,
} from "../framework/titlebarProvision";

function setProvision(next: TitlebarCompositionProvision): void {
  Object.assign(harness.provision, next);
}

/** 선언을 다시 읽게 만드는 최소 자극 — 사용자 동작 하나(모드 토글). */
function retheme(): void {
  useTheme.getState().toggleMode();
}

beforeEach(() => {
  harness.invoked.length = 0;
  harness.themeModes.length = 0;
  harness.reject = null;
  clearTitlebarProvisionBreaches();
});

afterEach(() => {
  clearTitlebarProvisionBreaches();
});

describe("테마가 신호등 백킹 선언을 읽는다", () => {
  it("백킹 평면이 없다고 선언한 프레임워크에서는 부르지 않는다", () => {
    setProvision({
      buttonPositions: absent("no public button rect"),
      backingPlane: absent("no backing plane"),
      paintOwner: absent("no paint owner ledger"),
    });
    retheme();
    expect(harness.invoked.map((c) => c.cmd)).not.toContain("titlebar_backing");
    // 선언된 부재는 위반이 아니다 — 장부에 남지 않는다.
    expect(titlebarProvisionBreaches()).toEqual([]);
    // 창 크롬 밝기는 별개 축이라 계속 동기화한다.
    expect(harness.themeModes.length).toBeGreaterThan(0);
  });

  it("백킹 평면이 있다고 선언한 프레임워크에서는 색을 실어 부른다", () => {
    setProvision({
      buttonPositions: provided,
      backingPlane: provided,
      paintOwner: provided,
    });
    retheme();
    const call = harness.invoked.find((c) => c.cmd === "titlebar_backing");
    expect(call).toBeDefined();
    for (const key of ["r", "g", "b"]) {
      const channel = call!.args?.[key];
      expect(typeof channel).toBe("number");
      expect(channel as number).toBeGreaterThanOrEqual(0);
      expect(channel as number).toBeLessThanOrEqual(1);
    }
  });

  it("있다고 선언한 것이 거절되면 삼키지 않고 이름으로 남긴다", async () => {
    setProvision({
      buttonPositions: provided,
      backingPlane: provided,
      paintOwner: provided,
    });
    harness.reject = "Command titlebar_backing not found";
    retheme();
    await Promise.resolve();
    await Promise.resolve();
    expect(titlebarProvisionBreaches()).toEqual([
      {
        facet: "backingPlane",
        command: "titlebar_backing",
        error: "Command titlebar_backing not found",
      },
    ]);
  });
});
