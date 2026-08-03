// Tauri 자식 표면 기하 거래 — move/resize 위상 동안 홀-슬롯의 네이티브 표면을 DOM
// 스탠드인으로 대체한다. 샘플링 bounds 추종은 DOM 컴포지터와 같은 프레임을 보장하지 못한다.
// DOM 스탠드인이 슬롯 안에서 움직이거나 늘어나면 거래 중 기하 일치는 정의상 성립한다.
//
// 소유권: 이 거래는 Tauri 어댑터만 시행한다. 코어는 홀-슬롯 선언, 모션 위상, 캡처라는 공개
// 인터페이스만 제공하고 네이티브 표면 합성 정책을 알지 않는다. 제품 플러그인도 프레임워크를
// 알지 않으며 공개 content-view label의 content-view.veiled 이벤트만 릴레이한다.
//
// 불변 계약(§4.6):
//  - move 는 1:1 스냅, resize 는 슬롯 크기를 따르는 스냅으로 DOM 기하를 우선한다.
//  - 선캡처·선디코드(정착 에지) — 동결 순간 디코드 지연 0.
//  - 페인트 먼저, 숨김 나중 — 스탠드인 페인트가 커밋된 뒤(이중 rAF) veil(true).
//  - 스냅 부재·낡음·크기 드리프트는 폴백 = 라이브 추종(동결 없음).
//  - 거래 중 bounds 추종은 멈추고, 종료 에지에서 최종 bounds를 먼저 적용한 뒤 표면을 복귀한다.
import { HOLE_SELECTOR } from "./railHoleClip";
import { surfaceRectOf } from "../../lib/surfaceRect";
import { CONTENT_VIEW_BODY } from "../../lib/contentViews";

interface SlotSnap {
  img: HTMLImageElement;
  t: number;
  w: number;
  h: number;
  /**
   * 이 사진이 구워질 때 슬롯의 흐림 단계.
   *
   * 창 픽셀을 찍으므로 흐림 베일이 사진에 **들어간다**. 그래서 사진은 그때의 흐림과 한 몸이다 —
   * 단계가 달라지면 그 사진은 더 이상 이 슬롯의 그림이 아니다(크기 드리프트와 같은 규칙).
   */
  dim: string;
}

export interface SlotFreezeDeps {
  /** 슬롯 탐색 루트(보통 document). null 이면 그 시점 동작은 no-op. */
  root: () => ParentNode | null;
  /** 창 좌표 rect(CSS px)를 PNG data URL 로 캡처한다. */
  capture: (rect: { x: number; y: number; w: number; h: number }) => Promise<string>;
  /**
   * 표면 릴레이 — content-view.veiled { label, veiled, hidden } 발화.
   * veiled = 따라가지 마라(위상 중 쓰기 금지). hidden = 지금 감춰라.
   * 둘은 다른 에지다: 추종 정지는 위상 시작 즉시, 감춤은 스탠드인 페인트가 커밋된 뒤(§5-2).
   */
  emitVeil: (label: string, veiled: boolean, hidden: boolean) => void;
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
  invalidate(label: string): void;
  /**
   * 표면 소유자가 실제로 착지 좌표를 쓴 사실. 코어가 자기 쓰기 경로(webview.bounds)에서
   * 관측한다 — 스탠드인은 이 사실 위에서 물러난다(시간 추측 금지).
   */
  noteSurfaceWrite(label: string): void;
  /** 모션 신호 수신부 — onLayoutMotion (active, kinds, scope) 를 그대로 넘긴다.
   *  scope: 이 위상이 움직이는 viewId 집합(null=전역). 범위 밖 슬롯은 동결하지 않는다 —
   *  관련 없는 표면이 남의 스왑에 베일 펄스를 맞지 않는다(라이브 유지). */
  onMotion(active: boolean, kinds: string[], scope?: Set<string> | null): void;
  /** 스탠드인·상태 회수(테스트·종료). 표면 가시성은 veil(false)로 이미 복귀된 상태여야 한다. */
  dispose(): void;
}

