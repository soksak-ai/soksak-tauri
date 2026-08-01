// 되돌리기 전에 **무엇이 들어오는지** 사람이 볼 수 있어야 한다.
//
// 되돌릴 자리를 남기는 일 자체는 저장소가 한다(kv_past — 모든 쓰기에 대해 조건 없이). 한때
// 여기서 "잃는 쓰기"만 골라 사본을 따로 뒀는데, 그 규칙이 못 잡는 쓰기는 되돌릴 자리가 없었고
// 같은 사실이 두 자리에 있어 한쪽만 갱신되면 엉뚱한 값이 돌아왔다. 남은 것은 크기 세기다.
//
// RED 근거(실측 2026-08-01): 이 크기를 **런타임 모양**(`spaces`·`type:"leaf"`·`tabs`)으로 세다가
// 늘 0 을 답했다. 저장 모양은 `contents`·`t:"l"`·`views` 다. 테스트도 런타임 모양으로 쓰여 있어
// GREEN 이었고 e2e 가 잡았다 — **목이 실제 모양과 다르면 진짜 결함을 가린다.**
import { describe, it, expect } from "vitest";
import { snapshotSize } from "./snapshotGeneration";

// **저장 모양**으로 짓는다 — 직렬화가 실제로 남기는 모양이다.
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

describe("스냅샷 크기는 저장 모양에서 센다", () => {
  it("프로젝트·스페이스·탭을 센다", () => {
    expect(snapshotSize(snap(2, 3, 2))).toEqual({ projects: 2, spaces: 4, tabs: 12 });
  });

  it("빈 스냅샷은 0 이다", () => {
    expect(snapshotSize(snap(0))).toEqual({ projects: 0, spaces: 0, tabs: 0 });
  });

  it("없는 스냅샷도 0 이다 — 세는 자리가 던지면 되돌리기 조회가 통째로 실패한다", () => {
    expect(snapshotSize(null)).toEqual({ projects: 0, spaces: 0, tabs: 0 });
  });

  it("중첩 분할의 탭도 센다 — 한 겹만 보면 분할한 스페이스의 탭이 사라진다", () => {
    const nested = {
      projects: [
        {
          contents: [
            {
              layout: {
                t: "s",
                children: [
                  { t: "l", v: { views: [{ id: "a" }, { id: "b" }] } },
                  { t: "s", children: [{ t: "l", v: { views: [{ id: "c" }] } }] },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(snapshotSize(nested)).toEqual({ projects: 1, spaces: 1, tabs: 3 });
  });

  it("런타임 모양은 세지 않는다 — 저장 모양이 아니면 0 이다", () => {
    // 이 검사가 없으면 두 모양을 헷갈린 구현이 GREEN 으로 지나간다(실측: 지나갔다).
    const runtime = { projects: [{ spaces: [{ layout: { type: "leaf", tabs: [1, 2] } }] }] };
    expect(snapshotSize(runtime)).toEqual({ projects: 1, spaces: 0, tabs: 0 });
  });
});
