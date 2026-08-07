// @vitest-environment node
//
// 센티널 뷰 준비 판정 — RED 근거(실측 baseline, runId=slot-freeze-*, buildId=72f0b918,
// framework=tauri): browser-chromium-offscreen 12칸 전부 blocked. 하니스가 보고한 사유는
// `sentinel navigate 실패: {"code":"NO_VIEW",...}` 였다. navigate 는 소유자가 아니다 —
// tab.open 이 이미 `mounted:false` 로 답했는데 센티널 블록만 그 답을 읽지 않고 다음 명령을
// 보냈다(픽스처 블록은 `left.mounted !== true` 로 같은 계약을 강제한다). 읽지 않은 계약은
// 없는 계약이고, 그래서 12칸이 엉뚱한 소유자 이름으로 막혔다.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const HARNESS = resolve(import.meta.dirname, "../slot-freeze.mjs");

describe("센티널 마운트 계약 — tab.open 이 답한 사실을 읽는다", () => {
  it("하니스 센티널 블록이 tab.open 의 mounted 를 판정에 쓴다", () => {
    const source = readFileSync(HARNESS, "utf8");
    const block = source.split("sentinel tab.open")[1]?.split("sentinel ready")[0] ?? "";
    expect(block).toContain("assertSentinelMounted");
    expect(source).toContain("./lib/browser-sentinel.mjs");
  });

  it("mounted:true 면 통과하고 판정에 tabId 를 싣는다", async () => {
    const { judgeSentinelMount } = await import("./browser-sentinel.mjs");
    const verdict = judgeSentinelMount({
      engine: "browser-chromium-offscreen",
      receipt: { paneId: "pan-1", tabId: "tab-1", mounted: true },
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.tabId).toBe("tab-1");
    expect(verdict.mounted).toBe(true);
    expect(verdict.failures).toEqual([]);
  });

  it("mounted:false 는 마운트 소유자를 이름으로 지목한다 — navigate 를 탓하지 않는다", async () => {
    const { judgeSentinelMount } = await import("./browser-sentinel.mjs");
    const verdict = judgeSentinelMount({
      engine: "browser-chromium-offscreen",
      receipt: { paneId: "pan-1", tabId: "tab-1", mounted: false },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toEqual(["mounted=true/false"]);
    expect(verdict.reason).toContain("browser-chromium-offscreen");
    expect(verdict.reason).toContain("tab.open.mounted");
    expect(verdict.reason).not.toContain("navigate");
  });

  it("mounted 필드 자체가 없으면 미확인이지 성공이 아니다", async () => {
    const { judgeSentinelMount } = await import("./browser-sentinel.mjs");
    const verdict = judgeSentinelMount({
      engine: "browser-chromium",
      receipt: { paneId: "pan-1", tabId: "tab-1" },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toEqual(["mounted=true/undefined"]);
  });

  it("tabId 가 문자열이 아니면 그것도 실패로 센다", async () => {
    const { judgeSentinelMount } = await import("./browser-sentinel.mjs");
    const verdict = judgeSentinelMount({
      engine: "browser",
      receipt: { paneId: "pan-1", tabId: null, mounted: true },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toEqual(["tabId=string/null"]);
  });

  it("그 탭이 보고한 status 가 있으면 사유에 실어 소유자를 좁힌다", async () => {
    const { judgeSentinelMount } = await import("./browser-sentinel.mjs");
    const verdict = judgeSentinelMount({
      engine: "browser-chromium-offscreen",
      receipt: { paneId: "pan-1", tabId: "tab-1", mounted: false },
      statuses: [
        { tabId: "tab-9", code: "running" },
        { tabId: "tab-1", code: "error", message: "플러그인 활성 실패(x): boom" },
      ],
    });
    expect(verdict.status).toEqual({
      tabId: "tab-1",
      code: "error",
      message: "플러그인 활성 실패(x): boom",
    });
    expect(verdict.reason).toContain("boom");
  });

  it("assertSentinelMounted 는 통과하면 판정을 돌려주고 실패하면 그 사유로 던진다", async () => {
    const { assertSentinelMounted } = await import("./browser-sentinel.mjs");
    expect(
      assertSentinelMounted({
        engine: "browser",
        receipt: { tabId: "tab-1", mounted: true },
      }).ok,
    ).toBe(true);
    expect(() =>
      assertSentinelMounted({
        engine: "browser-chromium-offscreen",
        receipt: { tabId: "tab-1", mounted: false },
      }),
    ).toThrow(/tab\.open\.mounted/);
  });
});
