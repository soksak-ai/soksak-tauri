// 알림의 **도착**을 셀 수 없으면 프로세스를 건너오는 경로가 끊겨도 아무도 모른다.
//
// 실측(2026-08-01): 저장소 소유를 cored 로 옮긴 뒤 "한쪽에서 바꾸면 다른 쪽이 받는가"를 재려는데
// 잴 자리가 없었다. 받는 쪽이 조용히 갱신될 뿐, 안 받아도 조용하다 — 두 상태가 똑같아 보인다.
// 이 계수기가 그 둘을 가른다(라이브 실측: Tauri 쓰기 → Electron 창 수신 162→180).
import { describe, it, expect, beforeEach, vi } from "vitest";

const BAG_KEY = "__soksakModuleState";

describe("저장소 변경 알림 도착 계수", () => {
  beforeEach(() => {
    // 계수기는 모듈 경계 밖(globalThis)에 산다 — 가방만 지우면 이미 잡힌 참조가 남으므로
    // 모듈도 함께 되돌린다(reference_module-state-boundary).
    delete (globalThis as Record<string, unknown>)[BAG_KEY];
    vi.resetModules();
  });

  it("아무것도 안 왔으면 0 이고 마지막 사실은 없다", async () => {
    const m = await import("./dataChangeHealth");
    const h = m.dataChangeHealth();
    // 0 은 건강이 아니라 **미확인**이다 — 배선이 빠진 프로세스와 아직 아무도 안 바꾼 프로세스가
    // 같아 보이면 안 되므로, 판정은 부르는 쪽이 한다(여기선 사실만 답한다).
    expect(h.received).toBe(0);
    expect(h.lastAt).toBeNull();
    expect(h.lastNs).toBeNull();
  });

  it("도착을 세고 마지막 사실을 남긴다", async () => {
    const { noteDataChange, dataChangeHealth } = await import("./dataChangeHealth");
    noteDataChange("core", "kv_set");
    noteDataChange("soksak-plugin-kanban", "put");
    const h = dataChangeHealth();
    expect(h.received).toBe(2);
    expect(h.lastNs).toBe("soksak-plugin-kanban");
    expect(h.lastOp).toBe("put");
    expect(typeof h.lastAt).toBe("number");
  });

  it("이 창이 안 쓰는 ns 도 센다 — 경로가 산 증거다", async () => {
    // 거르고 나서 세면 "안 왔다"와 "왔는데 내 것이 아니었다"가 같아 보인다.
    const { noteDataChange, dataChangeHealth } = await import("./dataChangeHealth");
    noteDataChange("남의-플러그인", "put");
    expect(dataChangeHealth().received).toBe(1);
  });
});
