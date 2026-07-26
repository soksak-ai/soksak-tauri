// 대상 에코 게이트 — 대상 축을 받은 명령은 해소된 그 축을 자기 답에 싣는다.
//
// (a) 이 게이트가 지키는 규칙
//   대상 축(project · space · panel/pane · view/tab)을 파라미터로 받는 코어 명령은, 그 축이
//   무엇으로 해소됐는지를 returns 에 명시한다. 생략은 "호출자 문맥"으로 조용히 채워지므로,
//   답이 해소 결과를 말하지 않으면 호출자는 어디에 실행됐는지 알 방법이 없다. 그래서 검증이
//   짐작 위에서 GREEN 을 받는다 — 실사고: 축을 생략한 호출이 "첫 등록된 아무 것"으로 가서
//   성공을 답했고, 6회 실행 동안 잘못된 검증이 통과했다.
//   축 하나당 에코 이름은 하나다: project→projectId · space→spaceId · panel→panelId ·
//   pane→paneId · view→viewId · tab→tabId. 이름이 축마다 갈라지면 대조 자체가 불가능해진다.
//
// (b) RED 근거 (실측, 2026-07-26)
//   src/commands/catalog*.ts 의 register 블록 226개 중 대상 축을 파라미터로 받는 명령은 46개.
//   그중 해소된 축을 returns 에 싣지 않는 명령이 39개다 — 축 인스턴스로는 44건
//   (project 30 · space 3 · view 6 · pane 5. 다섯 명령이 두 축을 함께 빠뜨린다).
//   예: space.activate 는 project·space 를 받고 답에 둘 다 없고, panel.split 은 project 를
//   받고 panelId·viewId 만 답한다.
//   플랜(enchanted-waddling-hollerith §5)은 이 자리를 35 로 적었으나 실측은 39다 — 플랜의
//   수가 재현 불가하므로 실측을 정본으로 둔다(R-A6).
//   레지스트리는 앱 없이 세울 수 없으므로 소스를 읽는다(commandMessages.test·windowAxis.test 방식).
//
// (c) 그 수를 만든 셸 질의
//   npx vitest run src/commands/targetEcho.test.ts        # 정본 — 아래 질의와 같은 수를 낸다
//
//   node --input-type=module -e '
//   import {readdirSync,readFileSync} from "node:fs";
//   const d="src/commands",A={project:"projectId",space:"spaceId",panel:"panelId",pane:"paneId",view:"viewId",tab:"tabId"};
//   let n=0,o=[];
//   for(const f of readdirSync(d).filter(f=>/^catalog.*\.ts$/.test(f)&&!f.includes(".test."))){
//     const s=readFileSync(d+"/"+f,"utf8"),m=[...s.matchAll(/register\("([^"]+)", \{/g)];
//     m.forEach((x,i)=>{const b=s.slice(x.index,i+1<m.length?m[i+1].index:s.length);
//       const p=b.indexOf("params:"),r=b.indexOf("returns:",p);
//       const P=b.slice(p,r),R=b.slice(r).split(/\n {4}(?:message|errors|handler|examples|hint):/)[0];
//       const ax=Object.keys(A).filter(a=>new RegExp("\\n\\s+"+a+":").test(P));
//       if(!ax.length)return; n++;
//       const miss=ax.filter(a=>!new RegExp("\\b"+A[a]+"\\b").test(R));
//       if(miss.length)o.push(x[1]+" ["+miss.join(",")+"]");});}
//   console.log("axis-taking:",n,"offenders:",o.length);console.log(o.join("\n"));'
//
// 창 축(windowLabel)은 이 게이트 밖이다 — 봉투가 이미 그 창을 지목하고, 그 축의 동일성은
// windowAxis.test 가 따로 지킨다.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** 축 이름 → 답에 실려야 하는 에코 이름. 축 하나당 하나다. */
const AXIS_ECHO = {
  project: "projectId",
  space: "spaceId",
  panel: "panelId",
  pane: "paneId",
  view: "viewId",
  tab: "tabId",
} as const;
type Axis = keyof typeof AXIS_ECHO;
const AXES = Object.keys(AXIS_ECHO) as Axis[];

