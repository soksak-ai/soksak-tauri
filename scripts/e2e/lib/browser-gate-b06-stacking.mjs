// 무엇이 무엇 위에 칠해지는가 — 공개 stacking 사슬(ui.measure stacking:true)만으로 판정한다.
//
// 옛 판정은 두 노드의 z 를 직접 뺐다: 레일 평면 7 > 포커스 베일 6. 그 뺄셈은 두 수가 같은
// stacking context 에 있다고 전제하는데 실제로는 아니다 — 사이의 .space-plane(z:1)이 자기
// 문맥을 만들어 베일을 가둔다. 레일이 위에 오는 진짜 이유는 7>6 이 아니라 7>1 이고, 누가
// .space-plane 을 8 로 올리면 두 수는 그대로인데 화면에서는 베일이 레일을 덮는다.
//
// 그래서 여기서는 **갈림길**을 찾는다: 두 사슬의 공통 조상까지 내려가서, 처음 갈리는 칸의
// 층으로 가른다. 층이 같으면 문서 순서가 가른다. 사슬을 못 받았거나 한쪽이 다른 쪽의 조상이면
// 이 축은 답하지 않는다 — 못 가름은 null 이지 "같은 층"이 아니다.

/**
 * 같은 문맥 안에서의 칠하는 층.
 *
 * 선언된 z 가 있으면 그 값이다. 없으면 배치된 상자는 0(배치 상자 층), 흐름 안 상자는 그보다
 * 아래(-0.5)다 — 음수 z 는 흐름 안 상자보다도 아래이므로 그 순서가 그대로 성립한다.
 * 배치 여부조차 못 읽었으면 null 이다.
 */
export function layerRank(entry) {
  if (entry == null || typeof entry !== "object") return null;
  if (Number.isFinite(entry.zIndex)) return entry.zIndex;
  if (entry.positioned === true) return 0;
  if (entry.positioned === false) return -0.5;
  return null;
}

function documentOrder(a, b) {
  const left = Array.isArray(a?.order) ? a.order : null;
  const right = Array.isArray(b?.order) ? b.order : null;
  if (!left || !right) return null;
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (!Number.isFinite(left[index]) || !Number.isFinite(right[index])) return null;
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  if (left.length === right.length) return null;
  // 자손은 자기 조상 위에 칠해진다.
  return left.length > right.length ? 1 : -1;
}

function usable(path) {
  return Array.isArray(path)
    && path.length > 0
    && path.every((entry) => typeof entry?.identity === "string" && entry.identity !== "");
}

/** a 가 b 위인가 — 1 은 a 가 위, -1 은 b 가 위, 0 은 같은 노드, null 은 이 축이 못 가름. */
export function comparePaintOrder(a, b) {
  if (!usable(a) || !usable(b)) return null;
  let index = 0;
  while (index < a.length && index < b.length && a[index].identity === b[index].identity) index += 1;
  if (index === a.length && index === b.length) return 0;
  // 한쪽이 다른 쪽의 조상이다 — 배경과 자손의 순서는 이 사슬 축이 답할 것이 아니다.
  if (index === a.length || index === b.length) return null;
  const left = layerRank(a[index]);
  const right = layerRank(b[index]);
  if (left === null || right === null) return null;
  if (left !== right) return left > right ? 1 : -1;
  return documentOrder(a[index], b[index]);
}

/** ui.measure 답에서 사슬만 꺼낸다. 안 실렸으면 null — 빈 배열로 바꾸지 않는다. */
export function stackingPathOf(measure) {
  const path = measure && typeof measure === "object" ? measure.stacking : null;
  return usable(path) ? path : null;
}
