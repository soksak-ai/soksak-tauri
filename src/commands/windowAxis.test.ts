// 창 축 표준 — 봉투가 지목한 대상을 파라미터로 다시 요구하지 않는다.
//
// RED 근거(실측, 2026-07-26): window.close 만 label 을 사실상 필수로 다뤘다. 봉투가 이미 그
// 창을 지목했는데도 인자 누락으로 죽었고(`missing required key label` → INTERNAL), e2e 게이트가
// 자기 창을 못 닫아 실행할 때마다 브라우저 뷰가 3개씩 쌓였다(6회 = 18개).
//
// 정의를 명령마다 따로 적으면 뜻과 기본값이 갈라진다. 창 축의 정의는 P.windowLabel 하나이고,
// 이 게이트가 그 동일성을 지킨다. 레지스트리는 앱 없이 세울 수 없으므로 소스를 읽는다
// (commandMessages.test 와 같은 방식).
//
// 웹뷰 축(webview.recover 의 label = b-<win>-<view>)은 다른 식별자 공간이다 — 창 하나에 여러
// 웹뷰가 있어 생략의 뜻이 하나로 정해지지 않으므로 이 규칙 밖이고, 필수가 옳다.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 카탈로그는 여러 파일로 갈린다(창·캡처·건강·DOM…). 어느 파일에 있는지를 손으로 적으면 코드가
// 옮겨간 날 게이트가 조용히 빈 집합을 세고 통과한다 — 파일 목록은 트리에서 발견한다.
const SRC = readdirSync(__dirname)
  .filter((f) => /^catalog.*\.ts$/.test(f) && !f.endsWith(".test.ts"))
  .map((f) => readFileSync(join(__dirname, f), "utf8"))
  .join("\n");

/** register("<name>", { ... }) 블록들 — 다음 register 앞까지. */
function blocks(): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const marks = [...SRC.matchAll(/ {2}register\("([^"]+)", \{/g)];
  marks.forEach((m, i) => {
    const start = m.index ?? 0;
    const end = i + 1 < marks.length ? (marks[i + 1].index ?? SRC.length) : SRC.length;
    out.push({ name: m[1], body: SRC.slice(start, end) });
  });
  return out;
}

/** 선언된 파라미터 구간만 — 반환 서술이나 핸들러 본문의 label 을 파라미터로 오인하지 않는다. */
function paramsOf(body: string): string {
  const i = body.indexOf("params:");
  if (i < 0) return "";
  const j = body.indexOf("returns:", i);
  return body.slice(i, j < 0 ? body.length : j);
}

/** 창을 대상으로 삼으면서 label 파라미터를 선언한 명령들. */
function windowAxis(): { name: string; body: string }[] {
  return blocks().filter(
    (b) => b.name.startsWith("window.") && /\blabel:/.test(paramsOf(b.body)),
  );
}

describe("창 축은 한 곳에 정의된다", () => {
  it("창을 대상으로 삼는 명령이 실제로 있다 — 빈 집합이 통과로 위장하지 않는다", () => {
    expect(windowAxis().map((b) => b.name).sort()).toEqual([
      "window.close",
      "window.focus",
      "window.maximize",
      "window.place",
    ]);
  });

  it("전부 P.windowLabel 을 쓴다 — 뜻과 기본값이 명령마다 갈라지지 않는다", () => {
    const offenders = windowAxis()
      .filter((b) => !/label: P\.windowLabel/.test(paramsOf(b.body)))
      .map((b) => b.name);
    expect(offenders).toEqual([]);
  });

  it("창 라벨은 필수가 아니다 — 봉투가 이미 대상을 지목했다", () => {
    expect(/windowLabel: \{[^}]*required: true/.test(SRC)).toBe(false);
  });

  it("전부 같은 해소를 쓴다 — 모양이 갈라지면 어디선가 생략 처리가 빠진다", () => {
    const offenders = windowAxis()
      .filter((b) => !/windowTarget\(p\)/.test(b.body))
      .map((b) => b.name);
    expect(offenders).toEqual([]);
  });

  it("p.label 을 그대로 backend 로 흘리지 않는다 — 생략이 인자 누락으로 죽던 경로", () => {
    const offenders = windowAxis()
      .filter((b) => /label: p\.label\b/.test(b.body))
      .map((b) => b.name);
    expect(offenders).toEqual([]);
  });

  it("없는 창은 TARGET_NOT_FOUND 로 답한다 — 내부 인자 오류를 흘리지 않는다", () => {
    const offenders = windowAxis()
      .filter((b) => !/"TARGET_NOT_FOUND"/.test(b.body))
      .map((b) => b.name);
    expect(offenders).toEqual([]);
  });
});

describe("자기를 파괴하는 명령은 답을 먼저 흘린다", () => {
  // RED 근거(실측, 2026-07-26): 자기 창에 대고 부른 window.close 는 창을 닫고도
  // WINDOW_DESTROYED 를 돌려줬다 — 답할 통로가 그 파괴로 함께 죽기 때문이다. 호출자는
  // 성공을 실패로 읽고, e2e 는 회수가 됐는지 알 수 없었다. window.reload 가 같은 이유로
  // 이미 같은 모양을 쓴다: 답을 먼저 흘리고 다음 틱에 실행한다.
  const self = blocks().find((b) => b.name === "window.close")?.body ?? "";

  it("자기 창이면 setTimeout 뒤에 파괴한다", () => {
    expect(/currentWindowLabel\(\)\) \{[\s\S]*setTimeout\(/.test(self)).toBe(true);
  });

  it("남의 창은 즉시 파괴한다 — 그 통로는 살아 있다", () => {
    expect(/await invoke\("window_close", \{ label \}\);/.test(self)).toBe(true);
  });
});
