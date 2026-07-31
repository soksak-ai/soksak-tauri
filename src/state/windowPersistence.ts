// 워크스페이스 영속·복원 배선(A4/A5) — sessions 스토어 ↔ coreStore(app.data) ↔ 직렬화.
//
// 키 모델(core ns):
//  - "window/<label>"  : 한 창의 워크스페이스 스냅샷(projects[] + activeId). 창 단위 원자 저장.
//  - "windows"         : window-manifest(slot → {label, roots[], activeRoot}). 재시작 복원 골격.
//
// [RULE] 레이아웃은 창-로컬(window label 키). 같은 root 를 두 창에 띄우면 각자 키라 충돌 없음 —
// 현재는 프로젝트 유니크 가드가 상위에서 막지만, 키 모델 자체는 멀티창을 이미 지원한다(A 결정).
// live status/PTY/webview 세션은 직렬화하지 않는다(windowSnapshot 이 제외).

import {
  serializeProject,
  deserializeProject,
  type ProjectSnapshot,
} from "./windowSnapshot";
import type { Project } from "./sessions";
import type { Pins } from "./projection";

export type ProjectionSeed = { pins: Pins };

export interface WindowSnapshot {
  activeId: string;
  projects: ProjectSnapshot[];
}

export interface ManifestEntry {
  label: string;
  roots: string[];
  activeRoot: string | null;
  // 창 프레임(논리 px) — 재시작 리스폰이 같은 자리·크기로 창을 만든다(듀얼 모니터 배치 유지).
  rect?: { x: number; y: number; w: number; h: number };
}

export interface WindowManifest {
  slots: ManifestEntry[];
  // 마지막 포커스 창 — 재시작 후 그 창을 앞으로(없으면 main 이 무조건 앞이라 어색).
  focusedLabel?: string;
}

// 창의 현재 sessions 상태 → 직렬화 스냅샷(창 단위).
export function snapshotWindow(
  projects: Project[],
  activeId: string,
  projections?: Record<string, ProjectionSeed>,
): WindowSnapshot {
  return {
    activeId,
    projects: projects.map((p) => serializeProject(p, projections?.[p.id])),
  };
}

// 스냅샷 → Project[] (split id 재생성은 newSplitId 주입). 복원 후 호출부가 reseed.
export function restoreWindow(
  snap: WindowSnapshot,
  newSplitId: () => string,
): {
  projects: Project[];
  activeId: string;
  projections: Record<string, ProjectionSeed>;
} {
  const projects = snap.projects.map((p) => deserializeProject(p, newSplitId));
  const activeId = projects.some((t) => t.id === snap.activeId)
    ? snap.activeId
    : (projects[0]?.id ?? "");
  const projections: Record<string, ProjectionSeed> = {};
  for (const p of snap.projects) {
    if (p.projection) projections[p.id] = p.projection;
  }
  return { projects, activeId, projections };
}

// 이 창의 manifest 항목 = label + 보유 root 목록 + 활성 root.
export function windowManifestEntry(
  label: string,
  projects: Project[],
  activeId: string,
): ManifestEntry {
  return {
    label,
    roots: projects.map((t) => t.root),
    activeRoot: projects.find((t) => t.id === activeId)?.root ?? null,
  };
}

// manifest 에 이 창 항목을 upsert(같은 label slot 교체, 없으면 추가). 빈 roots 면 slot 제거.
export function upsertManifest(
  manifest: WindowManifest,
  entry: ManifestEntry,
): WindowManifest {
  const others = manifest.slots.filter((s) => s.label !== entry.label);
  if (entry.roots.length === 0) return { ...manifest, slots: others };
  return { ...manifest, slots: [...others, entry] };
}

/**
 * 닫은 창을 장부에서 지운다 — 남으면 다음 부팅이 되살린다.
 *
 * 앱 종료와 다르다. 종료도 창을 전부 닫지만 장부는 남아야 한다(다음 실행에 아무것도 안 열린다).
 * 그래서 이 함수를 부르는 자리는 종료 경로가 아니라 **닫으라는 명령**이다.
 *
 * 마지막 포커스 기록도 함께 지운다. 없는 창을 가리키는 포커스는 다음 부팅이 찾다가 못 찾는다.
 */
export function forgetWindow(manifest: WindowManifest, label: string): WindowManifest {
  const slots = manifest.slots.filter((s) => s.label !== label);
  if (slots.length === manifest.slots.length && manifest.focusedLabel !== label) return manifest;
  const next: WindowManifest = { ...manifest, slots };
  if (next.focusedLabel === label) delete next.focusedLabel;
  return next;
}

/**
 * 배치 축 키에 프레임워크를 싣는다 — **단일 값**용.
 *
 * 여기 실리는 것은 사용자 자산이 아니라 **자기 창의 자리**다(main 창의 위치·크기). 공유하면
 * 두 프레임워크의 컨트롤 플레인이 같은 자리에 겹쳐 뜬다. 장부(`windows`)와 다른 축이다 —
 * 장부는 사용자 의도라 갈리면 손실이 되지만, 자기 창 자리는 갈려야 각자 제 자리를 지킨다.
 *
 * 축을 못 읽었으면 옛 키 그대로다. 모르는 이름으로 새 키를 만들면 아무도 안 읽는 자리에 값이
 * 쌓인다 — 그건 저장한 것도 안 한 것도 아니다.
 */
export function frameworkScopedKey(base: string, framework: string | null): string {
  return framework ? `${base}/${framework}` : base;
}

/**
 * 되살릴 slot — 장부에 있고 **지금 아무도 안 든** 창.
 *
 * 장부는 사용자 의도다("이 워크스페이스가 열려 있어야 한다"). 거기에 띄운 쪽의 이름을 적으면
 * 그 창은 그 프레임워크의 소유가 되고, 프레임워크를 바꾼 사용자는 자기 창을 전부 잃는다.
 * 그래서 가르는 축은 소유가 아니라 **점유**다 — 런타임 사실이라 장부에 안 적히고, 프로세스가
 * 죽으면 저절로 풀린다(저장소 소유 A22 와 같은 모델).
 *
 * `live` 는 **모든 호스트**가 든 라벨이어야 한다. 자기 프로세스만 세면 상대가 든 창을 "없다"고
 * 읽고 같은 라벨을 또 만든다 — 그 겹침이 아무것도 그리지 않는 창을 남긴다(cored `window_census`).
 *
 * 점유를 못 읽었으면(`null`) 되살리지 않는다. 안 여는 것은 다음 부팅에 회복되지만, 겹쳐 만든
 * 창은 그대로 남는다 — 두 실패의 무게가 다르다.
 */
export function restorableSlots(
  manifest: WindowManifest,
  live: ReadonlySet<string> | null,
): ManifestEntry[] {
  if (!live) return [];
  return manifest.slots.filter((s) => s.label !== "main" && !live.has(s.label));
}

// 마지막 포커스 창 기록 — persist 시 이 창이 포커스면 호출(최상위 필드라 slot upsert 와 독립).
export function setManifestFocused(
  manifest: WindowManifest,
  label: string,
): WindowManifest {
  return { ...manifest, focusedLabel: label };
}
