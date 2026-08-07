// @vitest-environment node
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { B11_WHEEL_LEDGER_KEYS } from "./browser-gate-b11.mjs";
import {
  scrollMovedSelector,
  wheelLedgerProbeJs,
  wheelLedgerStage,
  wheelReachedSelector,
} from "./browser-gate-b11-scroll.mjs";
import { fixtureHtml } from "./browser-matrix.mjs";

/**
 * 픽스처 문서를 인라인 스크립트까지 실제로 실행한 채로 세운다. 문자열 대조가 아니라 사건을 쏘고
 * 원장이 움직이는지 본다 — 세는 자리와 기다리는 자리가 같은 사실을 가리키는지는 실행만 답한다.
 * 매 테스트가 자기 문서를 갖는다: 창을 물려받으면 앞 테스트가 건 리스너가 다음 계수에 섞인다.
 */
let dom = null;

const html = () => dom.window.document.documentElement;
const readProbe = () => dom.window.eval(`(function(){ ${wheelLedgerProbeJs()} })()`);
const wheel = (deltaY) => dom.window.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY }));

beforeEach(() => {
  dom = new JSDOM(fixtureHtml(), {
    runScripts: "dangerously",
    url: "http://127.0.0.1:0/?slot=0",
  });
});

afterEach(() => {
  dom?.window.close();
  dom = null;
});

describe("B11 휠 원장 프로브", () => {
  it("판정이 요구하는 축을 전부 답한다", () => {
    const stage = wheelLedgerStage(readProbe());
    expect(Object.keys(stage).sort()).toEqual([...B11_WHEEL_LEDGER_KEYS].sort());
    for (const key of B11_WHEEL_LEDGER_KEYS) {
      expect(Number.isFinite(stage[key])).toBe(true);
    }
  });

  it("휠 사건 수와 누적 델타를 페이지에서 읽는다", () => {
    wheel(480);
    wheel(-480);
    const stage = wheelLedgerStage(readProbe());
    expect(stage.wheelEvents).toBe(2);
    expect(stage.wheelDeltaY).toBe(0);
  });
});

describe("휠 도달 대기", () => {
  it("휠 전에는 좌표가 0 이고 대기 선택자가 안 맞는다", () => {
    const before = readProbe();
    expect(before.wheelSeq).toBe(0);
    expect(html().matches(wheelReachedSelector(before.wheelSeq))).toBe(false);
  });

  it("휠이 페이지에 닿으면 대기 선택자가 맞는다", () => {
    const before = readProbe();
    wheel(480);
    expect(html().matches(wheelReachedSelector(before.wheelSeq))).toBe(true);
    const after = readProbe();
    expect(after.wheelSeq).toBe(1);
    expect(html().matches(wheelReachedSelector(after.wheelSeq))).toBe(false);
  });

  it("스크롤만 나고 휠이 안 오면 휠 대기는 계속 안 맞는다", () => {
    const before = readProbe();
    dom.window.dispatchEvent(new dom.window.Event("scroll"));
    expect(html().matches(scrollMovedSelector(before.seq))).toBe(true);
    expect(html().matches(wheelReachedSelector(before.wheelSeq))).toBe(false);
  });

  it("대기 좌표가 수치가 아니면 이름으로 거절한다", () => {
    expect(() => wheelReachedSelector(undefined)).toThrow(/wheelSeq/);
    expect(() => scrollMovedSelector(Number.NaN)).toThrow(/scrollSeq/);
  });
});
