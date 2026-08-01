// 모르는 것으로 아는 것을 덮지 않는다 — **복원에 실패했으면 저장하지 않는다.**
//
// 실측(2026-08-01, 두 번): 복원 경로가 예외로 죽자 창이 빈 상태가 됐고, 그 빈 상태가 곧바로
// 저장되어 스냅샷을 덮었다(10KB → 32바이트). 사용자 워크스페이스 셋이 그렇게 사라졌고,
// 백업 링에서만 되살릴 수 있었다. 복원 실패는 일시적일 수 있지만 덮어쓰기는 영구다.
//
// 빈 상태에는 두 얼굴이 있다: "사용자가 다 닫았다"와 "복원이 실패했다". 앞엣것은 저장해야 하고
// 뒤엣것은 저장하면 안 된다. 둘을 가르는 사실은 하나다 — **스냅샷에 무엇이 있었는가.**
import { describe, it, expect } from "vitest";
import { mayPersist } from "./persistGuard";

describe("복원 실패는 저장을 막는다", () => {
  it("복원할 것이 있었는데 하나도 못 살렸으면 저장하지 않는다", () => {
    expect(mayPersist({ snapshotProjects: 3, restoredProjects: 0, liveProjects: 0 })).toBe(false);
  });

  it("사용자가 다 닫은 것은 저장한다 — 복원은 성공했고 그 뒤에 비운 것이다", () => {
    expect(mayPersist({ snapshotProjects: 3, restoredProjects: 3, liveProjects: 0 })).toBe(true);
  });

  it("빈 스냅샷에서 시작한 창은 저장한다 — 덮을 것이 없다", () => {
    expect(mayPersist({ snapshotProjects: 0, restoredProjects: 0, liveProjects: 0 })).toBe(true);
  });

  it("일부만 살아났어도 저장한다 — 드롭은 규칙(P6)이지 실패가 아니다", () => {
    expect(mayPersist({ snapshotProjects: 3, restoredProjects: 1, liveProjects: 1 })).toBe(true);
  });

  it("지금 프로젝트가 있으면 저장한다 — 무엇으로 채웠든 덮을 위험이 없다", () => {
    expect(mayPersist({ snapshotProjects: 3, restoredProjects: 0, liveProjects: 2 })).toBe(true);
  });
});
