// @vitest-environment node
// 모듈을 손 목록으로 흉내내지 마라 — 계약이 자라면 그 목록에 없는 것이 undefined 가 된다.
//
// 검사가 프레임워크 창구를 모킹하면서 내보내는 이름을 손으로 적으면, 계약에 축이 하나 늘 때마다
// 그 목록에 없는 검사들이 **자기와 무관한 이유로** 죽는다. 실측 2026-08-08: `setWindowZoom`
// 하나를 계약에 세우자 그 이름을 쓰지도 않는 검사 셋이 차례로 죽었고, 셋 다 원인이 같았다
// (한 턴에 같은 자리를 세 번 고쳤다).
//
// 고칠 자리는 검사가 아니라 흉내내는 방식이다: 진짜 모듈을 펴고(`importOriginal`) 바꾸려는
// 이름만 덮는다. 그러면 계약이 자라도 검사는 그대로 돈다.
//
// 이 규칙은 프레임워크 창구에만 건다 — 그 모듈이 어댑터 선택으로 해소되는 계약면이고, 자라는
// 축이 거기 모인다. 다른 모듈까지 넓히는 것은 이 실측이 뒷받침하지 않는다.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const SELF = "mockSpreadsOriginal.test.ts";

function sources(dir = ROOT, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) sources(p, out);
    else if (/\.test\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** 프레임워크 창구를 흉내내면서 진짜 모듈을 펴지 않는 자리.
 *
 * 재는 것은 **펴는가**이지 콜백을 뭐라 이름 지었는가가 아니다 — 이름으로 재면 `importOriginal`
 * 을 `orig` 라 부른 멀쩡한 자리가 위반으로 잡힌다(실측: 첫 판이 그렇게 한 건을 오인했다).
 */
export function handListedFrameworkMock(source: string): boolean {
  const at = source.search(/vi\.mock\(\s*["'][^"']*\/framework["']\s*,/);
  if (at < 0) return false;
  // 팩토리 머리에서 "기다려 받은 것을 편다" 를 찾는다. 한 줄에 쓰든 변수에 받아 펴든 같은 사실이다.
  const head = source.slice(at, at + 400);
  return !/\.\.\.\s*\(?\s*await\b/.test(head) && !/await\s+\w+\(\)[\s\S]{0,200}\.\.\./.test(head);
}

describe("프레임워크 창구 모킹은 진짜 모듈을 편다", () => {
  it("손 목록으로 흉내내는 검사가 없다", () => {
    const offenders = sources()
      .filter((f) => !f.endsWith(SELF))
      .filter((f) => handListedFrameworkMock(readFileSync(f, "utf8")))
      .map((f) => f.slice(ROOT.length + 1));
    expect(offenders, "계약에 축이 늘면 이 자리들이 무관한 이유로 죽는다").toEqual([]);
  });

  // 게이트는 위반을 심어 자격을 확인한다.
  it("손 목록을 심으면 잡는다", () => {
    const planted = ["vi.mock(", '"../framework"', ", () => ({ invoke }));"].join("");
    expect(handListedFrameworkMock(planted)).toBe(true);
  });

  it("펴는 모양은 잡지 않는다", () => {
    const spread = [
      "vi.mock(",
      '"../framework"',
      ", async (importOriginal) => ({ ...(await importOriginal()), invoke }));",
    ].join("");
    expect(handListedFrameworkMock(spread)).toBe(false);
    // 콜백 이름은 규칙이 아니다 — 받아서 펴는 모양도 통과해야 한다.
    const named = [
      "vi.mock(",
      '"../framework"',
      ", async (orig) => { const real = await orig(); return { ...real, invoke }; });",
    ].join("");
    expect(handListedFrameworkMock(named)).toBe(false);
  });

  it("다른 모듈의 모킹은 보지 않는다", () => {
    const other = ["vi.mock(", '"../i18n"', ', () => ({ tmsg: () => "" }));'].join("");
    expect(handListedFrameworkMock(other)).toBe(false);
  });
});
