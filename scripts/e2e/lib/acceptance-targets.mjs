// 인수가 세는 프레임워크마다 그것을 재는 자리가 있어야 한다.
//
// 인수 합계는 BROWSER_ACCEPTANCE_FRAMEWORKS 를 전부 센다. 그것을 재는 Makefile 타깃이 한
// 프레임워크에만 있으면, 나머지 칸은 하니스가 못 재서가 아니라 부를 자리가 없어서 영원히
// missing 이다 — 세는 축과 재는 자리가 갈리면 인수는 달성 불가능한 채로 조용히 red 를 낸다.

const TARGET_PREFIX = "e2e-browser-acceptance-";

/**
 * Makefile 이 선언한 **프레임워크별** 인수 실행 타깃의 이름.
 *
 * 목록을 손으로 적지 않는다 — 소스에서 읽어 인수 축과 대조한다. 프레임워크 타깃임은 그 타깃이
 * 실행물·재시작·소켓 셋을 몸통에 넘긴다는 사실로 가른다(별칭·몸통은 넘기지 않는다).
 *
 * @param {string} makefile
 * @returns {string[]}
 */
export function acceptanceTargetsIn(makefile) {
  const names = new Set();
  const lines = String(makefile).split("\n");
  for (const [index, line] of lines.entries()) {
    // 타깃 선언은 줄 맨 앞에서 시작한다(레시피 안의 재귀 호출은 탭으로 들여쓴다).
    const match = /^([A-Za-z0-9_-]+):/.exec(line);
    if (!match || !match[1].startsWith(TARGET_PREFIX)) continue;
    // 이 타깃의 레시피(들여쓴 줄) 안에서 프레임워크 축 셋을 넘기는지 본다.
    const recipe = [];
    for (let at = index + 1; at < lines.length && (lines[at].startsWith("\t") || lines[at] === ""); at += 1) {
      recipe.push(lines[at]);
    }
    const body = recipe.join("\n");
    if (!body.includes("ACCEPTANCE_EXECUTABLE=")
        || !body.includes("ACCEPTANCE_RESTART=")
        || !body.includes("ACCEPTANCE_SOCKET=")) continue;
    names.add(match[1].slice(TARGET_PREFIX.length));
  }
  return [...names];
}
