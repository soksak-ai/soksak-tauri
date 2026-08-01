// 사용자 자산을 덮어쓰기 전에 **직전 값을 남긴다** — 덮어쓰기가 일어나도 되돌릴 수 있게.
//
// 워크스페이스 스냅샷은 `DO UPDATE` 로 저장된다: 쓰는 순간 이전 값이 사라진다. 백업 링은
// 최소 간격이 1시간이라 그 사이는 어디에도 없다. 실측(2026-08-01) 그 구멍에서 사용자
// 워크스페이스가 사라졌고, 1시간 전 백업으로만 되살렸다.
//
// 원인을 다 막을 수는 없다(크래시·강제종료·앞으로 생길 버그). 그러니 **잃어도 되돌릴 수
// 있어야** 한다. 다만 모든 저장마다 세대를 남기면 400ms 전 값만 남아 쓸모가 없다 — 남길
// 가치가 있는 것은 **줄어드는 쓰기** 하나다.

/** 이 함수가 세는 것 — 스냅샷의 모양을 다시 적지 않는다(있으면 센다).
 *
 *  느슨한 상한이다: 여기서 실제 타입을 적으면 그것이 스냅샷 모양의 두 번째 선언이 된다. */
export type WindowSnapshotLike = { projects?: readonly unknown[] } | null;
type SnapshotLike = WindowSnapshotLike;

/** 배치 트리의 탭 수 — **저장 모양**을 읽는다(`{t:"l",v:{views}}` / `{t:"s",children}`).
 *
 *  런타임 모양(`type:"leaf"` · `tabs`)과 다르다. 그 차이를 모르고 런타임 모양을 세다가 이
 *  함수가 늘 0 을 답했고, 테스트도 런타임 모양으로 쓰여 있어 GREEN 이었다 — e2e 가 잡았다
 *  (실측 2026-08-01). 모양을 모르는 노드는 0 으로 지나간다. */
function tabsIn(node: unknown): number {
  if (!node || typeof node !== "object") return 0;
  const n = node as { t?: string; v?: { views?: unknown[] }; children?: unknown[] };
  if (n.t === "l") return Array.isArray(n.v?.views) ? n.v.views.length : 0;
  if (!Array.isArray(n.children)) return 0;
  return n.children.reduce<number>((sum, c) => sum + tabsIn(c), 0);
}

function contentSize(s: SnapshotLike): { projects: number; spaces: number; tabs: number } {
  // 저장 모양에서 스페이스는 `contents` 다(런타임의 `spaces` 가 아니다).
  const projects = (s?.projects ?? []) as readonly { contents?: readonly { layout?: unknown }[] }[];
  let spaces = 0;
  let tabs = 0;
  for (const p of projects) {
    const list = p.contents ?? [];
    spaces += list.length;
    for (const sp of list) tabs += tabsIn(sp.layout);
  }
  return { projects: projects.length, spaces, tabs };
}

/**
 * 이 쓰기가 **내용을 잃는가** — 프로젝트나 탭이 줄어드는가.
 *
 * 늘거나 그대로인 쓰기는 되돌릴 이유가 없다(세대를 남기면 오히려 직전 값이 그 쓰기로 밀린다).
 * 사용자가 스스로 닫은 것도 잃는 쓰기다 — 실수로 닫았을 수 있고, 그때 되돌릴 자리가 있어야 한다.
 */
export function losesContent(prev: SnapshotLike, next: SnapshotLike): boolean {
  if (!prev) return false;
  const a = contentSize(prev);
  const b = contentSize(next);
  // 스페이스도 사용자 자산이다 — 빈 스페이스를 닫는 것도 잃는 쓰기다(탭만 세면 안 잡힌다,
  // e2e RED 2026-08-01).
  return b.projects < a.projects || b.spaces < a.spaces || b.tabs < a.tabs;
}

/** 그 스냅샷이 담은 크기 — 되돌리기 전에 무엇이 들어오는지 사람이 본다. */
export function snapshotSize(s: SnapshotLike): { projects: number; spaces: number; tabs: number } {
  return contentSize(s);
}

/** 직전 세대가 사는 키 — 스냅샷 키에서 파생한다(자리를 손으로 적지 않는다). */
export function previousGenerationKey(snapshotKey: string): string {
  return `${snapshotKey}#prev`;
}
