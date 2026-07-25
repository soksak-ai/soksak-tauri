// 코어 소유 이동-동결(§4.6 시행) — move 위상 동안 홀-슬롯의 네이티브 표면을 DOM 스탠드인으로
// 대체한다. 근거(실측): 샘플링 추종은 컴포지터 활강을 못 탄다 — DOM 은 매 vsync 보간되고
// 표면은 샘플 도착 프레임에만 움직이며, 활강 중 메인 스레드가 바빠 스터터가 남는다. 활강
// 동안 표면이 DOM(스탠드인)이면 기하 일치는 정의상 성립한다.
//
// 소유권: 재료 전부가 코어 것이다 — 홀-슬롯(transparent 선언의 DOM 표식), 모션 위상(kind 축),
// 캡처(webview-capture), 슬롯 DOM. 표면 가시성만 소유자가 다르므로 view.veiled 이벤트로
// 릴레이한다(view.parked 와 동형 — 사이드카 표면 플러그인의 유일한 의무).
//
// 불변 계약(§4.6):
//  - move 만, resize 는 절대 금지(변하는 크기 밑 정지 사진 = 콘텐츠 박제).
//  - 선캡처·선디코드(정착 에지) — 동결 순간 디코드 지연 0.
//  - 페인트 먼저, 숨김 나중 — 스탠드인 페인트가 커밋된 뒤(이중 rAF) veil(true).
//  - 스냅 부재·낡음·크기 드리프트는 폴백 = 라이브 추종(동결 없음).
//  - bounds 커밋은 이 계층과 무관하게 계속 흐른다(동결은 표현이지 정책이 아니다).
import { HOLE_SLOT_SELECTOR } from "./railHoleClip";
import { surfaceRectOf } from "./surfaceRect";

interface SlotSnap {
  img: HTMLImageElement;
  t: number;
  w: number;
  h: number;
}

export interface SlotFreezeDeps {
  /** 슬롯 탐색 루트(보통 document). null 이면 그 시점 동작은 no-op. */
  root: () => ParentNode | null;
  /** 창 좌표 rect(CSS px)를 PNG data URL 로 캡처한다. */
  capture: (rect: { x: number; y: number; w: number; h: number }) => Promise<string>;
  /**
   * 표면 릴레이 — view.veiled { viewId, veiled, hidden } 발화(표면 소유자가 소비).
   * veiled = 따라가지 마라(위상 중 쓰기 금지). hidden = 지금 감춰라.
   * 둘은 다른 에지다: 추종 정지는 위상 시작 즉시, 감춤은 스탠드인 페인트가 커밋된 뒤(§5-2).
   */
  emitVeil: (viewId: string, veiled: boolean, hidden: boolean) => void;
  /** 착지 쓰기가 오지 않을 때 스탠드인을 걷는 상한(ms). 기본 400 — 340ms 주행보다 길다. */
  landingTimeoutMs?: number;
  /** 정착 스냅 신선도 상한(ms). 기본 120초. */
  maxSnapAgeMs?: number;
  /** 테스트 주입 — 기본 performance.now. */
  now?: () => number;
  /** 테스트 주입 — 기본 new Image() 동등의 <img> 생성. */
  imageFactory?: () => HTMLImageElement;
}

