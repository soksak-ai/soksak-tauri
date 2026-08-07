// 무엇이 무엇 위에 칠해지는가 — 그 답은 z 하나가 아니라 **사슬**이다.
//
// 실사고: 레일 평면(z:7)과 포커스 베일(z:6)은 같은 stacking context 에 없다. 사이의
// .space-plane(z:1)이 자기 문맥을 만들어 베일을 그 안에 가둔다. 레일이 위에 오는 진짜 이유는
// 7>6 이 아니라 7>1 이고, 누가 .space-plane 의 z 를 8 로 올리면 두 수는 그대로인데 화면에서는
// 베일이 레일을 덮는다. 두 z 를 직접 빼는 판정은 그 날을 못 본다.
//
// 그래서 이 자리는 **비교하지 않는다.** 칠하는 순서를 정하는 조상 사슬을 값으로 내고, 비교는
// 그 값을 받은 쪽이 한다. 판정이 사슬을 못 받으면 "못 읽음"이지 "같은 층"이 아니다.

/** 문맥 판정에 쓰는 계산된 선언들. CSSStyleDeclaration 의 부분집합이다. */
export interface StackingComputedStyle {
  position: string;
  zIndex: string;
  opacity: string;
  transform: string;
  filter: string;
  backdropFilter: string;
  perspective: string;
  clipPath: string;
  maskImage: string;
  isolation: string;
  mixBlendMode: string;
  willChange: string;
  contain: string;
}

/** 사슬 한 칸 — 이 요소가 자기 부모 문맥 안에서 어디에 서는가. */
export interface StackingPathEntry {
  /** ui.tree 와 같은 불투명 live-Element 토큰. 두 사슬의 공통 조상을 이것으로 찾는다. */
  identity: string;
  /** 공개된 data-node 이름. 진단용이며 판정 축이 아니다. */
  node: string | null;
  /** 선언된 층. auto 는 층을 선언하지 않은 것이므로 0 이 아니라 null 이다. */
  zIndex: number | null;
  /** 배치된 상자인가 — 흐름 안 상자는 같은 문맥의 z:0 배치 상자보다 아래에 칠해진다. */
  positioned: boolean;
  /** 뿌리부터의 자식 순번 사슬. 층이 같은 자리는 문서 순서가 가른다. */
  order: number[];
}

const isNone = (value: string | undefined): boolean => !value || value === "none";

/** 선언된 층. `auto` 는 층을 선언하지 않은 것이므로 숫자가 아니라 null 이다. */
export function declaredLayer(zIndex: string | undefined): number | null {
  if (!zIndex || zIndex === "auto") return null;
  const order = Number.parseInt(zIndex, 10);
  return Number.isFinite(order) ? order : null;
}

/**
 * 이 선언이 자기 stacking context 를 만드는가.
 *
 * 만들면 자손의 z 는 바깥으로 새지 않는다 — 그것이 "가둔다"의 뜻이고, 두 수를 직접 비교하는
 * 판정이 틀리는 이유다.
 */
export function establishesStackingContext(
  style: Partial<StackingComputedStyle>,
  { isRoot = false, parentDisplay = "" }: { isRoot?: boolean; parentDisplay?: string } = {},
): boolean {
  if (isRoot) return true;
  const position = style.position ?? "static";
  const zIndex = style.zIndex ?? "auto";
  if (position === "fixed" || position === "sticky") return true;
  if (position !== "static" && zIndex !== "auto") return true;
  // flex/grid 항목은 배치되지 않아도 z 를 선언하면 문맥을 만든다.
  if (/\b(flex|grid|inline-flex|inline-grid)\b/.test(parentDisplay) && zIndex !== "auto") return true;
  const opacity = Number.parseFloat(style.opacity ?? "1");
  if (Number.isFinite(opacity) && opacity < 1) return true;
  for (const value of [
    style.transform,
    style.filter,
    style.backdropFilter,
    style.perspective,
    style.clipPath,
    style.maskImage,
  ]) {
    if (!isNone(value)) return true;
  }
  if (style.isolation === "isolate") return true;
  if (style.mixBlendMode && style.mixBlendMode !== "normal") return true;
  if (/opacity|transform|filter|perspective|isolation|z-index/.test(style.willChange ?? "")) return true;
  if (/\b(paint|layout|strict|content)\b/.test(style.contain ?? "")) return true;
  return false;
}

/**
 * 이 요소가 칠해지는 순서를 정하는 조상 사슬 — 뿌리부터 자기 자신까지.
 *
 * 싣는 칸은 셋이다: 문맥을 만드는 조상(자손을 가둔다), 배치된 조상(같은 문맥 안에서 순서를
 * 가진다), 그리고 자기 자신. 나머지 조상은 순서를 바꾸지 않으므로 싣지 않는다.
 */
export function stackingPathOf(
  el: Element,
  {
    getStyle,
    identify,
  }: {
    getStyle: (node: Element) => Partial<StackingComputedStyle> & { display?: string };
    identify: (node: Element) => string;
  },
): StackingPathEntry[] {
  const chain: Element[] = [];
  for (let cursor: Element | null = el; cursor; cursor = cursor.parentElement) chain.push(cursor);
  chain.reverse();

  const order: number[] = [];
  const path: StackingPathEntry[] = [];
  for (const cursor of chain) {
    const parent = cursor.parentElement;
    order.push(parent ? Array.prototype.indexOf.call(parent.children, cursor) : 0);
    const style = getStyle(cursor);
    const positioned = (style.position ?? "static") !== "static";
    const establishes = establishesStackingContext(style, {
      isRoot: parent === null,
      parentDisplay: parent ? (getStyle(parent).display ?? "") : "",
    });
    if (cursor !== el && !positioned && !establishes) continue;
    path.push({
      identity: identify(cursor),
      node: (cursor as HTMLElement).dataset?.node ?? null,
      zIndex: declaredLayer(style.zIndex),
      positioned,
      order: [...order],
    });
  }
  return path;
}
