// 부트 위상 상태면 — "빈칸"과 "곧 채워질 자리"를 구분하는 단일 사실(사용자 확정 2026-07-27:
// 뭐가 뜰 건지 아니면 그냥 빈칸인지 알아야 착각을 안 한다).
//
// 복원이 플러그인 호스트보다 먼저 서는 부트(복원 300ms 기준)에서는 화면이 즉시 뜨고
// 뷰 본문이 뒤따라 채워진다 — 그 사이 미등록 뷰를 "뷰 없음"으로 그리면 거짓말이다.
// 위상은 부트가 굴리고(restoring → activating → ready), 소비자는 읽기만 한다:
//   · PluginViewHost — ready 전 미등록 = 불러오는 중, ready 후 미등록 = 진짜 부재.
//   · BootPhaseBadge — ready 전 창 구석의 은은한 진행 표시.
// 초기값은 ready — 부트 계약 밖 진입점(테스트·오케스트레이터)은 위상 없이 현행 그대로다.
import { create } from "zustand";

export type BootPhase = "restoring" | "activating" | "ready";

interface BootPhaseState {
  phase: BootPhase;
  setPhase: (phase: BootPhase) => void;
}

export const useBootPhase = create<BootPhaseState>((set) => ({
  phase: "ready",
  setPhase: (phase) => set({ phase }),
}));
