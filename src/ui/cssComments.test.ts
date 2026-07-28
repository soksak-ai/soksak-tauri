// CSS 주석 짝 — 하나가 어긋나면 **그 뒤의 선언이 조용히 사라진다.**
//
// RED 근거(실측 2026-07-28, 살아있는 창): `.sidebar.rail-ground` 의 좌우 경계가 화면에
// 닿지 않았다 — border-left-style 이 none, color 가 초기값(rgb(0,0,0))이었다. 같은 셀렉터의
// 형제 블록(background/box-shadow)은 멀쩡히 먹었고 `--bd` 도 그 자리에서 해소됐다.
// 원인은 캐스케이드가 아니라 주석이었다: 한 주석이 본문에 `*/` 를 품어(`rail-ground-*/rail-pane-*`)
// 거기서 닫혔고, 남은 꼬리가 최상위 쓰레기가 되어 CSS 오류 복구가 **바로 다음 블록 전체**를
// 버렸다. 또 한 자리는 규칙만 지우고 주석 머리 두 줄을 남겨 주석이 열린 채였다.
//
// 이 결함은 어디서도 오류로 보고되지 않는다 — 파일은 여전히 유효한 CSS 이고 빌드도 통과한다.
// 사라진 것은 선언뿐이라 "왜 이 선이 안 보이지"로만 나타난다. 그래서 사람 눈이 아니라 기계가
// 짝을 잇는다. 파서는 브라우저와 같은 규칙을 쓴다: `/*` 다음 **첫** `*/` 가 닫는다. 중첩은 없다.
//
// 기준을 낮추지 마라 — 걸리면 주석을 고친다(본문의 `*/` 는 띄어 쓰고, 남은 머리는 지운다).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(process.cwd(), "src");

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...cssFiles(p));
    else if (name.endsWith(".css")) out.push(p);
  }
  return out.sort();
}

type Finding = { where: string; what: string; text: string };

/** 브라우저와 같은 규칙으로 주석 짝을 잇는다 — `/*` 다음 첫 `*​/` 가 닫는다. */
function scan(path: string): Finding[] {
  const src = readFileSync(path, "utf8");
  const lines = src.split("\n");
  const rel = relative(process.cwd(), path);
  const at = (pos: number) => src.slice(0, pos).split("\n").length;
  const found: Finding[] = [];
  const note = (pos: number, what: string) =>
    found.push({ where: `${rel}:${at(pos)}`, what, text: lines[at(pos) - 1].trim().slice(0, 90) });

  let i = 0;
  let inComment = false;
  let openedAt = 0;
  while (i < src.length - 1) {
    const two = src.slice(i, i + 2);
    if (!inComment && two === "/*") {
      inComment = true;
      openedAt = i;
      i += 2;
      continue;
    }
    if (inComment && two === "*/") {
      inComment = false;
      i += 2;
      continue;
    }
    // 주석 본문의 `/*` — 다음 `*​/` 가 바깥 주석을 닫아 이후 짝이 통째로 밀린다.
    if (inComment && two === "/*") {
      note(i, "주석 본문에 `/*`");
      i += 2;
      continue;
    }
    // 주석 밖의 `*​/` — 여기서 오류 복구가 시작되어 다음 블록이 통째로 버려진다.
    if (!inComment && two === "*/") {
      note(i, "주석 밖의 `*/`");
      i += 2;
      continue;
    }
    i += 1;
  }
  if (inComment) note(openedAt, "닫히지 않은 주석");
  return found;
}

describe("CSS 주석 짝", () => {
  const files = cssFiles(ROOT);

  // 오라클 생존 — 대상이 비면 이 검사는 아무것도 안 지키면서 통과한다.
  it("검사할 CSS 가 있다", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [relative(process.cwd(), f), f] as const))(
    "%s 의 주석은 쓴 자리에서 닫힌다",
    (_rel, path) => {
      const found = scan(path);
      const report = found.map((f) => `  ${f.where}  ${f.what}\n    ${f.text}`).join("\n");
      expect(found, `주석 짝이 어긋났다 — 뒤의 선언이 조용히 사라진다:\n${report}`).toEqual([]);
    },
  );
});
