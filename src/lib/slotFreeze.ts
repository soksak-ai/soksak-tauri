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
  /** 표면 가림 릴레이 — view.veiled { viewId, veiled } 발화(사이드카 표면 소유자가 소비). */
  emitVeil: (viewId: string, veiled: boolean) => void;
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

function holeSlots(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(HOLE_SLOT_SELECTOR));
}

export function createSlotFreeze(deps: SlotFreezeDeps): SlotFreeze {
  const maxAge = deps.maxSnapAgeMs ?? 120_000;
  const now = deps.now ?? (() => performance.now());
  const makeImage = deps.imageFactory ?? (() => document.createElement("img"));
  const snaps = new WeakMap<HTMLElement, SlotSnap>();
  const inFlight = new WeakSet<HTMLElement>();
  const frozen = new Map<HTMLElement, { img: HTMLImageElement; viewId: string }>();

  const captureSettled = (): void => {
    const root = deps.root();
    if (!root) return;
    for (const slot of holeSlots(root)) {
      if (inFlight.has(slot) || frozen.has(slot)) continue;
      const r = slot.getBoundingClientRect();
      const x = Math.ceil(r.left);
      const y = Math.ceil(r.top);
      const w = Math.floor(r.right) - x;
      const h = Math.floor(r.bottom) - y;
      if (w < 2 || h < 2) continue;
      // 포커스 장식 박제 금지 — dim 이 걸린(스팟 아닌) 슬롯의 창 픽셀엔 셰이드 베일이 구워져
      // 있다. 그걸 스탠드인으로 쓰면 동결 중 라이브 dim 과 어긋나 "포커스 인/아웃" 플랩으로
      // 보인다(실측). 청정(스팟) 상태의 스냅만 굽고, dim 은 라이브 계층(::after·filter)이 얹는다.
      if (slot.closest("[data-focus-dim]") && !slot.classList.contains("spot-clear")) continue;
      // 화면 밖(파킹) 슬롯은 캡처 대상이 아니다 — 그 rect 의 창 픽셀은 남의 것이다.
      if (typeof window !== "undefined") {
        if (x + w <= 0 || y + h <= 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
      }
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
    if (!snap || now() - snap.t > maxAge) return;
    const r = slot.getBoundingClientRect();
    // 스냅 이후 슬롯 크기가 변했으면 세우지 않는다 — 늘어난 정지 사진은 박제다.
    if (Math.abs(r.width - snap.w) > 2 || Math.abs(r.height - snap.h) > 2) return;
    const img = snap.img; // 정착 에지에서 디코드 완료 — append 즉시 페인트
    img.className = "slot-freeze-frame";
    img.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;object-fit:fill;pointer-events:none;z-index:3;";
    slot.appendChild(img);
    frozen.set(slot, { img, viewId });
    slot.dataset.freeze = "1"; // 관측면(ui.hit)
    // veil = "이 표면은 지금 스탠드인 뒤에 있다: 따라가지 말고, 해동 에지에 정확히 한 번
    // 착지하라". 표면을 숨기라는 뜻이 아니다 — 유일한 홀(슬롯)은 불투명 img 가 덮고 홀 밖
    // DOM 은 원래 불투명이라 표면은 어차피 보이지 않는다. 숨김을 걸면 복귀 사이클(WK 기상
    // 재부착 1프레임 소실·CEF hidden 토글 재페인트)이 스왑마다 화면 깜빡을 만든다(실사고).
    deps.emitVeil(viewId, true);
  };

  const thawSlot = (slot: HTMLElement): void => {
    const cur = frozen.get(slot);
    if (!cur) return;
    frozen.delete(slot);
    slot.dataset.freeze = "0";
    // 해동 = 착지 신호. 표면 소유자가 이 에지에 정확히 한 번 최종 rect 로 스냅하고, 스탠드인은
    // 한 박자 뒤 물러난다(그 사이에 착지가 확정되므로 깜빡 0).
    deps.emitVeil(cur.viewId, false);
    window.setTimeout(() => cur.img.remove(), 90);
  };

  return {
    captureSettled,
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
      for (const [slot, cur] of frozen) {
        cur.img.remove();
        slot.dataset.freeze = "0";
        // 회수도 착지 에지다 — veil 을 켠 채 사라지면 소유자는 "따라가지 마라"를 영구히
        // 지키고, 그 표면은 이후 어떤 이동에도 bounds 를 보내지 않는다(정지 좌초).
        deps.emitVeil(cur.viewId, false);
      }
      frozen.clear();
    },
  };
}
