// 사용자 자산을 덮어쓰기 전에 **직전 값을 남긴다** — 덮어쓰기가 일어나도 되돌릴 수 있게.
//
// 실측(2026-08-01): 워크스페이스 스냅샷은 `DO UPDATE SET v=excluded.v` 로 저장된다. 즉 쓰는
// 순간 이전 값이 사라진다. 백업 링은 있지만 최소 간격이 1시간이라, 그 사이의 작업은 어디에도
// 없다. 실제로 그 구멍에서 사용자 워크스페이스가 사라졌고 1시간 전 백업으로만 되살렸다.
//
// "복원 실패 시 저장 금지"(persistGuard)는 **원인 하나**를 막는다. 그러나 원인은 그것만이
// 아니다 — 크래시·강제종료·플러그인 오작동·앞으로 생길 버그. 원인을 다 막을 수는 없으므로,
// **잃어도 되돌릴 수 있어야** 한다.
//
// 모든 저장마다 세대를 남기면 400ms 전 값만 남아 쓸모가 없다. 남길 가치가 있는 것은
// **줄어드는 쓰기** 하나다: 프로젝트나 탭이 사라지는 저장 직전의 값.
import { describe, it, expect } from "vitest";
import { losesContent } from "./snapshotGeneration";

// **저장 모양**으로 짓는다 — 런타임 모양(`spaces`·`type:"leaf"`·`tabs`)이 아니라 직렬화가
// 실제로 남기는 모양(`contents`·`t:"l"`·`views`)이다. 처음엔 런타임 모양으로 써서 이 검사가
// 전부 GREEN 인데 실제로는 늘 0 을 세고 있었다 — e2e 가 그 거짓 GREEN 을 잡았다(2026-08-01).
const snap = (projects: number, tabsPerSpace = 1, spacesPerProject = 1) => ({
  activeId: "p0",
  projects: Array.from({ length: projects }, (_, i) => ({
    id: `p${i}`,
    root: `/r${i}`,
    contents: Array.from({ length: spacesPerProject }, (_, s) => ({
      id: `s${i}-${s}`,
      layout: {
        t: "l",
        v: { views: Array.from({ length: tabsPerSpace }, (_, t) => ({ id: `t${t}` })) },
      },
    })),
  })),
});

describe("잃는 쓰기를 가른다", () => {
  it("프로젝트가 줄면 잃는 쓰기다", () => {
    expect(losesContent(snap(3), snap(2))).toBe(true);
  });

  it("탭이 줄어도 잃는 쓰기다", () => {
    expect(losesContent(snap(1, 3), snap(1, 1))).toBe(true);
  });

  it("전부 사라지는 것은 가장 잃는 쓰기다 — 복원 실패의 모양이다", () => {
    expect(losesContent(snap(3), snap(0))).toBe(true);
  });

  it("늘거나 그대로면 잃지 않는다 — 세대를 남길 이유가 없다", () => {
    expect(losesContent(snap(2), snap(3))).toBe(false);
    expect(losesContent(snap(2), snap(2))).toBe(false);
    expect(losesContent(snap(1, 1), snap(1, 4))).toBe(false);
  });

  it("스페이스가 줄어도 잃는 쓰기다 — 빈 스페이스를 닫는 것도 자산이 준다", () => {
    // e2e RED(2026-08-01): 탭만 세면 빈 스페이스가 사라지는 저장이 안 잡혔다.
    expect(losesContent(snap(1, 0, 2), snap(1, 0, 1))).toBe(true);
  });

  it("이전 값이 없으면 잃을 것도 없다 — 첫 저장", () => {
    expect(losesContent(null, snap(1))).toBe(false);
  });

  it("빈 것에서 빈 것으로는 잃지 않는다", () => {
    expect(losesContent(snap(0), snap(0))).toBe(false);
  });
});
