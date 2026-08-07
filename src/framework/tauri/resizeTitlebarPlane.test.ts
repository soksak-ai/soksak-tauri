// resize 관측 표본은 titlebar 평면도 든다.
//
// RED 근거(실측 2026-08-07, `make e2e-titlebar-dev` 3 사이클 전부): B12 가
// `hostileResize.transactions[N].titlebar=record/null` 을 14건 냈다. B12 는 hostile resize 를
// `window.resizeSequence` 로 돌리고 그 관측에서 titlebar 를 읽는데, 관측면이 그 평면을 싣지
// 않아 값이 없었다.
//
// 관측면 하나를 B10 과 B12 가 공유한다. combineTauriCompositionProbe 는 키가 있을 때만 그 축을
// 세도록 이미 설계돼 있으므로(titlebarExpected), 평면을 실어도 B10 이 재는 축은 늘지 않는다 —
// 다만 titlebar 가 red 면 그 사실이 이름으로 남는다. 그것이 이 축을 실어야 하는 이유다.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(resolve(import.meta.dirname, name), "utf8");

describe("resize 관측 표본의 titlebar 평면", () => {
  it("표본을 만드는 자리가 titlebar 를 읽어 싣는다", () => {
    const probe = read("resizeProbe.ts");
    expect(probe).toContain("readTitlebar");
    // 세 평면이 같은 표본에서 함께 읽힌다 — 따로 읽으면 다른 순간의 사실이 한 판정에 섞인다.
    const sample = probe.split("const [direct, pane")[1]?.slice(0, 400) ?? "";
    expect(sample).toContain("readTitlebar");
    // 선언에 실리지 않으면 판정은 그 축을 세지 않는다.
    const declared = probe.split("combineTauriCompositionProbe<")[1]?.slice(0, 600) ?? "";
    expect(declared).toContain("titlebar,");
  });

  it("어댑터가 공개 읽기 전용 관측면을 그 자리에 배선한다", () => {
    const install = read("install.ts");
    const wiring = install.split("readPaneContract:")[0].split("readDirect:")[1] ?? "";
    expect(install).toContain("readTitlebar:");
    // 읽기는 표면을 바꾸지 않는다 — 변이 명령(compose)을 관측 경로에 두면 관측이 자기가 만든
    // 상태를 재게 된다.
    const titlebarWiring = install.split("readTitlebar:")[1]?.slice(0, 300) ?? "";
    expect(titlebarWiring).toContain("inspectTitlebarComposition()");
    expect(titlebarWiring).not.toContain("composeTitlebarComposition()");
    expect(wiring.length).toBeGreaterThan(0);
  });
});
