// @vitest-environment jsdom
// 한 자리에 둘이 쓰면 하나는 사라진다.
//
// 같은 라벨을 두 프레임워크가 들 수 있다(`main` 은 오케스트레이터 역할이라 앱마다 하나씩 있고,
// 워크스페이스 창은 저장된 `w-<uuid>` 를 의도적으로 되쓴다). 고를 수 없으면 전부에게 보내는
// 것이 옳다 — 한때 겹치면 거절했더니 두 앱을 함께 켠 순간 어느 쪽도 밖에서 못 불렀다.
//
// 그런데 부작용이 **부르는 쪽이 지정한 한 자리**에 남는 명령은 다르다. 실측 2026-08-08:
// `window.snapshot {path}` 를 두 호스트가 수행해 둘 다 OK 를 답했고 파일은 하나만 남았다.
// 나중에 쓴 쪽이 먼저 쓴 쪽을 덮었는데 어느 답에도 그 사실이 없다 — 성공을 답한 일이 남지
// 않는 것은 성공이 아니다.
//
// 그래서 배달이 **몇에게 갔는지**를 싣고(soksak_core::control::deliver_envelope), 받는 쪽이
// 그 수를 읽어 거절한다. 적어 둔 계약은 읽혀야 한다.
import { describe, expect, it, vi } from "vitest";

vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: vi.fn(async () => ""),
}));

import { registerCatalog } from "./catalog";
import { execute } from "./registry";

// 등록부는 모듈 전역이다 — 매 검사마다 다시 등록하면 중복으로 거절된다.
registerCatalog();

describe("window.snapshot — 수행자가 여럿이면 경로에 쓰지 않는다", () => {
  it("경로를 주었는데 호스트가 둘이면 이름으로 거절한다", async () => {
    const out = await execute("window.snapshot", { path: "<local-evidence>/shot.png" }, { hosts: 2 });
    expect(out.ok, "둘이 같은 경로에 써서 하나가 사라지는데 성공을 답했다").toBe(false);
    expect(out.code).toBe("AMBIGUOUS_HOST");
    expect(out.message).toContain("base64");
  });

  it("호스트가 하나면 지나간다 — 겹치지 않는 부름까지 막지 않는다", async () => {
    const out = await execute("window.snapshot", { path: "<local-evidence>/shot.png" }, { hosts: 1 });
    expect(out.code).not.toBe("AMBIGUOUS_HOST");
  });

  it("수를 안 알려줬으면 하나로 본다 — 모름을 여럿으로 읽으면 멀쩡한 부름이 막힌다", async () => {
    const out = await execute("window.snapshot", { path: "<local-evidence>/shot.png" }, {});
    expect(out.code).not.toBe("AMBIGUOUS_HOST");
  });

  // 경로를 안 주면 각 답이 자기 그림을 들고 오므로 겹치지 않는다.
  it("base64 는 호스트가 여럿이어도 지나간다", async () => {
    const out = await execute("window.snapshot", { base64: true }, { hosts: 2 });
    expect(out.code).not.toBe("AMBIGUOUS_HOST");
  });
});
