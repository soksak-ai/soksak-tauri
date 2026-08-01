// 모르는 것으로 아는 것을 덮지 않는다 — **복원에 실패했으면 저장하지 않는다.**
//
// 실측(2026-08-01, 세 번): 복원 경로가 예외로 죽자 창이 빈 상태가 됐고, 그 빈 상태가 곧바로
// 저장되어 스냅샷을 덮었다(10KB → 32바이트). 사용자 워크스페이스 셋이 그렇게 사라졌고,
// 백업 링에서만 되살릴 수 있었다. 복원 실패는 일시적일 수 있지만 덮어쓰기는 영구다.
//
// 빈 상태에는 두 얼굴이 있다: "사용자가 다 닫았다"와 "복원이 실패했다". 앞엣것은 저장해야 하고
// 뒤엣것은 저장하면 안 된다. 둘을 가르는 사실은 하나다 — **스냅샷에 무엇이 있었는가.**
//
// 그런데 그 사실 자체를 못 읽을 수 있다. 저장소 주인은 별도 프로세스(cored)라 안 붙었으면 읽기가
// 실패한다 — 3차 소실(13:24 실측)이 그 길이었다. 실패를 수 0 으로 적으면 "원래 빈 창"과 같은
// 값이 되고, 가드는 문을 연다. **못 읽은 것은 비어 있는 것이 아니다.**
import { describe, it, expect } from "vitest";
import { mayPersist, mayAdoptLateRead, snapshotRead, snapshotUnread } from "./persistGuard";

describe("복원 실패는 저장을 막는다", () => {
  it("복원할 것이 있었는데 하나도 못 살렸으면 저장하지 않는다", () => {
    expect(
      mayPersist({ snapshot: snapshotRead(3), restoredProjects: 0, liveProjects: 0 }),
    ).toBe(false);
  });

  it("사용자가 다 닫은 것은 저장한다 — 복원은 성공했고 그 뒤에 비운 것이다", () => {
    expect(
      mayPersist({ snapshot: snapshotRead(3), restoredProjects: 3, liveProjects: 0 }),
    ).toBe(true);
  });

  it("빈 스냅샷에서 시작한 창은 저장한다 — 덮을 것이 없다", () => {
    expect(
      mayPersist({ snapshot: snapshotRead(0), restoredProjects: 0, liveProjects: 0 }),
    ).toBe(true);
  });

  it("일부만 살아났어도 저장한다 — 드롭은 규칙(P6)이지 실패가 아니다", () => {
    expect(
      mayPersist({ snapshot: snapshotRead(3), restoredProjects: 1, liveProjects: 1 }),
    ).toBe(true);
  });

  it("지금 프로젝트가 있으면 저장한다 — 무엇으로 채웠든 덮을 위험이 없다", () => {
    expect(
      mayPersist({ snapshot: snapshotRead(3), restoredProjects: 0, liveProjects: 2 }),
    ).toBe(true);
  });
});

describe("못 읽은 것은 비어 있는 것이 아니다", () => {
  it("스냅샷을 못 읽었으면 저장하지 않는다 — 무엇을 덮는지 모른다", () => {
    expect(
      mayPersist({ snapshot: snapshotUnread(), restoredProjects: 0, liveProjects: 0 }),
    ).toBe(false);
  });

  it("못 읽었으면 지금 창이 차 있어도 저장하지 않는다 — 아래 있는 것을 모른다", () => {
    // 3차 소실의 모양: 읽기가 실패했는데 창은 기본 부트로 프로젝트 하나를 세웠고, 그 하나가
    // 셋을 덮었다. "지금 차 있으니 안전하다"는 판정은 읽은 창에서만 성립한다.
    expect(
      mayPersist({ snapshot: snapshotUnread(), restoredProjects: 0, liveProjects: 2 }),
    ).toBe(false);
  });

  it("못 읽음은 수로 적히지 않는다 — 0 과 같은 값이 되면 그 순간 가드가 열린다", () => {
    const unread = snapshotUnread();
    const empty = snapshotRead(0);
    expect(unread).not.toEqual(empty);
    expect(mayPersist({ snapshot: unread, restoredProjects: 0, liveProjects: 0 })).toBe(false);
    expect(mayPersist({ snapshot: empty, restoredProjects: 0, liveProjects: 0 })).toBe(true);
  });
});

describe("늦게 읽은 값은 비었을 때만 채택한다", () => {
  it("늦게 읽었더니 비어 있으면 채택한다 — 덮을 것이 없다", () => {
    expect(mayAdoptLateRead(0)).toBe(true);
  });

  it("늦게 읽었더니 차 있으면 채택하지 않는다 — 복원한 적 없는 창이 덮게 된다", () => {
    expect(mayAdoptLateRead(3)).toBe(false);
    expect(mayAdoptLateRead(1)).toBe(false);
  });

  it("채택하지 않으면 저장도 막힌 채로 남는다 — 늦은 읽기가 가드를 우회하지 않는다", () => {
    const late = 3;
    const snapshot = mayAdoptLateRead(late) ? snapshotRead(late) : snapshotUnread();
    expect(mayPersist({ snapshot, restoredProjects: 0, liveProjects: 1 })).toBe(false);
  });
});
