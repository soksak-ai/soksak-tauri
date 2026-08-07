// 관측 장치가 관측 대상을 밀어냈는지 가를 수 있어야 한다.
//
// 활강 340ms 동안 8ms recorder 가 42회 tick 하고 tick 마다 대상 노드 전부에
// getBoundingClientRect 를 부른다(catalogDom.ts 의 appendMultiDomTraceSample). 강제 레이아웃이
// 그만큼 끼어들면 rAF 가 밀릴 수 있다 — 실측에서 표시 열이 3 epoch 비었을 때 그 구간에 8ms
// 표본은 정확히 8ms 간격으로 도착했다. 그 상관을 인과로 읽으려면 recorder 를 끄고 같은 거래를
// 다시 재는 대조가 필요하고, 그러려면 끌 수 있어야 한다.
//
// 기본값은 지금 그대로다 — 이 축은 대조를 가능하게 할 뿐 계약을 바꾸지 않는다.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = () => readFileSync(resolve(import.meta.dirname, "catalogDom.ts"), "utf8");

describe("표시 열 관측자 선택", () => {
  it("trace 시작이 어떤 producer 를 켤지 받는다", () => {
    const start = source().split('register("ui.trace.multi.start"')[1]?.slice(0, 1400) ?? "";
    expect(start).toContain("producers");
  });

  it("recorder 를 끄면 그 tick 이 설치되지 않는다 — 조건이 tick 안이 아니라 설치 자리에 선다", () => {
    const text = source();
    const install = text.split("session.intervalProducer = setInterval(")[0].slice(-400);
    expect(install).toContain("intervalEnabled");
  });

  it("무엇을 켜고 껐는지 영수증이 답한다 — 두 실행을 나중에 구분할 수 있어야 한다", () => {
    const close = source().split('register("ui.trace.multi.close"')[1]?.slice(0, 1400) ?? "";
    expect(close).toContain("producersEnabled");
  });
});
