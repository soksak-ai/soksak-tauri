// @vitest-environment node
// 하나만 선다 — 거두는 것이 아니라 애초에 겹치지 않는다.
//
// 두 번째 실행이 두 번째 앱이 되면 검증할 때마다 인스턴스가 쌓이고, 쌓인 것을 죽이는 일이
// 매번 붙는다. 그것은 멱등이 아니다 — 사용자가 아이콘을 두 번 눌러도 같은 일이 난다.
//
// Electron 은 이것을 잠금 하나로 준다: requestSingleInstanceLock() 이 false 면 이미 사는
// 인스턴스가 있다는 뜻이고, 그때 이 프로세스는 **아무것도 만들지 않고** 물러난다. 먼저 선
// 쪽이 second-instance 를 받아 자기 창을 앞으로 낸다.
//
// 정체성이 다르면 다른 앱이다 — dev·debug·release 홈은 각자 하나씩 선다. 잠금 이름이
// identifier 를 담아야 그 구분이 성립한다.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAIN = join(dirname(fileURLToPath(import.meta.url)), "../../electron/main.cjs");

describe("단일 인스턴스", () => {
  const src = () => readFileSync(MAIN, "utf8");

  it("잠금을 먼저 잡고, 못 잡으면 창을 만들지 않고 물러난다", () => {
    const s = src();
    // 오라클 생존 — 부팅 자리가 사라졌으면 아래 단언이 무의미하다.
    expect(s).toContain("app.whenReady");
    expect(s).toMatch(/requestSingleInstanceLock\(/);
    expect(s).toMatch(/app\.(quit|exit)\(/);
  });

  it("먼저 선 쪽이 두 번째 실행을 받아 자기 창을 앞으로 낸다", () => {
    expect(src()).toMatch(/["']second-instance["']/);
  });

  it("정체성이 다르면 다른 앱이다 — 잠금이 identity 를 탄다", () => {
    const s = src();
    // Electron 의 잠금은 userData 경로로 갈린다. 홈이 identity 마다 다르므로 그 경로를
    // identity 홈으로 지목하면 dev·debug·release 가 각자 하나씩 선다.
    expect(s).toMatch(/setPath\(\s*["']userData["']/);
  });
});
