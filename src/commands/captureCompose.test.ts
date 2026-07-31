// 자르기와 저장은 서로 다른 축이다 — 조합이 조용히 버려지면 안 된다.
//
// 실측(2026-07-31): `window.snapshot` 이 rect 를 받으면 `path` 를 통째로 무시하고 base64 만
// 답했다. 부른 쪽은 ok:true 를 받고 파일은 없었다 — 조용한 무시라 어디서 어긋났는지 밖에서
// 읽을 방법이 없었다. 그 아래에는 표면의 비대칭이 있었다: 읽기는 base64 로 되는데 쓰기가
// 텍스트뿐이라, 이진 산출물을 만든 쪽이 파일로 남길 길이 없었다.
//
// 스펙이 그 조합을 약속하는지 여기서 못 박는다. 라이브 검증은 별개로 했고(rect+path 65515B,
// node+path 2879B), 이 검사는 약속이 조용히 되돌려지는 것을 막는다.
import { describe, it, expect, beforeEach, vi } from "vitest";

const BAG_KEY = "__soksakModuleState";

describe("캡처 — 자르기와 저장은 조합된다", () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[BAG_KEY];
    vi.resetModules();
  });

  it("스펙이 rect·node·path·base64 를 모두 받는다", async () => {
    const exec = await import("./executor");
    exec.startExecutor();
    const reg = await import("./registry");
    const spec = reg.getSpec("window.snapshot");
    expect(spec).toBeDefined();
    for (const key of ["rect", "node", "path", "base64"]) {
      expect(Object.keys(spec!.params)).toContain(key);
    }
  });

  it("탭을 이름으로 담고, 해소 결과를 답한다", async () => {
    const exec = await import("./executor");
    exec.startExecutor();
    const reg = await import("./registry");
    const spec = reg.getSpec("window.snapshot")!;
    expect(Object.keys(spec.params)).toContain("tab");
    // 대상 축을 받았으면 무엇으로 해소했는지 답한다 — 부른 쪽이 응답만으로 검증할 수 있어야 한다.
    expect(spec.returns).toContain("tabId");
    // 비활성 탭은 창 밖으로 파킹되므로 이 명령이 활성화한다. 그 사실과 되돌린다는 약속이
    // 설명에 있어야 부른 쪽이 화면이 잠깐 바뀌는 것을 결함으로 읽지 않는다.
    expect(spec.description).toContain("restores");
  });

  it("자른 결과도 파일로 남길 수 있다고 선언한다", async () => {
    const exec = await import("./executor");
    exec.startExecutor();
    const reg = await import("./registry");
    const spec = reg.getSpec("window.snapshot")!;
    // 예시는 계약의 얼굴이다 — 조합이 예시에 없으면 아무도 그것을 부르지 않는다.
    const examples = spec.examples ?? [];
    expect(examples.some((e) => e.includes("rect") && e.includes("path"))).toBe(true);
    expect(examples.some((e) => e.includes("node") && e.includes("path"))).toBe(true);
    // 옛 스펙은 rect 가 base64 를 "함의한다"고 적어 path 무시를 정당화했다. 그 문장이 살아
    // 있으면 구현이 되돌아가도 스펙이 편들어 준다.
    expect(spec.description).not.toContain("implies base64");
  });
});
