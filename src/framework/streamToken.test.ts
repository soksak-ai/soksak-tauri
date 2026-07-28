// 스트림 토큰은 **경계를 건넌다** — 그래서 직렬화 가능해야 한다.
//
// 실측(2026-07-29): 토큰에 `onmessage` 접근자를 열거 가능하게 얹었더니 invoke 가 경계에서
// "An object could not be cloned" 로 죽었다. 구조화 복제는 열거 가능한 자기 속성을 **읽어서**
// 복사하는데, 그 getter 가 함수를 돌려주고 함수는 복제되지 않는다.
//
// 증상은 오류 메시지가 아니라 "터미널이 안 뜬다"였다 — 명령이 서버에 닿은 적이 없어 원장에도
// 요구가 남지 않았다. 그래서 이 검사는 복제 자체를 실행한다: 모양만 보면 다시 놓친다.

import { describe, expect, it } from "vitest";

/** 어댑터가 만드는 토큰과 같은 모양 — 열거되지 않는 접근자 + 열거되는 토큰 문자열. */
function makeToken(id: string) {
  let sink: (m: unknown) => void = () => {};
  const token: Record<string, unknown> = { __frameworkStream: id };
  Object.defineProperty(token, "onmessage", {
    enumerable: false,
    configurable: true,
    get: () => sink,
    set: (fn: (m: unknown) => void) => {
      sink = fn;
    },
  });
  return token;
}

describe("스트림 토큰 — 경계를 건너는 값", () => {
  it("구조화 복제를 통과한다 — 통과 못 하면 명령이 서버에 닿지 못한다", () => {
    const t = makeToken("s1");
    (t as { onmessage: unknown }).onmessage = () => {};
    const cloned = structuredClone({ cols: 80, onOutput: t }) as {
      onOutput: Record<string, unknown>;
    };
    expect(cloned.onOutput.__frameworkStream).toBe("s1");
    expect("onmessage" in cloned.onOutput).toBe(false);
  });

  it("열거 가능한 접근자를 얹으면 복제가 죽는다 — 그것이 이 규칙의 근거다", () => {
    let sink: unknown = () => {};
    const bad: Record<string, unknown> = { __frameworkStream: "s2" };
    Object.defineProperty(bad, "onmessage", {
      enumerable: true,
      get: () => sink,
      set: (fn: unknown) => {
        sink = fn;
      },
    });
    expect(() => structuredClone({ onOutput: bad })).toThrow();
  });

  it("onmessage 는 여전히 읽고 쓸 수 있다 — 숨기는 것이 없애는 것은 아니다", () => {
    const t = makeToken("s3") as { onmessage: (m: unknown) => void };
    const seen: unknown[] = [];
    t.onmessage = (m) => seen.push(m);
    t.onmessage("hi");
    expect(seen).toEqual(["hi"]);
  });
});
