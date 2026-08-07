// 표시 원장 계약 — **한 이름, 두 구현.**
//
// B04·B05 는 "그 표시 epoch 에 이 view 가 어디 있었는가"를 묻는다. 그 물음은 프레임워크의
// 것이 아니다. 그런데 이 저장소는 그 명령을 한 프레임워크의 이름 공간(webview.pane.*)에 두어
// 다른 프레임워크에서는 **한 칸도 측정되지 않았다** — 부재가 결함으로 보이지 않고 "그 게이트는
// 원래 없다"로 보인다.
//
// 그래서 규칙: 코어에 이름 하나가 서고, 채우는 물건만 어댑터마다 다르다. 어느 어댑터도 자기
// 이름을 명령에 싣지 않고, 아무도 안 걸면 그 명령은 **없다**(빈 원장을 답하지 않는다).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRESENTATION_CLOCK } from "../lib/presentationClock";
import { getSpec, unregister } from "../commands/registry";
import type { CommandContext } from "../commands/registry";
import {
  PRESENTATION_LEDGER_DEFAULT_EVENTS,
  __resetPresentationLedgerForTest,
  hasPresentationLedgerHost,
  parsePresentationMaxEvents,
  parsePresentationOwners,
  registerPresentationLedgerHost,
  type PresentationLedgerArmInput,
  type PresentationLedgerHost,
} from "./presentationLedger";

const COMMANDS = [
  "view.presentation.owners",
  "view.presentation.trace.arm",
  "view.presentation.trace.close",
] as const;

const SRC = resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

function stubHost(): PresentationLedgerHost {
  return {
    owners: vi.fn(async () => [{
      viewId: "tab-1",
      window: "w-1",
      logicalPaneId: "pan-1",
      rendererId: "renderer-1",
      hostId: "host-1",
      surfaceId: "surface-1",
    }]),
    arm: vi.fn(async (input: PresentationLedgerArmInput) => ({
      traceId: input.traceId,
      clock: PRESENTATION_CLOCK,
      ownerViewIds: input.owners.map((owner) => owner.viewId),
      armedAtUnixMs: 1_000,
      baselineFrameSequence: 0,
      sourceGeneration: 1,
    })),
    close: vi.fn(async ({ traceId }: { traceId: string }) => ({
      traceId,
      clock: PRESENTATION_CLOCK,
      closed: true,
      ownerViewIds: ["tab-1"],
      armedAtUnixMs: 1_000,
      baselineFrameSequence: 0,
      presentationEvents: [],
      violations: {
        replacements: 0, gaps: 0, disappearances: 0, unpresented: 0, droppedEvents: 0,
      },
      observation: { callbackIntervalsSkipped: 0, maxCallbackLatencyMs: 0 },
    })),
  };
}

describe("표시 원장 계약", () => {
  beforeEach(() => {
    for (const name of COMMANDS) unregister(name);
    __resetPresentationLedgerForTest();
  });

  it("아무도 안 걸면 명령이 없다 — 빈 원장을 답하지 않는다", () => {
    expect(hasPresentationLedgerHost()).toBe(false);
    for (const name of COMMANDS) expect(getSpec(name)).toBeUndefined();
  });

  it("어댑터가 걸면 그때 명령 표면이 선다", async () => {
    const host = stubHost();
    registerPresentationLedgerHost(host);
    for (const name of COMMANDS) expect(getSpec(name), name).toBeDefined();

    const call = (name: string, params: Record<string, unknown>) =>
      getSpec(name)!.handler(params, {} as CommandContext);
    const owners = await call("view.presentation.owners", {});
    expect(owners).toMatchObject({ count: 1 });

    const armed = await call("view.presentation.trace.arm", {
      traceId: "t-1",
      owners: [{ viewId: "tab-1", hostId: "host-1", surfaceId: "surface-1" }],
    });
    expect(armed).toMatchObject({ traceId: "t-1", ownerViewIds: ["tab-1"] });
    expect(host.arm).toHaveBeenCalledWith({
      traceId: "t-1",
      owners: [{ viewId: "tab-1", hostId: "host-1", surfaceId: "surface-1" }],
      maxEvents: PRESENTATION_LEDGER_DEFAULT_EVENTS,
    });

    const receipt = await call("view.presentation.trace.close", { traceId: "t-1" });
    expect(receipt).toMatchObject({ traceId: "t-1", closed: true });
  });

  it("잘못된 owner 선언은 한 자리에서 이름을 달고 거절한다", () => {
    expect(() => parsePresentationOwners([])).toThrow(/비었습니다/);
    expect(() => parsePresentationOwners([{ viewId: "tab-1", hostId: "h" }])).toThrow(/identity/);
    expect(() => parsePresentationOwners([
      { viewId: "tab-1", hostId: "h", surfaceId: "s" },
      { viewId: "tab-1", hostId: "h2", surfaceId: "s2" },
    ])).toThrow(/중복/);
    expect(parsePresentationOwners([{ viewId: " tab-1 ", hostId: " h ", surfaceId: " s " }]))
      .toEqual([{ viewId: "tab-1", hostId: "h", surfaceId: "s" }]);
  });

  it("용량은 유한 범위 밖이면 조용히 죄지 않고 거절한다", () => {
    expect(parsePresentationMaxEvents(undefined)).toBe(PRESENTATION_LEDGER_DEFAULT_EVENTS);
    expect(parsePresentationMaxEvents(512)).toBe(512);
    for (const bad of [1, 4097, 2.5, "many"]) {
      expect(() => parsePresentationMaxEvents(bad), String(bad)).toThrow(/maxEvents/);
    }
  });
});

describe("표시 원장 소유 — 코어 이름 하나, 채우는 물건은 어댑터", () => {
  it("명령 이름에 프레임워크가 들어가지 않는다", () => {
    const seam = read("framework/presentationLedger.ts");
    for (const name of COMMANDS) expect(seam).toContain(`register("${name}"`);
    const registered = [...seam.matchAll(/register\("([\w.]+)"/g)].map((match) => match[1]);
    expect(registered).toEqual([...COMMANDS]);
    for (const name of registered) expect(name).not.toMatch(/tauri|electron|webview|appkit|dom\b/i);
  });

  it("두 어댑터가 같은 계약을 채운다 — 한쪽만 걸면 그 프레임워크는 한 칸도 안 재진다", () => {
    for (const adapter of ["framework/tauri/install.ts", "framework/electron/install.ts"]) {
      expect(read(adapter), adapter).toMatch(/registerPresentationLedgerHost\(/);
    }
  });

  it("어댑터는 자기 이름을 단 표시 원장 명령을 따로 세우지 않는다", () => {
    for (const adapter of ["framework/tauri/install.ts", "framework/electron/install.ts"]) {
      expect(read(adapter), adapter).not.toMatch(/register\("[\w.]*presentation\.trace/);
    }
  });
});
