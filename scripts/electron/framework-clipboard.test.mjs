// @vitest-environment node
// OS 클립보드의 기준 — 없는 사건을 흉내 내지 않는다.
//
// 읽기·쓰기는 이 프레임워크가 그대로 답한다. 감시는 답하지 않는다: 이 프레임워크에는 클립보드
// 변경 사건이 없고, 폴링으로 흉내 내면 그것은 감시가 아니라 주기 질의다. 조용히 성공시키면
// UI 는 감시가 선 줄 알고 오지 않을 변화를 기다린다.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const requireCjs = createRequire(import.meta.url);
const NATIVE = join(dirname(fileURLToPath(import.meta.url)), "../../frameworks/electron/native");

let board;

function stubElectron() {
  const path = requireCjs.resolve("electron");
  requireCjs.cache[path] = {
    id: path,
    filename: path,
    loaded: true,
    exports: {
      clipboard: {
        readText: () => board,
        writeText: (t) => {
          board = t;
        },
      },
    },
  };
}

function loadTable() {
  delete requireCjs.cache[requireCjs.resolve(join(NATIVE, "clipboard.cjs"))];
  return requireCjs(join(NATIVE, "clipboard.cjs"));
}

beforeEach(() => {
  board = "";
  stubElectron();
});

afterEach(() => {
  delete requireCjs.cache[requireCjs.resolve("electron")];
});

describe("OS 클립보드", () => {
  it("쓴 것을 그대로 읽는다", () => {
    const t = loadTable();
    expect(t.clipboard_write.answer({}, { text: "속삭" })).toBe(null);
    expect(t.clipboard_read.answer({}, {})).toBe("속삭");
  });

  /** 비텍스트 클립은 빈 문자열이다 — 부른 쪽은 텍스트만 다룬다(두 프레임워크가 같은 답). */
  it("빈 클립보드는 빈 문자열이다", () => {
    const t = loadTable();
    expect(t.clipboard_read.answer({}, {})).toBe("");
  });

  /** 감시는 **선언된 부재**다. answer 가 달리는 순간 UI 가 감시를 믿는다. */
  it("감시는 답이 아니라 부재로 선언된다", () => {
    const t = loadTable();
    for (const name of ["clipboard_watch_start", "clipboard_watch_stop"]) {
      expect(t[name].answer, `${name} 에 answer 가 달렸다`).toBeUndefined();
      expect(typeof t[name].absent).toBe("string");
      expect(t[name].absent.length).toBeGreaterThan(10);
    }
  });
});
