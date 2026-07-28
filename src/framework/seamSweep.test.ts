// 스윕이 실제로 무는가 — 게이트의 오라클.
//
// 이 파일이 없으면 게이트는 "0건"을 답할 뿐이고, 그 0 이 깨끗해서인지 못 찾아서인지 알 수 없다.
import { describe, expect, it } from "vitest";
import { leaksIn, stripComments, VENDOR_DECL } from "./seamSweep";

describe("선언적 벤더 누출 스윕", () => {
  it("종류를 빠짐없이 잡는다", () => {
    const cases: [string, string][] = [
      ["a.tsx", '<div data-tauri-drag-region>'],
      ["a.css", ".x { -webkit-app-region: drag; }"],
      ["a.ts", "window.__TAURI_INTERNALS__.transformCallback()"],
      ["a.ts", 'const u = "tauri://localhost/x"'],
      ["a.ts", 'const u = "asset://x"'],
      ["a.ts", "const u = convertFileSrc(p)"],
      ["a.ts", "window.electron.ipcRenderer"],
    ];
    for (const [f, src] of cases) {
      expect(leaksIn(f, src), src).toHaveLength(1);
    }
    // 선언한 종류 수와 실제로 잡히는 종류 수가 같다 — 표에만 있고 안 잡히는 항목이 없다.
    expect(cases).toHaveLength(VENDOR_DECL.length);
  });

  it("사유를 함께 준다 — 이름만 주면 왜 안 되는지 다시 조사한다", () => {
    const [hit] = leaksIn("a.tsx", "<div data-tauri-drag-region>");
    expect(hit).toContain("data-tauri-drag-region");
    expect(hit).toContain("Tauri 웹뷰가 가로채는 속성");
  });

  it("주석은 세지 않는다 — 설명을 지우게 만들면 안 된다", () => {
    expect(leaksIn("a.ts", "// asset:// 은 쓰지 않는다")).toEqual([]);
    expect(leaksIn("a.ts", "/* data-tauri-drag-region 을 쓰지 않는 이유 */")).toEqual([]);
    // 그러나 코드에 있으면 잡는다 — 주석 제거가 코드까지 먹으면 안 된다.
    expect(leaksIn("a.ts", 'x = "asset://y"; // 설명')).toHaveLength(1);
  });

  it("URL 스킴의 // 를 줄 주석으로 보지 않는다 — 그러면 그 누출을 영영 못 잡는다", () => {
    expect(stripComments('const u = "tauri://x"')).toContain("tauri://x");
    expect(leaksIn("a.ts", 'const u = "tauri://x"')).toHaveLength(1);
  });

  it("깨끗한 소스는 0건이다", () => {
    expect(leaksIn("a.tsx", '<div className="titlebar" {...dragRegion}>')).toEqual([]);
  });
});
