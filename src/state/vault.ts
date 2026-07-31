// 복구코드 UI 흐름의 휘발 상태 — 셋업/입력 모달 라우팅 + 1회성 복구코드. 복구코드는 절대 디스크에 안 남는다
// (persist 금지) — enable/rotate/changeRecovery 가 1회 반환한 값을 셋업 모달이 보여줄 동안만 메모리에 쥔다.
// 모달 열림/닫힘은 nullable 필드로 표현(closeConfirm 패턴) — 별도 boolean·조건부 마운트 없다.
import { moduleState } from "../lib/moduleState";
import { create } from "zustand";

export type RecoveryOrigin = "setup" | "rotate" | "changeRecovery";

export interface PendingRecovery {
  code: string;
  origin: RecoveryOrigin;
}

interface VaultUiState {
  openModal: "setup" | "enter" | null; // null = 닫힘(게이트)
  pendingCode: PendingRecovery | null; // 셋업 모달이 1회 표시할 복구코드
  targetScope: string; // 입력 모달이 복구할 scope
  showSetup: (code: string, origin: RecoveryOrigin) => void;
  showEnter: (scope: string) => void;
  close: () => void;
}

// store 는 모듈 경계 밖에 산다 — 갈아끼우기가 이것을 갈면 등록·구독·화면 상태가 통째로
// 새것이 되고, 채우던 쪽은 이미 채웠다고 알아 다시 채우지 않는다(영영 빈 채).
export const useVault = moduleState("state/vault#store", () =>
  create<VaultUiState>((set) => ({
  openModal: null,
  pendingCode: null,
  targetScope: "",
  showSetup: (code, origin) => set({ openModal: "setup", pendingCode: { code, origin } }),
  showEnter: (scope) => set({ openModal: "enter", targetScope: scope }),
  // 닫으면 휘발 복구코드도 즉시 비운다(메모리 외 잔존 0).
  close: () => set({ openModal: null, pendingCode: null }),
})),
);