/** returns 다음에 오는 스펙 키들 — returns 서술의 끝을 여기서 끊는다. */
const AFTER_RETURNS =
  /\n {4}(?:message|errors|handler|examples|hint|triggers|danger|confirm|deprecated|schema):/;

type Block = { file: string; name: string; params: string; returns: string };

/** 코어 카탈로그 소스의 register("<이름>", { ... }) 블록 전부 — 다음 register 앞까지. */
function blocks(): Block[] {
  const dir = join(__dirname);
  const out: Block[] = [];
  for (const file of readdirSync(dir)) {
    if (!/^catalog.*\.ts$/.test(file) || file.includes(".test.")) continue;
    const src = readFileSync(join(dir, file), "utf8");
    const marks = [...src.matchAll(/register\("([^"]+)", \{/g)];
    marks.forEach((m, i) => {
      const start = m.index ?? 0;
      const end = i + 1 < marks.length ? (marks[i + 1].index ?? src.length) : src.length;
      const body = src.slice(start, end);
      // 파라미터 구간은 params: 부터 returns: 앞까지 — 핸들러 본문의 같은 이름을 파라미터로
      // 오인하지 않는다. returns 구간은 다음 스펙 키 앞까지.
      const p = body.indexOf("params:");
      const r = body.indexOf("returns:", p < 0 ? 0 : p);
      const params = p < 0 ? "" : body.slice(p, r < 0 ? body.length : r);
      const tail = r < 0 ? "" : body.slice(r);
      const cut = tail.search(AFTER_RETURNS);
      out.push({
        file,
        name: m[1],
        params,
        returns: r < 0 ? "" : tail.slice(0, cut < 0 ? tail.length : cut),
      });
    });
  }
  return out;
}

/** 그 블록이 파라미터로 받는 대상 축들. */
function axesOf(b: Block): Axis[] {
  return AXES.filter((a) => new RegExp(`\\n\\s+${a}:`).test(b.params));
}

/** 답에 실리지 않은 축들. */
function missingEcho(b: Block): Axis[] {
  return axesOf(b).filter((a) => !new RegExp(`\\b${AXIS_ECHO[a]}\\b`).test(b.returns));
}

const ALL = blocks();
const AXIS_TAKING = ALL.filter((b) => axesOf(b).length > 0);

describe("대상 에코 — 축을 받은 명령은 해소 결과를 답한다", () => {
  it("셀 것이 실제로 있다 — 빈 집합이 통과로 위장하지 않는다", () => {
    // 파싱이 깨지면 위반 0 이 되어 게이트가 조용히 죽는다. 모집단부터 못박는다.
    expect(ALL.length).toBeGreaterThan(150);
    expect(AXIS_TAKING.length).toBeGreaterThan(30);
  });

  it("대상 축을 받는 명령은 전부 그 축을 returns 에 싣는다", () => {
    const offenders = AXIS_TAKING.filter((b) => missingEcho(b).length > 0)
      .map((b) => `${b.name} [${missingEcho(b).join(",")}] (${b.file})`)
      .sort();
    expect(offenders).toEqual([]);
  });

  it("에코 이름은 축마다 하나다 — returns 에 축 이름의 다른 변형을 쓰지 않는다", () => {
    // projectId 를 project_id·pjtId 처럼 달리 적으면 위 대조가 통과해도 호출자는 못 읽는다.
    const offenders: string[] = [];
    for (const b of AXIS_TAKING) {
      for (const a of axesOf(b)) {
        const wrong = new RegExp(`\\b(?:${a}_id|${a}Ident|${a}Key)\\b`, "i");
        if (wrong.test(b.returns)) offenders.push(`${b.name} [${a}] (${b.file})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
