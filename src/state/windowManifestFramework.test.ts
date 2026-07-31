// 창 열림 장부는 **사용자 의도**다 — 누가 띄웠는지로 가르지 않는다.
//
// 장부(`windows`)는 "이 워크스페이스가 열려 있어야 한다"는 사실이고, 그건 사용자 자산이다.
// 여기에 띄운 쪽의 이름을 적으면 그 창은 그 프레임워크의 소유가 된다 — Tauri 를 끄고 Electron
// 만 켠 사용자는 **자기 창을 전부 잃는다**. 프레임워크를 바꾸는 것은 자산을 버리는 일이 아니다.
//
// 그래서 가르는 축은 소유가 아니라 **점유**다: 지금 그 라벨의 창을 든 호스트가 있으면 만들지
// 않는다. 점유는 런타임 사실이라 장부에 안 적히고, 프로세스가 죽으면 저절로 풀린다 —
// 저장소 소유(A22)와 같은 모델이다.
//
// 점유의 진실은 cored 가 안다. `window_census` 가 라벨마다 그 라벨을 든 호스트 수를 답한다 —
// 한 프로세스가 자기 창만 세면 상대가 든 창을 "없다"고 읽고 같은 라벨을 또 만든다.
//
// 실측(2026-08-01): 같은 라벨의 창이 두 프로세스에 살아나자 나중 창이 아무것도 그리지 않았다
// (성한 창 832 KB 에 대해 181 KB). 겹침을 막으면 같은 창이 891 KB 로 돌아왔다.
import { describe, it, expect } from "vitest";
import {
  restorableSlots,
  forgetWindow,
  frameworkScopedKey,
  type WindowManifest,
} from "./windowPersistence";

const slot = (label: string) => ({
  label,
  roots: [`/r/${label}`],
  activeRoot: `/r/${label}`,
});

describe("창 열림 장부의 복원 대상", () => {
  it("아무도 안 든 창을 되살린다 — 어느 프레임워크가 적었든", () => {
    const m: WindowManifest = { slots: [slot("w-a"), slot("w-b")] };
    expect(restorableSlots(m, new Set()).map((s) => s.label)).toEqual(["w-a", "w-b"]);
  });

  it("이미 살아 있는 창은 다시 만들지 않는다 — 그 호스트가 누구든", () => {
    // 상대 프레임워크가 든 창도 살아 있는 창이다. 자기 프로세스만 보면 또 만든다.
    const m: WindowManifest = { slots: [slot("w-a"), slot("w-b")] };
    expect(restorableSlots(m, new Set(["w-a"])).map((s) => s.label)).toEqual(["w-b"]);
  });

  it("main 은 되살리는 대상이 아니다 — 부팅이 이미 만든 창이다", () => {
    const m: WindowManifest = { slots: [slot("main"), slot("w-a")] };
    expect(restorableSlots(m, new Set()).map((s) => s.label)).toEqual(["w-a"]);
  });

  it("점유를 못 읽었으면 되살리지 않는다", () => {
    // 모르는 채 만들면 겹침이 조용히 돌아온다. 안 여는 것은 다음 부팅에 회복되지만, 겹쳐 만든
    // 창은 아무것도 그리지 않은 채 남는다 — 두 실패의 무게가 다르다.
    const m: WindowManifest = { slots: [slot("w-a")] };
    expect(restorableSlots(m, null)).toEqual([]);
  });

  it("장부는 그대로 돌려준다 — 복원이 사용자 의도를 고쳐 쓰지 않는다", () => {
    const m: WindowManifest = { slots: [slot("w-a")] };
    expect(restorableSlots(m, new Set())[0]).toEqual(m.slots[0]);
  });
});

// 닫은 창은 장부에서 사라진다 — 남으면 다음 부팅이 되살린다.
//
// 앱 종료와는 다르다. 종료는 창 전부를 닫지만 장부를 지우면 안 된다(다음 실행에 아무것도
// 안 열린다). 그래서 지우는 자리는 종료 경로가 아니라 **닫으라는 명령**이다.
describe("닫은 창의 slot", () => {
  it("장부에서 사라진다", () => {
    const m: WindowManifest = { slots: [slot("w-a"), slot("w-b")] };
    expect(forgetWindow(m, "w-a").slots.map((s) => s.label)).toEqual(["w-b"]);
  });

  it("그 창이 마지막 포커스였으면 그 기록도 지운다", () => {
    const m: WindowManifest = { slots: [slot("w-a")], focusedLabel: "w-a" };
    expect(forgetWindow(m, "w-a").focusedLabel).toBeUndefined();
  });

  it("다른 창의 포커스 기록은 건드리지 않는다", () => {
    const m: WindowManifest = { slots: [slot("w-a"), slot("w-b")], focusedLabel: "w-b" };
    expect(forgetWindow(m, "w-a").focusedLabel).toBe("w-b");
  });

  it("없는 라벨은 아무것도 바꾸지 않는다", () => {
    const m: WindowManifest = { slots: [slot("w-a")] };
    expect(forgetWindow(m, "w-zzz")).toEqual(m);
  });
});

// 프로세스가 자기 것만 기억해야 하는 값도 있다 — **자기 창의 자리**다.
//
// `controlPlaneFrame` 은 main 창의 자리·크기다. 공유하면 두 프레임워크의 컨트롤 플레인이 같은
// 자리에 겹쳐 뜬다. 여기엔 손실이 없다: 각자 자기 창의 자리를 기억할 뿐, 사용자 자산이 아니다.
describe("자기 창 자리 키의 프레임워크 축", () => {
  it("키에 프레임워크를 싣는다", () => {
    expect(frameworkScopedKey("controlPlaneFrame", "tauri")).toBe("controlPlaneFrame/tauri");
    expect(frameworkScopedKey("controlPlaneFrame", "electron")).toBe("controlPlaneFrame/electron");
  });

  it("프레임워크를 모르면 옛 키 그대로다 — 모르는 이름으로 새 키를 만들지 않는다", () => {
    expect(frameworkScopedKey("controlPlaneFrame", null)).toBe("controlPlaneFrame");
  });
});
