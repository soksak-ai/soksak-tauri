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

  it("앱 번들은 홈의 cored가 없을 때 세울 정식 sidecar를 선언한다", () => {
    for (const name of [
      "tauri.dev-bundle.conf.json",
      "tauri.debug.conf.json",
      "tauri.release.conf.json",
    ]) {
      const conf = JSON.parse(
        readFileSync(resolve(__dirname, `../../frameworks/tauri/${name}`), "utf8"),
      ) as { bundle?: { externalBin?: string[] } };
      expect(conf.bundle?.externalBin, name).toEqual(["binaries/soksak-cored"]);
    }
  });

  it("공개 번들 명령은 앱과 sidecar에 같은 target triple을 명시한다", () => {
    const makefile = readFileSync(resolve(__dirname, "../../Makefile"), "utf8");
    expect(makefile).toMatch(/^TAURI_TARGET \?= .*rustc -vV/m);
    for (const target of ["build", "build-dev", "build-debug"]) {
      const body = makefile.match(new RegExp(`^${target}:[\\s\\S]*?(?=^[a-zA-Z_-]+:|\\Z)`, "m"))?.[0];
      expect(body, target).toContain("CARGO_BUILD_TARGET=$(TAURI_TARGET)");
      expect(body, target).toContain("--target $(TAURI_TARGET)");
    }
  });

  it("실행 명령의 앱 이름은 Tauri productName과 같다", () => {
    const makefile = readFileSync(resolve(__dirname, "../../Makefile"), "utf8");
    expect(makefile).toContain("soksak-tauri-dev.app");
    expect(makefile).toContain("RELEASE_APP := $(TAURI_TARGET_DIR)/release/bundle/macos/soksak-tauri.app");
    expect(makefile).toContain("DEBUG_APP   := $(TAURI_TARGET_DIR)/debug/bundle/macos/soksak-tauri-debug.app");
  });
});
