// Tauri 표시 원장 실측 — **신고한 0 이 사실인가.**
//
// 옆 파일 recorded/presentation-silent-gaps.json 은 지어낸 값이 아니라 실제로 돌아간 slot-freeze
// 실행이 남긴 영수증이다(browser-chromium/02-right, 120Hz). 그 영수증은 자기 사건 안에 표시
// 하나를 건너뛴 프레임 쌍을 실어 보내면서 violations.gaps=0 을 신고한다. 같은 계약의 Electron
// 구현은 같은 자리에서 그 축을 센다 — 그래서 이 0 은 "그런 일이 없었다"가 아니라 "이 구현은
// 그 축을 세지 않는다"였고, 어느 게이트도 그 차이를 묻지 않았다.
//
// 이 파일은 그 사실을 데이터로 못 박는다. 재기록은 expectedAudit 을 새 사실로 갱신해서 한다 —
// 기대를 지워서 통과시키지 않는다.
//
// 이 영수증은 자기 시계도 선언하지 않았다(`clock=non-empty/undefined`). 그래서 이 원장의
// `...UnixMs` 는 어느 시계의 값인지 답이 없고, 다른 producer 의 시각과 한 축에서 비교될 수
// 없었다. 지금 producer 는 그 이름을 싣는다 — 기록은 그대로 두고 기대만 새 사실로 옮긴다.
import { describe, expect, it } from "vitest";
import recording from "./recorded/presentation-silent-gaps.json";
import { auditPresentationReceipt } from "../presentationLedgerAudit";
import { presentationEventsToCover } from "../presentationLedgerAudit";
import type { PresentationTraceReceipt } from "../presentationLedger";

const receipt = recording.receipt as unknown as PresentationTraceReceipt;

describe("실측 Tauri 표시 원장", () => {
  it("영수증의 자가감사가 기록된 사실과 같다", () => {
    const audit = auditPresentationReceipt(receipt);
    expect({ ok: audit.ok, errors: audit.errors }).toEqual(recording.expectedAudit);
  });

  it("건너뛴 표시를 세지 않은 축은 gaps 하나뿐이다 — 나머지 축은 실제로 0 이었다", () => {
    const audit = auditPresentationReceipt(receipt);
    expect(audit.underReported.map(({ violation }) => violation)).toEqual(["gaps"]);
  });

  it("droppedEvents 135 는 선언한 용량이 궤적이 열려 있던 창을 못 덮은 결과다", () => {
    const { presentationEventCount, declaredMaxEvents, openMs, violations } = recording.wholeLedger;
    // 원장은 정확히 선언한 칸만큼만 실었다 — 넘친 사건은 실체가 없어 되찾지 못한다.
    expect(presentationEventCount).toBe(declaredMaxEvents);
    expect(violations.droppedEvents).toBeGreaterThan(0);
    const refreshIntervalMs = receipt.presentationEvents[0].refreshIntervalMs;
    // 같은 창을 덮으려면 이 주사율에서 선언한 수보다 더 필요했다. 수는 창에서 유도해야 한다.
    expect(presentationEventsToCover({ coverMs: openMs, refreshIntervalMs }))
      .toBeGreaterThan(declaredMaxEvents);
  });
});
