// @vitest-environment node
// 렌더러가 답하는 이름 — "없다"가 아니라 "여기가 아니다".
//
// 콘텐츠 조작(webview_open·navigate·bounds…)은 이 프레임워크에서 렌더러의 DOM 이 소유한다
// (src/lib/contentViews.ts 의 domHost). 프로세스를 건널 이유가 없어 앱은 그것을 invoke 하지
// 않는다.
//
// 그런데 이름이 프레임워크 갈래(webview_)라 표에 없으면 **부재로 거절**된다. 그것은 거짓이다 —
// 그 개념은 있고, 답하는 자리가 다를 뿐이다. 거짓 사유를 받은 사람은 없는 기능이라 믿고
// 우회를 만든다.
//
// 그래서 세 번째 상태가 필요하다: 부재도 구현도 아닌 **위임**.
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const requireCjs = createRequire(import.meta.url);
const INDEX = join(dirname(fileURLToPath(import.meta.url)), "../../frameworks/electron/native/index.cjs");

describe("DOM 이 소유하는 이름", () => {
  const table = () => requireCjs(INDEX);

  it("위임은 부재와 다른 코드로 답한다", () => {
    const n = table();
    const r = n.serve("webview_navigate", { label: "b-1", url: "u" }, {}, () => {});
    expect(r.ok).toBe(false);
    // 부재가 아니다 — 코드가 그것을 가른다.
    expect(r.code).not.toBe(n.ABSENT_CODE);
    expect(r.code).toBe("FRAMEWORK_DELEGATED");
  });

  it("사유가 어디로 가야 하는지 말한다 — 없다고 하지 않는다", () => {
    const r = table().serve("webview_open", {}, {}, () => {});
    expect(r.message).toContain("contentViews");
    expect(r.message).not.toContain("없다");
  });

  it("원장에는 프레임워크의 것으로 남되 서빙 실패가 아니다", () => {
    const rows = [];
    table().serve("webview_bounds", {}, {}, (cmd, served, code, by) => rows.push({ cmd, served, code, by }));
    expect(rows).toEqual([
      { cmd: "webview_bounds", served: false, code: "FRAMEWORK_DELEGATED", by: "framework" },
    ]);
  });

  it("콘텐츠 조작 전부가 위임으로 선언돼 있다 — 하나라도 빠지면 거짓 부재가 된다", () => {
    const n = table();
    const owned = [
      "webview_open", "webview_close", "webview_alive", "webview_bounds", "webview_visible",
      "webview_navigate", "webview_history", "webview_stop", "webview_zoom", "webview_zoom_view",
      "webview_devtools", "webview_inject_script", "webview_eval",
    ];
    for (const cmd of owned) {
      const r = n.serve(cmd, {}, {}, () => {});
      expect(r.code, cmd).toBe("FRAMEWORK_DELEGATED");
    }
  });

  it("진짜 부재는 그대로 부재다 — 위임이 부재를 먹지 않는다", () => {
    const n = table();
    for (const cmd of ["webview_dom_holes", "engine_host_visible", "titlebar_backing"]) {
      const r = n.serve(cmd, {}, {}, () => {});
      expect(r.code, cmd).toBe(n.ABSENT_CODE);
    }
  });
});
