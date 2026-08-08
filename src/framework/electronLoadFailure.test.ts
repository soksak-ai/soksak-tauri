// @vitest-environment node
// 백지는 답이 아니다 — 못 뜬 창은 왜 못 떴는지 자기 화면에 적는다.
//
// 실측 2026-08-08: 개발 서버 없이 켜진 Electron 창이 `ERR_CONNECTION_REFUSED` 로 죽었다.
// `did-fail-load` 는 잡혀 있었고 로그 파일에는 그 줄이 있었지만, 사람에게는 흰 화면이었다.
// 무엇이 왜 안 떴는지 알려면 로그를 찾아 읽어야 했고, 그동안 그 창은 "그냥 안 되는 앱" 이었다.
//
// 실패한 창에는 앱이 없으므로 앱의 UI 로는 못 알린다. 그 자리에 최소 문서를 직접 그리고,
// 같은 사실을 원장에도 낸다(둘 중 하나만 있으면 사람과 기계 중 한쪽이 못 읽는다).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(__dirname, "../../frameworks/electron/main.cjs"),
  "utf8",
);

/** 이름이 붙은 함수 본문 — 다음 최상위 선언 직전까지. */
function body(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`main.cjs 에 ${name} 이 없다`);
  const rest = source.slice(start);
  const end = rest.indexOf("\n}\n");
  return end < 0 ? rest : rest.slice(0, end + 2);
}

describe("적재 실패는 화면과 원장 양쪽에 뜬다", () => {
  it("did-fail-load 가 실패 화면을 부른다", () => {
    const handler = source.slice(source.indexOf('on("did-fail-load"'));
    expect(handler.slice(0, 700)).toContain("showLoadFailure(");
  });

  it("사람이 읽을 사실을 화면에 싣는다 — 주소와 사유", () => {
    const fn = body("showLoadFailure");
    expect(fn, "무엇이 안 떴는지 주소가 없다").toContain("${escape(url)}");
    expect(fn, "왜 안 떴는지 사유가 없다").toContain("${escape(desc)}");
    expect(fn, "그릴 자리가 data 문서여야 한다 — 실패한 창에는 앱이 없다").toMatch(
      /loadURL\(`data:text\/html/,
    );
  });

  it("기계가 읽을 사실을 원장에 낸다", () => {
    const fn = body("showLoadFailure");
    expect(fn).toContain("activity_publish");
    expect(fn).toContain('kind: "boot.error"');
  });

  // 이 사건은 하위 프레임과 중단된 적재에도 뜬다. 그것까지 덮으면 도는 앱을 지운다.
  it("이 창의 실패만 덮는다 — 하위 프레임과 중단은 지나간다", () => {
    const handler = source.slice(source.indexOf('on("did-fail-load"'), source.indexOf('on("unresponsive"'));
    expect(handler, "하위 프레임 실패까지 덮는다").toMatch(/isMainFrame\s*!==\s*true/);
    expect(handler, "중단(ERR_ABORTED, -3)까지 덮는다").toMatch(/code\s*===\s*-3/);
  });

  it("실패 화면이 실패해도 자기를 다시 부르지 않는다", () => {
    const fn = body("showLoadFailure");
    expect(fn).toContain("paintingFailure");
  });
});
