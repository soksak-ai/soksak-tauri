// 저장소 변경 알림의 **도착**을 센다 — 보낸 쪽만 세면 반쪽이다.
//
// 알림은 프로세스를 건너온다(A22 알림 축): 저장소 주인이 방송하고 창 가진 쪽들이 받는다. 그
// 경로가 끊기면 아무 오류도 안 난다 — 상대는 자기가 든 옛 값을 그대로 진실로 알고, 다음 저장에서
// 남의 변경을 덮는다. 그 손실을 눈으로 보려면 "받았는가"가 물어볼 수 있는 값이어야 한다.
//
// 시도 0 은 건강이 아니라 **미확인**이다: 배선이 통째로 빠진 프로세스와 아직 아무도 안 바꾼
// 프로세스가 똑같아 보이면 안 된다.
import { moduleState } from "../lib/moduleState";

const box = moduleState("state/dataChangeHealth#received", () => ({
  count: 0,
  lastAt: 0,
  lastNs: "",
  lastOp: "",
}));

/** 알림 하나가 도착했다. 구독 배선의 수신구가 부른다. */
export function noteDataChange(ns: string, op: string): void {
  box.count += 1;
  box.lastAt = Date.now();
  box.lastNs = ns;
  box.lastOp = op;
}

/** 도착 실황 — `state.health` 가 싣는다. */
export function dataChangeHealth(): Record<string, unknown> {
  return {
    received: box.count,
    lastAt: box.lastAt || null,
    lastNs: box.lastNs || null,
    lastOp: box.lastOp || null,
  };
}
