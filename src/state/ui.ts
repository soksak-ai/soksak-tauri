import { useEffect } from "react";
import { moduleState } from "../lib/moduleState";
import { create } from "zustand";

// 일시적 UI 상태. overlayCount: DOM 오버레이(모달/메뉴/드롭다운/드래그)가 떠 있는
// 동안의 카운터(중첩 안전).
//
// **여기서 프레임워크를 부르지 않는다.** 오버레이가 떠 있는 동안 아래 표면의 마우스를
// 막아야 하는 것은 콘텐츠가 문서 밖인 프레임워크의 사정이다 — 문서 안에 사는 콘텐츠는
// 평범한 쌓임으로 이미 막힌다. 그 반응은 그 프레임워크가 이 카운터를 구독해서 건다
// (framework/tauri/install.ts). 코어는 사실만 들고 있는다.
//
// 모듈 평가 중에 프레임워크를 부르면 적재 순서에 매인다 — 실측 2026-08-03: 이 파일이
// 모듈 최상위에서 invoke 를 불러, 순환 적재에서 "invoke is not a function" 으로 부팅과
// 검사 13벌이 통째로 죽었다. 부팅 정렬도 거는 쪽(install)이 함께 진다.
// (배경/색은 테마 스토어 state/theme.ts 가 단일 소스.)

interface UiState {
  overlayCount: number;
  pushOverlay: () => void;
  popOverlay: () => void;
  // 동의 모달 미리보기(plugin.consent.preview command) — 설정/검사용으로 띄울 플러그인 id. null=닫힘.
  // App 레벨에서 렌더(사이드바 마운트 여부 무관). 활성화는 안 함(검사 전용).
  consentPreviewId: string | null;
  setConsentPreview: (id: string | null) => void;
  // 설정 모달 — null=닫힘, "general"=환경설정, 그 외=플러그인 id(딥링크). 사이드바 "설정" 바로가기 채널.
  settingsSection: string | null;
  setSettingsSection: (s: string | null) => void;
}

// store 는 모듈 경계 밖에 산다 — 갈아끼우기가 이것을 갈면 등록·구독·화면 상태가 통째로
// 새것이 되고, 채우던 쪽은 이미 채웠다고 알아 다시 채우지 않는다(영영 빈 채).
export const useUi = moduleState("state/ui#store", () =>
  create<UiState>((set) => ({
  overlayCount: 0,
  consentPreviewId: null,
  setConsentPreview: (id) => set({ consentPreviewId: id }),
  settingsSection: null,
  setSettingsSection: (s) => set({ settingsSection: s }),
  pushOverlay: () => set((s) => ({ overlayCount: s.overlayCount + 1 })),
  popOverlay: () => set((s) => ({ overlayCount: Math.max(0, s.overlayCount - 1) })),
})),
);

// 마운트 동안(active 가 true 인 동안) 오버레이로 등록한다 — 모든 모달/메뉴/
// 드롭다운은 반드시 이 훅을 사용한다(표시 제어가 아니라 입력 게이트다).
export function useOverlayActive(active = true): void {
  const push = useUi((s) => s.pushOverlay);
  const pop = useUi((s) => s.popOverlay);
  useEffect(() => {
    if (!active) return;
    push();
    return () => pop();
  }, [active, push, pop]);
}