export interface SlotFreeze {
  /** 정착 에지에서 호출 — 가시 홀-슬롯 전체를 선캡처하고 즉시 디코드까지 끝내 둔다. */
  captureSettled(): void;
  /**
   * 이 뷰들 중 홀 표면인 것을 전부 스탠드인으로 덮을 수 있는가. 활강의 전제다 —
   * 스탠드인 없는 홀이 하나라도 끼면 그 표면은 위상 내내 샘플링 추종으로 끌려다니고,
   * 그 스터터가 애초의 불만이었다. 덮을 수 없으면 활강하지 않고 스냅하는 것이 낫다.
   */
  canFreezeAll(viewIds: readonly string[]): boolean;
  /** 내용이 바뀐 뷰의 스냅을 버린다(항행 등) — 낡은 프레임을 세우지 않기 위한 유일한 축. */
  invalidate(viewId: string): void;
  /**
   * 표면 소유자가 실제로 착지 좌표를 쓴 사실. 코어가 자기 쓰기 경로(webview.bounds)에서
   * 관측한다 — 스탠드인은 이 사실 위에서 물러난다(시간 추측 금지).
   */
  noteSurfaceWrite(viewId: string): void;
  /** 모션 신호 수신부 — onLayoutMotion (active, kinds, scope) 를 그대로 넘긴다.
   *  scope: 이 위상이 움직이는 viewId 집합(null=전역). 범위 밖 슬롯은 동결하지 않는다 —
   *  관련 없는 표면이 남의 스왑에 베일 펄스를 맞지 않는다(라이브 유지). */
  onMotion(active: boolean, kinds: string[], scope?: Set<string> | null): void;
  /** 스탠드인·상태 회수(테스트·종료). 표면 가시성은 veil(false)로 이미 복귀된 상태여야 한다. */
  dispose(): void;
}

// 슬롯의 view 귀속 — 슬롯이 공개하는 노드 주소(data-node="layout/slot/<viewId>")가 원천이다.
function viewIdOf(slot: HTMLElement): string | null {
  const node = slot.getAttribute("data-node");
  const prefix = "layout/slot/";
  if (!node || !node.startsWith(prefix)) return null;
  const id = node.slice(prefix.length);
  return id.length > 0 ? id : null;
}

/**
 * 화면 밖(파킹) 슬롯인가. 비활성 탭의 뷰는 코어가 화면 밖으로 옮겨 둔다(layerPark) — 그 표면은
 * 보이지 않으므로 덮을 것도, 옛 자리를 드러낼 일도 없다. 세 곳이 같은 기준을 봐야 한다:
 *  - 캡처: 그 rect 의 창 픽셀은 남의 것이다.
 *  - 활강 전제: 보이지 않는 뷰의 스냅이 없다고 여정 전체를 스냅으로 떨어뜨리면, 브라우저 탭이
 *    둘 이상인 패널은 영원히 활강하지 못한다.
 *  - 동결: 파킹된 슬롯을 동결하면 해동 에지에 veil(false) 가 가고, 표면 소유자는 그 신호에
 *    좌표를 쓰고 다시 보이게 한다 — 비활성 탭이 여정마다 번쩍인다(실측 깜빡임).
 */
function parkedSlot(r: {
  left: number;
  top: number;
  right: number;
  bottom: number;
}): boolean {
  if (typeof window === "undefined") return false;
  return (
    r.right <= 0 || r.bottom <= 0 || r.left >= window.innerWidth || r.top >= window.innerHeight
  );
}

/** 부동소수 잔재를 CSS 에 흘리지 않는다(0.7999999999999545px) — 0.01px 격자면 충분하다. */
const cssPx = (n: number): string => `${Math.round(n * 100) / 100}px`;

function holeSlots(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(HOLE_SLOT_SELECTOR));
}

