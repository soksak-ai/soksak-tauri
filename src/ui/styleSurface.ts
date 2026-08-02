// 이 앱이 문서에 세우는 **스타일 표면 전체** — 게이트가 읽는 단일 목록.
//
// 스타일은 한 파일이 아니다: 코어의 것(App.css)과 각 프레임워크가 자기 것으로 들고 오는 것
// (framework/<name>/styles.css)이 함께 문서에 선다. 게이트가 한 파일만 읽으면 규칙이 다른
// 파일로 옮겨간 순간 검사에서 사라지고, **아무것도 실패하지 않은 채** 헌법이 비게 된다.
//
// 그래서 목록은 여기 하나뿐이다. 새 프레임워크가 자기 스타일시트를 들고 오면 여기 한 줄이고,
// 그 순간 모든 게이트가 그것을 함께 본다.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = dirname(dirname(fileURLToPath(import.meta.url)));

/** 표면을 이루는 스타일시트 경로 — 코어 하나 + 프레임워크마다 하나. */
export function styleSheetPaths(): string[] {
  const out = [join(SRC, "App.css")];
  const fw = join(SRC, "framework");
  for (const name of readdirSync(fw)) {
    const p = join(fw, name);
    if (!statSync(p).isDirectory()) continue;
    const css = join(p, "styles.css");
    try {
      if (statSync(css).isFile()) out.push(css);
    } catch {
      /* 스타일 없는 프레임워크 — 없는 것이 사실이다 */
    }
  }
  return out;
}

/** 표면 전체의 CSS 원문(경계는 개행 하나 — 규칙이 붙어 파싱이 섞이지 않게). */
export function styleSurface(): string {
  return styleSheetPaths()
    .map((p) => readFileSync(p, "utf8"))
    .join("\n");
}

/** 선언만 — 주석은 벗긴다. 주석까지 세면 사고를 적어 둔 근거 문장이 위반으로 잡히고,
 *  규칙이 자기 근거를 지우게 만든다. */
export function styleSurfaceRules(): string {
  return styleSurface().replace(/\/\*[\s\S]*?\*\//g, "");
}
