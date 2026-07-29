// @vitest-environment node
// 창 소속 모니터 판정 — **두 구현이 같은 답을 낸다.**
//
// 규칙은 코어가 소유한다(soksak-core geometry). 프레임워크 표에 사본이 있는 이유는 창마다
// 프로세스를 건너지 않기 위해서다 — 그리고 백엔드가 없어도 프레임워크 사실은 답해야 한다.
//
// 사본이 갈리지 않는다는 것은 **같은 픽스처**가 묶는다. 이 파일과 코어의 geometry 검사가
// 같은 JSON 하나를 읽으므로, 한쪽만 고치면 그쪽이 깨진다. 사람 주의력이 아니라 파일이 묶는다.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireCjs = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const { monitorOf } = requireCjs(join(ROOT, "frameworks/electron/native/window.cjs"));
const FIXTURE = join(ROOT, "crates/soksak-core/fixtures/monitor-of.json");

describe("소속 모니터 — 코어와 같은 답", () => {
  const doc = JSON.parse(readFileSync(FIXTURE, "utf8"));

  it("픽스처가 비어 있지 않다 — 비면 이 검사는 아무것도 안 지키면서 통과한다", () => {
    expect(doc.cases.length).toBeGreaterThan(0);
  });

  for (const c of doc.cases) {
    it(`${c.why}`, () => {
      expect(monitorOf(c.window, c.monitors)).toBe(c.monitor);
    });
  }
});