// 슬롯의 탭 귀속 — 슬롯이 공개하는 노드 주소(data-node="layout/tab/<tab-id>")가 원천이다.
function viewIdOf(slot: HTMLElement): string | null {
  const node = slot.getAttribute("data-node");
  const prefix = "layout/tab/";
  if (!node || !node.startsWith(prefix)) return null;
  const id = node.slice(prefix.length);
  return id.length > 0 ? id : null;
}

/** 슬롯이 공개 선언한 content-view identity. 내부 클래스나 플러그인 label 문법은 읽지 않는다. */
function contentViewLabelOf(slot: HTMLElement): string | null {
  const body = slot.hasAttribute(CONTENT_VIEW_BODY)
    ? slot
    : slot.querySelector<HTMLElement>(`[${CONTENT_VIEW_BODY}]`);
  return body?.getAttribute(CONTENT_VIEW_BODY) || null;
}

/**
 * DOM 가시성이 꺼진 슬롯인가. 비활성 탭은 상자와 수명은 유지하되 보이지 않는다 — 그 표면은
 * 보이지 않으므로 덮을 것도, 옛 자리를 드러낼 일도 없다. 세 곳이 같은 기준을 봐야 한다:
 *  - 캡처: 그 rect 의 창 픽셀은 남의 것이다.
 *  - 활강 전제: 보이지 않는 뷰의 스냅이 없다고 여정 전체를 스냅으로 떨어뜨리면, 브라우저 탭이
 *    둘 이상인 패널은 영원히 활강하지 못한다.
 *  - 동결: 파킹된 슬롯을 동결하면 해동 에지에 veil(false) 가 가고, 표면 소유자는 그 신호에
 *    좌표를 쓰고 다시 보이게 한다 — 비활성 탭이 여정마다 번쩍인다(실측 깜빡임).
 */
function parkedSlot(slot: HTMLElement): boolean {
  return slot.style.visibility === "hidden" || slot.style.display === "none";
}

/** 부동소수 잔재를 CSS 에 흘리지 않는다(0.7999999999999545px) — 0.01px 격자면 충분하다. */
const cssPx = (n: number): string => `${Math.round(n * 100) / 100}px`;

