// 창 설정 계약 — macOS 첫 클릭 삼킴 방지.
//
// acceptFirstMouse 가 없으면(기본 false) 비활성 창의 첫 mousedown 은 창 활성화로만
// 소비되고 위젯(터미널 xterm 등)에는 배달되지 않는다 — 실측 증상: "두 번 클릭해야
// 포커스가 간다", 첫 클릭 후 커서(포커스 표식)가 안 그려진다. 워크스페이스 창은
// windows[0] 설정을 clone 하므로(window.rs) 이 한 항목이 전 창의 단일 진실이다.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("tauri.conf.json 창 계약", () => {
  it("모든 창 설정은 acceptFirstMouse:true — 비활성 창 첫 클릭도 위젯에 배달", () => {
    const conf = JSON.parse(
      readFileSync(resolve(__dirname, "../../frameworks/tauri/tauri.conf.json"), "utf8"),
    ) as { app: { windows: { acceptFirstMouse?: boolean }[] } };
    expect(conf.app.windows.length).toBeGreaterThan(0);
    for (const w of conf.app.windows) {
      expect(w.acceptFirstMouse).toBe(true);
    }
  });
});
