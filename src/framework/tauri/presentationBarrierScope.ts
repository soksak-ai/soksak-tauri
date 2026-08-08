// 표시 확인이 **무엇에게** 묻는가.
//
// 표면마다 화면 도달을 묻고 그 한 번이 100ms 다(실측 2026-08-09). 활성 탭이 하나인데 네 표면에
// 물었고, 그중 하나는 탭 목록에 없는 표면이었다 — 사라진 것을 계속 기다리고 있었다.
//
// 지금 화면에 무엇이 있는가는 **문서의 선언**이 안다. 뷰가 자기 기억으로만 답하면 그 기억이 낡은
// 날 배리어가 유령을 기다린다.

/** 이 배리어가 물어볼 표면 — 보이는 뷰의 것이면서 문서가 지금 선언하고 있는 것만. */
export function presentationBarrierLabels(
  views: readonly { renderer: string; members: Iterable<string>; visible: boolean }[],
  declared: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const view of views) {
    if (!view.visible) continue;
    for (const label of [view.renderer, ...view.members]) {
      if (!declared.has(label) || seen.has(label)) continue;
      seen.add(label);
      out.push(label);
    }
  }
  return out;
}
