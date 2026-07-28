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
const TABLE = join(ROOT, "electron/native/project.cjs");
const FIXTURE = join(ROOT, "src-tauri/crates/soksak-core/fixtures/project-claims.json");

/** 창 문맥 스텁 — 살아 있는 라벨과 "부른 창"만 준다. */
function ctxFor(labels, caller) {
  return {
    labels: () => labels,
    window: { __label: caller },
    labelOf: (w) => w?.__label ?? null,
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
      for (const s of c.steps) {
        if (s.op === "alive") {
          alive = s.labels;
          // 살아 있는 목록이 바뀌면 그 순간 죽은 점유가 걸러진다 — 아무 호출이나 그것을 거친다.
          table.project_owners.answer(ctxFor(alive, alive[0]));
          continue;
        }
        const ctx = ctxFor(alive, s.label);
        const got = table[`project_${s.op}`].answer(ctx, { root: s.root });
        expect(got, `${c.why} — ${s.op} ${s.root} by ${s.label}`).toMatchObject(s.want);
      }
      const owners = table.project_owners.answer(ctxFor(alive, alive[0])).owners;
      // 목록은 root 순서로 결정적이다 — 순서가 흔들리면 같은 상태에 다른 답이 나간다.
      expect([...owners].sort((a, b) => a.root.localeCompare(b.root))).toEqual(c.owners);
    });
  }
});