export function createSlotFreeze(deps: SlotFreezeDeps): SlotFreeze {
  const landingTimeout = deps.landingTimeoutMs ?? 400;
  // 낡은 스냅은 세우지 않는다(§5-3, 사용자 확정 규칙). 항행 무효화만으로는 부족하다 — 영상·피드·
  // SPA 는 항행 없이 내용이 바뀌므로 나이가 유일한 방어다. 낡아서 못 세우면 활강 자체를 포기하고
  // 스냅한다(canFreezeAll → 활강 전제) — 샘플링 추종으로 끌려가지 않으므로 폴백이 안전하다.
  const maxAge = deps.maxSnapAgeMs ?? 120_000;
  const fresh = (snap: SlotSnap): boolean => now() - snap.t <= maxAge;
  const now = deps.now ?? (() => performance.now());
  const makeImage = deps.imageFactory ?? (() => document.createElement("img"));
  const snaps = new WeakMap<HTMLElement, SlotSnap>();
  const inFlight = new WeakSet<HTMLElement>();
  const frozen = new Map<HTMLElement, { img: HTMLImageElement; viewId: string }>();
  // viewId → 그 뷰의 홀 슬롯(스냅 조회·무효화용). 슬롯 엘리먼트는 뷰가 살아 있는 동안 안정적이다.
  const byView = new Map<string, HTMLElement>();
  // 해동 뒤 착지 쓰기를 기다리는 스탠드인 — 소유자가 실제로 쓰면 그 프레임에 걷는다.
  const awaiting = new Map<string, { img: HTMLImageElement; timer: number }>();

  const captureSettled = (): void => {
    const root = deps.root();
    if (!root) return;
    for (const slot of holeSlots(root)) {
      const viewId = viewIdOf(slot);
      if (!viewId) continue;
      if (inFlight.has(slot) || frozen.has(slot)) continue;
      // 표면이 실제로 서 있는 정수 rect 를 캡처한다 — 슬롯의 분수 rect 를 캡처하면 표면 픽셀에
      // 이웃 픽셀이 섞이고, 그 사진을 되돌려 놓을 자리도 없다(§4.6, surfaceRect 규칙).
      const rect = slot.getBoundingClientRect();
      const { x, y, w, h } = surfaceRectOf(rect);
      if (w < 2 || h < 2) continue;
      // 포커스 장식 박제 금지 — dim 이 걸린(스팟 아닌) 슬롯의 창 픽셀엔 셰이드 베일이 구워져
      // 있다. 그걸 스탠드인으로 쓰면 동결 중 라이브 dim 과 어긋나 "포커스 인/아웃" 플랩으로
      // 보인다(실측). 청정(스팟) 상태의 스냅만 굽고, dim 은 라이브 계층(::after·filter)이 얹는다.
      if (slot.closest("[data-focus-dim]") && !slot.classList.contains("spot-clear")) continue;
      if (parkedSlot(rect)) continue;
      inFlight.add(slot);
      void deps
        .capture({ x, y, w, h })
        .then(async (url) => {
          // 여기서 미리 디코드까지 끝내 둔다 — 동결 순간의 디코드 지연(1~2프레임)이 "표면
          // 숨김이 스탠드인 페인트보다 먼저 착지 → 배경 번쩍"의 재료였다(실측).
          const img = makeImage();
          img.src = url;
          await img.decode();
          snaps.set(slot, { img, t: now(), w, h });
          byView.set(viewId, slot);
          slot.dataset.freezeSnapAt = String(Math.round(now())); // 관측면(ui.hit)
        })
        .catch(() => {})
        .finally(() => {
          inFlight.delete(slot);
        });
    }
  };

  const freezeSlot = (slot: HTMLElement): void => {
    if (frozen.has(slot)) return;
    const viewId = viewIdOf(slot);
    if (!viewId) return;
    const snap = snaps.get(slot);
    if (!snap || !fresh(snap)) return;
    const r = slot.getBoundingClientRect();
    if (parkedSlot(r)) return; // 보이지 않는 표면 — 덮을 것도, 해동에 되살릴 것도 없다
    const surface = surfaceRectOf(r);
    // 스냅 이후 표면 크기가 변했으면 세우지 않는다 — 늘어난 정지 사진은 박제다. 판정도 표면
    // 규칙으로 한다(분수 슬롯 폭과 정수 스냅 폭을 섞어 재면 언제나 1px 어긋난 값이 나온다).
    if (Math.abs(surface.w - snap.w) > 1 || Math.abs(surface.h - snap.h) > 1) return;
    const img = snap.img; // 정착 에지에서 디코드 완료 — append 즉시 페인트
    img.className = "slot-freeze-frame";
    // 관측 주소 — "스탠드인이 유일한 홀을 완전히 덮는다"가 표면 무숨김(§4.6-3)의 load-bearing
    // 가정이다. 히트테스트로는 확인할 수 없으므로(pointer-events:none) 주소를 주어 rect 를
    // 직접 재게 한다. 이 가정이 깨지면 활강 내내 표면이 스탠드인 위로 드러난다.
    img.dataset.node = `layout/standin/${viewId}`;
    // 표면이 서 있던 그 자리에, 캡처한 그 크기로 — 1:1. 슬롯에 꽉 채우면(inset:0 + 100%)
    // 분수 슬롯에서 사진이 늘어나고(리샘플) 표면이 없던 자리로 올라간다: 실측 상단 0.8px,
    // 하단 2.6px 밀림이 동결 에지와 착지 에지에 각각 한 번씩 보인다. 캡처 픽셀은 늘리지 않고
    // 온 자리에 그대로 되돌려 놓는다.
    img.style.cssText =
      `position:absolute;left:${cssPx(surface.x - r.left)};top:${cssPx(surface.y - r.top)};` +
      `width:${snap.w}px;height:${snap.h}px;pointer-events:none;z-index:3;`;
    slot.appendChild(img);
    frozen.set(slot, { img, viewId });
    slot.dataset.freeze = "1"; // 관측면(ui.hit)
    // veil = "스탠드인이 섰다: 표면을 감추고, 따라가지 말고, 해동 에지에 정확히 한 번 착지하라."
    //
    // 숨김이 필요한 이유(실측): 활강 중 표면은 제자리에 머무는데 슬롯과 스탠드인은 미끄러진다.
    // DOM 이 그 옛 자리를 전부 덮어 준다는 보장이 없다 — 레일 홀 클립은 매 프레임 슬롯의
    // 애니 rect 로 갱신되므로, 표면이 남아 있는 자리에 칠하지 않는 창이 열린다. 녹화 프레임에서
    // 페이지가 둘로 보였다(미끄러지는 스탠드인 + 레일 안쪽에 삐져나온 표면 띠).
    //
    // 숨김이 깜빡이지 않으려면 순서가 계약이다(§5-2): 스탠드인 페인트가 **커밋된 뒤** 숨긴다.
    // 반대 순서는 투명 홀이 1~2프레임 배경을 노출한다("사라졌다 나타난다"). 스냅은 정착 에지에
    // 이미 디코드돼 있으므로(§5-3) append 즉시 페인트되고, 이중 rAF 뒤면 그 페인트는 커밋됐다.
    // ① 즉시: 따라가지 마라. 늦추면 그 사이 추종 루프가 최종 좌표로 한 번 써서 표면이 t0 에
    //    목적지로 텔레포트한다(계수 게이트가 잡는다).
    deps.emitVeil(viewId, true, false);
    // ② 페인트 커밋 뒤: 감춰라. 반대 순서는 투명 홀이 1~2프레임 배경을 노출한다.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (frozen.get(slot)?.img !== img) return; // 그새 해동됨 — 감추지 않는다
        deps.emitVeil(viewId, true, true);
      }),
    );
  };

  /** 스탠드인 철수 — 착지가 확정된 뒤에만. 남은 타이머는 정리한다. */
  const withdraw = (viewId: string): void => {
    const pending = awaiting.get(viewId);
    if (!pending) return;
    awaiting.delete(viewId);
    window.clearTimeout(pending.timer);
    pending.img.remove();
  };

  const thawSlot = (slot: HTMLElement): void => {
    const cur = frozen.get(slot);
    if (!cur) return;
    frozen.delete(slot);
    slot.dataset.freeze = "0";
    // 도착 자리의 접힘으로 다시 놓는다 — 스탠드인은 출발 자리의 ceil 잔차를 들고 미끄러졌고,
    // 표면은 도착 자리의 잔차로 되살아난다. 분수부가 달라졌으면 교대하는 그 한 프레임에서
    // 둘이 1px 어긋난다. 여기가 사용자가 실제로 보는 유일한 교대 프레임이다.
    const lr = slot.getBoundingClientRect();
    const land = surfaceRectOf(lr);
    cur.img.style.left = cssPx(land.x - lr.left);
    cur.img.style.top = cssPx(land.y - lr.top);
    // 해동 = 착지 신호. 소유자가 이 에지에 정확히 한 번 최종 rect 로 쓴다. 스탠드인은 그 쓰기가
    // 실제로 도착한 뒤 물러난다 — 시간으로 추측하면(옛 90ms 고정) 느린 사이드카 경로에서 홀이
    // 표면보다 먼저 열려 한 프레임이 빈다. 상한은 소유자가 끝내 쓰지 않는 경우의 바닥일 뿐이다.
    deps.emitVeil(cur.viewId, false, false);
    const timer = window.setTimeout(() => withdraw(cur.viewId), landingTimeout);
    awaiting.set(cur.viewId, { img: cur.img, timer });
  };

  return {
    captureSettled,
    canFreezeAll(viewIds) {
      const root = deps.root();
      if (!root) return false;
      for (const viewId of viewIds) {
        const slot = byView.get(viewId);
        // 홀이 아닌 뷰(DOM 표면)는 스탠드인이 필요 없다 — 스스로 활강한다.
        if (!slot || !slot.isConnected) continue;
        const rect = slot.getBoundingClientRect();
        if (parkedSlot(rect)) continue; // 비활성 탭 — 이 뷰 때문에 여정이 스냅으로 떨어지지 않는다
        const snap = snaps.get(slot);
        if (!snap || !fresh(snap)) return false;
        // 크기 판정은 스탠드인을 세울 때와 같은 규칙으로 — 다른 규칙을 섞으면 같은 슬롯을 두
        // 기준이 다르게 재고, 세울 수 있는 스탠드인을 거절한다.
        const surface = surfaceRectOf(rect);
        if (Math.abs(surface.w - snap.w) > 1 || Math.abs(surface.h - snap.h) > 1) {
          return false;
        }
      }
      return true;
    },
    invalidate(viewId) {
      const slot = byView.get(viewId);
      if (!slot) return;
      snaps.delete(slot);
      delete slot.dataset.freezeSnapAt;
    },
    noteSurfaceWrite(viewId) {
      withdraw(viewId);
    },
    onMotion(active, kinds, scope) {
      const want =
        active && kinds.length > 0 && kinds.every((k) => k === "move");
      if (want) {
        const root = deps.root();
        if (!root) return;
        for (const slot of holeSlots(root)) {
          if (scope != null) {
            const vid = viewIdOf(slot);
            if (vid == null || !scope.has(vid)) continue; // 범위 밖 — 라이브 유지
          }
          slot.dataset.freezeScope = scope == null ? "global" : `scoped:${scope.size}`; // 관측면
          if (scope == null)
            slot.dataset.freezeSender = String(
              (window as unknown as { __lastGlobalMotionSender?: string }).__lastGlobalMotionSender ?? "?",
            );
          freezeSlot(slot);
        }
        // 범위 축소 재발화(위상 겹침 해소 등)로 범위 밖이 된 동결은 즉시 해동한다.
        for (const slot of Array.from(frozen.keys())) {
          if (scope != null) {
            const vid = viewIdOf(slot);
            if (vid == null || !scope.has(vid)) thawSlot(slot);
          }
        }
      } else {
        for (const slot of Array.from(frozen.keys())) thawSlot(slot);
      }
    },
    dispose() {
      for (const viewId of Array.from(awaiting.keys())) withdraw(viewId);
      byView.clear();
      for (const [slot, cur] of frozen) {
        cur.img.remove();
        slot.dataset.freeze = "0";
        // 회수도 착지 에지다 — veil 을 켠 채 사라지면 소유자는 "따라가지 마라"를 영구히
        // 지키고, 그 표면은 이후 어떤 이동에도 bounds 를 보내지 않는다(정지 좌초).
        deps.emitVeil(cur.viewId, false, false);
      }
      frozen.clear();
    },
  };
}
