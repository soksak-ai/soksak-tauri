// @vitest-environment node
// 표에 실린 이름은 그 자체가 주장이다.
//
// assemble() 이 갈래(window_·webview_·engine_·titlebar_) 밖 이름을 적재에서 거부하면서 사유를
// 이렇게 적었다: "갈래 밖 이름은 표에 실려도 발견되지 않는다". 바로 옆의 claims() 가 그 말을
// 반증한다 — `cmd in TABLE` 이 있어 표에 실린 이름은 그대로 발견된다.
//
// 근거 없는 제약은 준수 대상이 아니라 제거 대상이다. 그리고 이 제약은 실제로 막고 있었다:
// project_claim 은 창을 소유한 쪽이 져야 하는데(root → 창 라벨 지도의 수명이 창의 수명이다)
// project_ 는 갈래가 아니라 표에 실을 수 없었다. project_ 를 갈래로 만드는 것도 답이 아니다 —
// ensure_project_dir 은 파일시스템이라 cored 의 것이고, 갈래로 만들면 그것까지 프레임워크가 삼킨다.
//
// 갈래는 **표에 없는 이름**을 위한 그물이다. 표에 있는 이름에는 갈래가 필요 없다.
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const requireCjs = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = join(HERE, "../../frameworks/electron/native/index.cjs");

describe("표에 실린 이름은 갈래 밖이어도 프레임워크의 것이다", () => {
  it("갈래 밖 이름도 주장한다", () => {
    const native = requireCjs(INDEX);
    // project_ 는 갈래가 아니다 — 그런데 표에 있으므로 프레임워크가 답해야 한다.
    expect(native.claims("project_claim")).toBe(true);
    expect(native.claims("project_release")).toBe(true);
    expect(native.claims("project_owners")).toBe(true);
  });

  it("표에도 없고 갈래도 아니면 백엔드의 것이다 — 그물이 넓어지지 않았다", () => {
    const native = requireCjs(INDEX);
    for (const cmd of ["ensure_project_dir", "data_kv_get", "themes_scan", "activity_publish"]) {
      expect(native.claims(cmd), cmd).toBe(false);
    }
  });

  it("갈래는 표에 없는 이름을 위한 그물로 남는다", () => {
    const native = requireCjs(INDEX);
    expect(native.claims("window_never_declared")).toBe(true);
    expect(native.claims("webview_never_declared")).toBe(true);
  });
});
