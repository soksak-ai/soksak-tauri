// @vitest-environment node
// 백그라운드 시각 검증은 창을 캡처할 수 있어야 하지만 사용자의 포커스를 가져가면 안 된다.
// 시작 방식은 호스트가 소유하고, 캡처 명령은 그 비활성 창도 그대로 읽는다.
import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { revealWindow } = require_("../../frameworks/electron/presentation.cjs");

describe("Electron 창 표시 방식", () => {
  it("백그라운드 검증 선언은 포커스 없이 표시한다", () => {
    const win = { show: vi.fn(), showInactive: vi.fn() };
    revealWindow(win, { SOKSAK_START_INACTIVE: "1" });
    expect(win.showInactive).toHaveBeenCalledOnce();
    expect(win.show).not.toHaveBeenCalled();
  });

  it("일반 실행은 기존 표시 계약을 유지한다", () => {
    const win = { show: vi.fn(), showInactive: vi.fn() };
    revealWindow(win, {});
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.showInactive).not.toHaveBeenCalled();
  });
});
