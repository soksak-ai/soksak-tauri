// 스냅샷이 담은 크기 — 되돌리기 전에 무엇이 들어오는지 사람이 본다.
//
// 되돌릴 자리를 남기는 일 자체는 **저장소가 한다**(kv_past — 모든 쓰기에 대해 조건 없이).
// 한때 여기서 "잃는 쓰기"만 골라 사본을 따로 뒀는데, 그 규칙이 못 잡는 쓰기는 되돌릴 자리가
// 없었고, 같은 사실이 두 자리에 있어 한쪽만 갱신되면 엉뚱한 값이 돌아왔다. 남은 것은 크기를
// 세는 일 하나다.

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

/** 그 스냅샷이 담은 크기 — 되돌리기 전에 무엇이 들어오는지 사람이 본다. */
export function snapshotSize(s: SnapshotLike): { projects: number; spaces: number; tabs: number } {
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
