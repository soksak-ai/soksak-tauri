// 마우스가 올라간 골(pane 사이 리사이즈 경계). 네이티브 child(브라우저 등)는 OS 뷰라 그 위에서
// DOM :hover 가 발동하지 않는다 — 코어 네이티브-마우스 브릿지(App.tsx)가 hover 좌표의 골을 여기
// 세팅하고, GroupArea 가 구독해 그 골을 강조 + 좌우 칸을 잠깐 물려(seam) 네이티브 밑에서 골을
// 드러낸다. flat 테마(pane-inset 0)에서도 "마우스 올릴 때만" 경계가 보이게 하는 단일 진실. key 없으면 null.
//
// 파일명과 useGutterHover 라는 이름만 옛 낱말로 남아 있다. 이 심볼은 명령 층(catalogDom)이
// 소비하므로 개명이 두 레인을 동시에 건드린다 — 명령 표면 레인이 그 import 한 줄과 함께 옮긴다.
// 그때 파일도 gutterHover.ts 가 된다. 담고 있는 값은 이미 정본 골 주소다(아래 key 주석).
import { moduleState } from "../lib/moduleState";
import { create } from "zustand";

interface GutterHoverState {
  key: string | null; // 정본 골 주소 `gutter/<pan-id>/<right|bottom>`. 없으면 null.
  set: (key: string | null) => void;
}

// store 는 모듈 경계 밖에 산다 — 갈아끼우기가 이것을 갈면 등록·구독·화면 상태가 통째로
// 새것이 되고, 채우던 쪽은 이미 채웠다고 알아 다시 채우지 않는다(영영 빈 채).
export const useGutterHover = moduleState("state/gutterHover#store", () =>
  create<GutterHoverState>((set) => ({
  key: null,
  // 같은 값이면 상태 객체를 바꾸지 않는다 — hover 이동(대부분 gutter 아님=null)마다 불필요한 리렌더 방지.
  set: (key) => set((s) => (s.key === key ? s : { key })),
})),
);
