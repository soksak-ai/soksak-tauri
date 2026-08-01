// @vitest-environment node
// 프로젝트 root 점유 — **두 구현이 같은 답을 낸다.**
//
// 지도는 창을 소유한 쪽이 진다(수명이 곧 창의 수명) — cored 가 쥐면 프레임워크가 재기동한
// 뒤에도 죽은 창의 점유가 남아 그 프로젝트를 다시 못 연다. 그래서 구현이 둘이다.
//
// 규칙까지 둘이면 같은 조작에 두 프레임워크가 다르게 답하고, 그 차이는 오류가 아니라
// "이쪽에서만 프로젝트가 안 열린다"로 나타난다. 같은 픽스처가 그것을 묶는다 — 이 파일과
// Rust ProjectRegistry 검사가 같은 JSON 하나를 읽는다.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireCjs = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const TABLE = join(ROOT, "frameworks/electron/native/project.cjs");
const FIXTURE = join(ROOT, "crates/soksak-core/fixtures/project-claims.json");

/** 창 문맥 스텁 — 살아 있는 라벨과 "부른 창"만 준다. */
function ctxFor(labels, caller, announced = []) {
  return {
    labels: () => labels,
    window: { __label: caller },
    labelOf: (w) => w?.__label ?? null,
    // 실물이 갖는 것 — 스텁이 더 좁으면 그 차이가 곧 거짓 GREEN 이다. 여기서는 더 나아가
    // **통지가 났는지도 잰다**: 지도가 바뀌었는데 아무도 못 들으면 다른 창의 프로젝트 픽커가
    // 낡은 목록을 계속 보인다(실측 2026-08-01: 이 프레임워크엔 발행이 아예 없었다).
    announce: (event) => announced.push(event),
  };
}

describe("점유 규칙 — Rust 레지스트리와 같은 답", () => {
  const doc = JSON.parse(readFileSync(FIXTURE, "utf8"));

  it("픽스처가 비어 있지 않다 — 비면 이 검사는 아무것도 안 지키면서 통과한다", () => {
    expect(doc.cases.length).toBeGreaterThan(0);
  });

  for (const c of doc.cases) {
    it(`${c.why}`, () => {
      // 표는 프로세스 안의 지도를 쥔다 — 사례마다 새로 적재해 서로를 오염시키지 않는다.
      delete requireCjs.cache[TABLE];
      const table = requireCjs(TABLE);
      let alive = ["w-1", "w-2"];
      const announced = [];
      let mutations = 0;
      for (const s of c.steps) {
        if (s.op === "alive") {
          alive = s.labels;
          // 살아 있는 목록이 바뀌면 그 순간 죽은 점유가 걸러진다 — 아무 호출이나 그것을 거친다.
          table.project_owners.answer(ctxFor(alive, alive[0]));
          continue;
        }
        const before = JSON.stringify(table.project_owners.answer(ctxFor(alive, alive[0])).owners);
        const ctx = ctxFor(alive, s.label, announced);
        const got = table[`project_${s.op}`].answer(ctx, { root: s.root });
        expect(got, `${c.why} — ${s.op} ${s.root} by ${s.label}`).toMatchObject(s.want);
        const after = JSON.stringify(table.project_owners.answer(ctxFor(alive, alive[0])).owners);
        if (before !== after) mutations += 1;
      }
      const owners = table.project_owners.answer(ctxFor(alive, alive[0])).owners;
      // 목록은 root 순서로 결정적이다 — 순서가 흔들리면 같은 상태에 다른 답이 나간다.
      expect([...owners].sort((a, b) => a.root.localeCompare(b.root))).toEqual(c.owners);
      // 지도가 바뀐 만큼만 알린다. 덜 알리면 다른 창이 낡은 목록을 보이고, 더 알리면 바뀐 것도
      // 없는데 전 창이 다시 읽는다 — 둘 다 규칙 위반이라 수로 못 박는다.
      expect(announced.length, `${c.why} — 통지 수가 변이 수와 같아야 한다`).toBe(mutations);
      expect(new Set(announced).size, "이름은 한 벌이다").toBeLessThanOrEqual(1);
    });
  }
});