function holeSlots(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(HOLE_SELECTOR));
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
  const frozen = new Map<
    HTMLElement,
    { img: HTMLImageElement; viewId: string; label: string; stretch: boolean }
  >();
  // viewId → 그 뷰의 홀 슬롯(스냅 조회·무효화용). 슬롯 엘리먼트는 뷰가 살아 있는 동안 안정적이다.
  const byView = new Map<string, HTMLElement>();
  const byLabel = new Map<string, HTMLElement>();
  // 해동 뒤 착지 쓰기를 기다리는 스탠드인 — 소유자가 실제로 쓰면 그 프레임에 걷는다.
  const awaiting = new Map<string, { img: HTMLImageElement; timer: number }>();

  const captureSettled = (): void => {
    const root = deps.root();
    if (!root) return;
    for (const slot of holeSlots(root)) {
      const viewId = viewIdOf(slot);
      const label = contentViewLabelOf(slot);
      if (!viewId || !label) continue;
      // 시도 계수 — "정착 에지가 이 슬롯을 보았다"는 사실. 이것이 늘지 않으면 에지가 오지 않은
      // 것이고, 늘면서 snapAt 이 그대로면 아래 건너뛰기 중 하나에 걸린 것이다. 둘을 가르지
      // 못하면 "왜 스냅이 낡았는가"를 추측하게 된다.
      slot.dataset.freezeSnapTry = String(Number(slot.dataset.freezeSnapTry ?? 0) + 1);
      const skip = (why: string): void => {
        slot.dataset.freezeSnapSkip = why; // 건너뛴 이유 — 추측 금지
      };
      if (inFlight.has(slot)) {
        skip("inflight");
        continue;
      }
      if (frozen.has(slot)) {
        skip("frozen");
        continue;
      }
      // 표면이 실제로 서 있는 정수 rect 를 캡처한다 — 슬롯의 분수 rect 를 캡처하면 표면 픽셀에
      // 이웃 픽셀이 섞이고, 그 사진을 되돌려 놓을 자리도 없다(§4.6, surfaceRect 규칙).
      const rect = slot.getBoundingClientRect();
      const { x, y, w, h } = surfaceRectOf(rect);
      if (w < 2 || h < 2) {
        skip("tiny");
        continue;
      }
      if (parkedSlot(slot)) {
        skip("parked");
        continue;
      }
      delete slot.dataset.freezeSnapSkip;
      inFlight.add(slot);
      // 엔진 자기 상태도 관측면이다 — 캡처가 매달려 있거나 실패하면 스냅이 낡고, 낡은 스냅은
      // 활강 전제를 깨서 여정이 통째로 순간이동한다. 그때 밖에서 볼 수 있는 것이 없으면 "왜
      // 활강하지 않는가"를 추측하게 된다(실측: chromium 슬롯의 snapAt 이 한 값에 멈춰 있었다).
      slot.dataset.freezePending = "1";
      void deps
        .capture({ x, y, w, h })
        .then(async (url) => {
          // 여기서 미리 디코드까지 끝내 둔다 — 동결 순간의 디코드 지연(1~2프레임)이 "표면
          // 숨김이 스탠드인 페인트보다 먼저 착지 → 배경 번쩍"의 재료였다(실측).
          const img = makeImage();
          img.src = url;
          await img.decode();
          snaps.set(slot, { img, t: now(), w, h, dim: slot.dataset.dim ?? "clear" });
          byView.set(viewId, slot);
          byLabel.set(label, slot);
          slot.dataset.freezeSnapAt = String(Math.round(now())); // 관측면(ui.hit)
          // 구운 크기도 관측면이다 — 스냅의 존재만으로는 아무것도 보장되지 않는다. 분할 전
          // 크기의 스냅이 남아 있으면 활강 전제가 매번 거부되고, 밖에서는 그 이유를 알 수 없다.
          slot.dataset.freezeSnapSize = `${w}x${h}`;
        })
        .catch(() => {
          slot.dataset.freezeSnapFail = String(
            Number(slot.dataset.freezeSnapFail ?? 0) + 1,
          );
        })
        .finally(() => {
          inFlight.delete(slot);
          delete slot.dataset.freezePending;
        });
    }
  };

  const freezeSlot = (slot: HTMLElement, stretch: boolean): void => {
    const current = frozen.get(slot);
    if (current) {
      if (stretch && !current.stretch) {
        current.stretch = true;
        current.img.style.cssText =
          "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5;";
      }
      return;
    }
    const viewId = viewIdOf(slot);
    const label = contentViewLabelOf(slot);
    if (!viewId || !label) return;
    const snap = snaps.get(slot);
    if (!snap || !fresh(snap)) return;
    // 흐림이 달라졌으면 그 사진은 이 슬롯의 그림이 아니다 — 베일이 사진에 들어 있으므로
    // 단계가 바뀌면 세울 수 없다(크기 드리프트와 같은 규칙: 버리고 다시 굽게 둔다).
    if (snap.dim !== (slot.dataset.dim ?? "clear")) {
      snaps.delete(slot);
      delete slot.dataset.freezeSnapAt;
      delete slot.dataset.freezeSnapSize;
      return;
    }
    const r = slot.getBoundingClientRect();
    if (parkedSlot(slot)) return; // 보이지 않는 표면 — 덮을 것도, 해동에 되살릴 것도 없다
    const surface = surfaceRectOf(r);
    // 스냅 이후 표면 크기가 변했으면 세우지 않고 그 스냅을 버린다 — 늘어난 정지 사진은 박제이고,
    // 남겨 두면 다시 구워지지 못한 채 활강 전제를 계속 거부한다(canFreezeAll 과 같은 규칙).
    if (Math.abs(surface.w - snap.w) > 1 || Math.abs(surface.h - snap.h) > 1) {
      snaps.delete(slot);
      delete slot.dataset.freezeSnapAt;
      delete slot.dataset.freezeSnapSize;
      return;
    }
    // 스탠드인은 **베일 위**(z5)에 선다. 흐림은 이미 사진에 구워져 있으므로 라이브 베일을 또
    // 얹으면 두 번 어두워진다. 예전엔 z3 이었고 베일이 그 위에서 살아 있었는데, 그 이유는
    // 여정 중 흐림이 바뀔 수 있었기 때문이다 — 지금은 흐림도 화면이 그리는 해를 따르므로
    // 여정 중에는 바뀌지 않는다(App: dimOf ← arrangement.focusId). 그래서 사진 하나로 족하다.
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
    img.style.cssText = stretch
      ? "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5;"
      : `position:absolute;left:${cssPx(surface.x - r.left)};top:${cssPx(surface.y - r.top)};` +
        `width:${snap.w}px;height:${snap.h}px;pointer-events:none;z-index:5;`;
    slot.appendChild(img);
    frozen.set(slot, { img, viewId, label, stretch });
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
    deps.emitVeil(label, true, false);
    // ② 페인트 커밋 뒤: 감춰라. 반대 순서는 투명 홀이 1~2프레임 배경을 노출한다.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (frozen.get(slot)?.img !== img) return; // 그새 해동됨 — 감추지 않는다
        deps.emitVeil(label, true, true);
      }),
    );
  };

  /** 스탠드인 철수 — 착지가 확정된 뒤에만. 남은 타이머는 정리한다. */
  const withdraw = (label: string): void => {
    const pending = awaiting.get(label);
    if (!pending) return;
    awaiting.delete(label);
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
    cur.img.style.right = "auto";
    cur.img.style.bottom = "auto";
    cur.img.style.left = cssPx(land.x - lr.left);
    cur.img.style.top = cssPx(land.y - lr.top);
    cur.img.style.width = `${land.w}px`;
    cur.img.style.height = `${land.h}px`;
    // 해동 = 착지 신호. 소유자가 이 에지에 정확히 한 번 최종 rect 로 쓴다. 스탠드인은 그 쓰기가
    // 실제로 도착한 뒤 물러난다 — 시간으로 추측하면(옛 90ms 고정) 느린 사이드카 경로에서 홀이
    // 표면보다 먼저 열려 한 프레임이 빈다. 상한은 소유자가 끝내 쓰지 않는 경우의 바닥일 뿐이다.
    deps.emitVeil(cur.label, false, false);
    const timer = window.setTimeout(() => withdraw(cur.label), landingTimeout);
    awaiting.set(cur.label, { img: cur.img, timer });
  };

  return {
    captureSettled,
    canFreezeAll(viewIds) {
      const root = deps.root();
      if (!root) return false;
      // 전제 판정의 근거도 관측면이다 — "왜 활강하지 않는가"는 이 판정 하나에 달려 있고,
      // 그것이 보이지 않으면 여정이 통째로 순간이동하는 것을 밖에서 설명할 수 없다.
      const verdict = (slot: HTMLElement | undefined, why: string): void => {
        if (slot) slot.dataset.freezeGlide = why;
      };
      for (const viewId of viewIds) {
        const slot = byView.get(viewId);
        // 홀이 아닌 뷰(DOM 표면)는 스탠드인이 필요 없다 — 스스로 활강한다.
        if (!slot || !slot.isConnected) continue;
        if (parkedSlot(slot)) continue; // 비활성 탭 — 이 뷰 때문에 여정이 스냅으로 떨어지지 않는다
        const rect = slot.getBoundingClientRect();
        const snap = snaps.get(slot);
        if (!snap) {
          verdict(slot, "no:nosnap");
          return false;
        }
        if (!fresh(snap)) {
          verdict(slot, `no:stale:${Math.round(now() - snap.t)}`);
          return false;
        }
        // 크기 판정은 스탠드인을 세울 때와 같은 규칙으로 — 다른 규칙을 섞으면 같은 슬롯을 두
        // 기준이 다르게 재고, 세울 수 있는 스탠드인을 거절한다.
        const surface = surfaceRectOf(rect);
        if (Math.abs(surface.w - snap.w) > 1 || Math.abs(surface.h - snap.h) > 1) {
          // 크기가 어긋난 스냅은 **버린다**. 남겨 두면 영구 결함이 된다: 분할·병합으로 슬롯
          // 크기가 바뀐 뒤 그 뷰가 비활성(dim)이면 재캡처가 건너뛰어지고(셰이드 박제 금지),
          // 낡은 크기의 스냅이 계속 남아 모든 여정의 활강 전제를 거부한다 — 그리드가 매번
          // 통째로 순간이동한다(실측 no:size:221x449!=454x449). 버리면 그 뷰가 다음에
          // 청정(스팟)해지는 순간 정착 에지가 맞는 크기로 굽고 스스로 회복한다.
          verdict(slot, `no:size:${surface.w}x${surface.h}!=${snap.w}x${snap.h}`);
          snaps.delete(slot);
          delete slot.dataset.freezeSnapAt;
          delete slot.dataset.freezeSnapSize;
          return false;
        }
        verdict(slot, "yes");
      }
      return true;
    },
    invalidate(label) {
      const slot = byLabel.get(label);
      if (!slot) return;
      snaps.delete(slot);
      delete slot.dataset.freezeSnapAt;
      delete slot.dataset.freezeSnapSize;
    },
    noteSurfaceWrite(label) {
      // **쓴 것과 그려진 것은 다른 사실이다.** 이 신호는 "표면 소유자가 좌표를 쓰고 다시
      // 보이게 했다"까지다 — 그 표면이 새 자리에 실제로 그려졌다는 말이 아니다. 여기서 곧장
      // 사진을 걷으면 렌더러는 다음 페인트에 홀을 열어 버리고, 표면의 표시가 그 페인트보다
      // 늦으면 **정확히 한 프레임**이 배경으로 빈다(실측 2026-08-02, 사용자: "교체가 끝나고
      // 딱 한 프레임에서 사라졌다 다음 프레임에서 나타난다" — 경로와 무관하게 공통이었다).
      //
      // 동결 에지는 같은 차이를 이미 알고 있다: 사진을 붙이고 **페인트가 커밋된 뒤**(이중 rAF)
      // 표면을 숨긴다. 해동은 그 거울이어야 한다 — 표면을 보이게 하고, 페인트가 커밋된 뒤
      // 사진을 걷는다. 사진은 같은 내용이라 두 프레임 더 서 있어도 보이지 않는다.
      //
      // 남은 불확실: 진짜 사실은 "표면이 새 rect 로 한 프레임을 제시했다"이고 그건 소유자만
      // 안다. 여기서 세는 것은 렌더러의 프레임이다 — 그 ack 가 생기면 이 자리가 그것을 받는다.
      const pending = awaiting.get(label);
      if (!pending) return;
      const img = pending.img;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (awaiting.get(label)?.img !== img) return; // 그새 다시 얼었다 — 남의 사진이다
          withdraw(label);
        }),
      );
    },
    onMotion(active, kinds, scope) {
      const want =
        active &&
        kinds.length > 0 &&
        kinds.every((k) => k === "move" || k === "resize");
      if (want) {
        const stretch = kinds.includes("resize");
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
          freezeSlot(slot, stretch);
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
      for (const label of Array.from(awaiting.keys())) withdraw(label);
      byView.clear();
      for (const [slot, cur] of frozen) {
        cur.img.remove();
        slot.dataset.freeze = "0";
        // 회수도 착지 에지다 — veil 을 켠 채 사라지면 소유자는 "따라가지 마라"를 영구히
        // 지키고, 그 표면은 이후 어떤 이동에도 bounds 를 보내지 않는다(정지 좌초).
        deps.emitVeil(cur.label, false, false);
      }
      frozen.clear();
    },
  };
}
