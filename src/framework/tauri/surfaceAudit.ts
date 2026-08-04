// 표면 정합 상시 감사 — 사람이 명령(webview.surfaces)을 치는 순간에만 보이는 관측은
// 관측이 아니다. 표면 세계가 변하는 사건마다 앱이 스스로 판정하고, 위반을 활동 허브에
// 사실(surface.misplaced)로 남긴다. 감사는 표면을 숨기거나 보이지 않는다. 가시성 변경은
// 표면 소유자의 장부를 통해서만 수행해야 판정 중 스친 과도 상태가 영구 상태가 되지 않는다.
//
// 판정 계약: 화면에 보이는 엔진 서피스(코어 layer 실측 — engine_surface_stats)는 반드시
// 보이는 Tauri content 슬롯(data-tauri-hole — 네이티브 표면의 자리) 하나와 일치해야 한다. 슬롯 없는
// 서피스 = 오배치(misplaced), 한 홀에 둘 = 겹침(stacked). 실사고: 콜드 부팅에서 서피스가
// 전부 오른쪽 열로 몰려 native 브라우저 위에 다른 엔진 프레임이 겹쳐 보였는데("이전
// 브라우저"), 카운트 기준 관측은 그것을 정상이라 했다 — 판정 축은 개별 frame 이다.
//
// 폴링 아님: 트리거는 전부 사건(layout.reflow·view.parked·webview.* 활동·리사이즈 종료·
// 부트 ready)이고, 타이머는 사건 후 레이아웃 정착 대기 1개뿐(400ms 디바운스 — 사건 이름
// surface-audit-settleTimer.settle, 연속 사건은 마지막 것만 판정).
import { moduleState } from "../../lib/moduleState";
import { invoke } from "../index";
import { onPluginEvent } from "../../plugins/hooks";
import { useBootPhase } from "../../state/bootPhase";
import { TAURI_CONTENT_HOLE } from "./holeMarkers";

export interface AuditRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SurfaceAnchorFact {
  label: string | null;
  viewId: string | null;
  projectId: string | null;
  rect: AuditRect;
}

export interface NativeSurfaceFact {
  ptr: number;
  label: string | null;
  hidden: boolean;
  effectivelyHidden: boolean;
  autoresizingMask: number | null;
  layerContentsRedrawPolicy: number | null;
  layerContentsPlacement: number | null;
  nativeFrame: AuditRect;
  domFrame: AuditRect;
}

export interface SurfaceCompositionSnapshot {
  coordinateContract: { dom: string; native: string; windowZoom: number; tolerancePx: number };
  engine: { preservesContentDuringLiveResize: boolean | null };
  anchors: SurfaceAnchorFact[];
  surfaces: NativeSurfaceFact[];
  matches: {
    surfaceLabel: string | null;
    ptr: number;
    anchorLabel: string | null;
    viewId: string | null;
    projectId: string | null;
    matched: boolean;
  }[];
  verdict: SurfaceVerdict;
}

export interface SurfaceVerdict {
  misplaced: AuditRect[]; // 어느 홀과도 안 맞는 가시 서피스
  stacked: AuditRect[][]; // 같은 홀을 차지한 서피스 묶음(겹침)
  missing: AuditRect[]; // 가시 서피스가 하나도 안 맞는 보이는 홀 — "보여야 하는데 안 보임"
  surfaces: number;
  holes: number;
}

/** DOM→AppKit 왕복에서 허용하는 서브픽셀 정수화 폭. 그보다 큰 차이는 합성 불일치다. */
export const SURFACE_RECT_TOLERANCE_PX = 2;

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const rectMatches = (s: AuditRect, h: AuditRect, tol: number) =>
  near(s.x, h.x, tol) && near(s.y, h.y, tol) && near(s.w, h.w, tol) && near(s.h, h.h, tol);

/** 순수 판정 — 서피스·홀 rect 는 같은 좌표계(DOM top-left)로 넘긴다. */
export function judgeSurfaces(
  surfaces: AuditRect[],
  holes: AuditRect[],
  tol = SURFACE_RECT_TOLERANCE_PX,
): SurfaceVerdict {
  const byHole = new Map<number, AuditRect[]>();
  const misplaced: AuditRect[] = [];
  for (const s of surfaces) {
    const hi = holes.findIndex((h) => rectMatches(s, h, tol));
    if (hi < 0) {
      misplaced.push(s);
      continue;
    }
    const list = byHole.get(hi);
    if (list) list.push(s);
    else byHole.set(hi, [s]);
  }
  const stacked = [...byHole.values()].filter((l) => l.length > 1);
  const missing = holes.filter((_, i) => !byHole.has(i));
  return { misplaced, stacked, missing, surfaces: surfaces.length, holes: holes.length };
}

/** 보이는 네이티브 앵커 rect 수집. 실제 content-view 슬롯에서 Tauri가 투영한 marker만
 * 정본이며, 플러그인의 내부 클래스나 shadow 구조를 추측하지 않는다. */
export function visibleAnchorFacts(doc: Document = document): SurfaceAnchorFact[] {
  const hiddenByTree = (el: HTMLElement): boolean => {
    for (let cur: HTMLElement | null = el; cur; cur = cur.parentElement) {
      const style = cur.ownerDocument.defaultView?.getComputedStyle(cur);
      if (style?.visibility === "hidden" || style?.display === "none") return true;
      // 프로젝트 활성성은 DOM 합성의 명시 계약이다. 자식의 잘못된 visible 선언이 CSS 상속을
      // 뚫더라도 비활성 프로젝트를 네이티브 홀로 승격하지 않는다.
      if (cur.hasAttribute("data-project-plane") && cur.dataset.projectActive !== "1") return true;
    }
    return false;
  };
  const out: SurfaceAnchorFact[] = [];
  const collect = (els: Iterable<HTMLElement>) => {
    for (const el of els) {
      // marker는 실제 data-content-view-body 슬롯 자체에 선다. 탭 frame 전체를 앵커로 쓰면
      // toolbar 높이만큼 네이티브 표면과 어긋난다. identity만 공개 조상에서 읽는다.
      const slot = el.hasAttribute("data-content-view-body")
        ? el
        : el.querySelector<HTMLElement>("[data-content-view-body]");
      if (!slot || hiddenByTree(slot)) continue;
      const r = slot.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (r.x + r.width <= 0 || r.x >= window.innerWidth) continue; // 파킹(오프스크린)
      const frame = slot.closest<HTMLElement>('[data-node^="layout/tab/"]');
      const node = frame?.dataset.node ?? "";
      out.push({
        label: slot.getAttribute("data-content-view-body") ?? null,
        viewId: node.startsWith("layout/tab/") ? node.slice("layout/tab/".length) : null,
        projectId: frame?.dataset.projectId ?? null,
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      });
    }
  };
  collect(doc.querySelectorAll<HTMLElement>(TAURI_CONTENT_HOLE));
  return out;
}

/** 기존 감사 소비면 — 상세 identity를 버리지 않고 rect 보기만 제공한다. */
export function visibleAnchorRects(): { rects: AuditRect[]; source: string } {
  return {
    rects: visibleAnchorFacts().map((anchor) => anchor.rect),
    source: "content-view-slot",
  };
}

/** 빈 본문 뷰(dark) 수집 — 보이는 plugin 뷰 컨테이너인데 본문이 아무것도 없다(라이트 DOM
 *  자식 0 && shadow 자식 0, 오버레이도 없음). 실사고: 활성 구글 페인이 통검정인데 앵커
 *  (bv-area)조차 없어 missing 판정이 성립 안 했다 — 뷰 마운트/child 생성 실패는 앵커
 *  이전의 실패라 자기만의 축이 필요하다. */
function darkViewRects(): AuditRect[] {
  const out: AuditRect[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(".tab-viewer.plugin-view-container")) {
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) continue;
    if (r.x + r.width <= 0 || r.x >= window.innerWidth) continue; // 파킹
    const body = el.parentElement; // .plugin-body — 오버레이(로딩/에러/부재)는 형제로 선다
    // 오버레이가 있어도 본문이 비면 발행한다 — "플러그인 뷰 없음" 류가 ready 후 지속되는
    // 것 자체가 위반이다(빈칸/로딩 3상의 시행). 종류를 실어 원장이 상태를 분류한다.
    const overlay =
      body?.querySelector(".plugin-error") ? "error"
      : body?.querySelector(".plugin-empty") ? "empty"
      : body?.querySelector(".plugin-loading") ? "loading"
      : "none";
    if (overlay === "loading") continue; // 로딩 표시는 정직한 과도 상태 — dark 아님
    const lightEmpty = el.childElementCount === 0;
    const shadowEmpty = !el.shadowRoot || el.shadowRoot.childElementCount === 0;
    if (lightEmpty && shadowEmpty)
      out.push({ x: r.x, y: r.y, w: r.width, h: r.height, overlay } as AuditRect & { overlay: string });
  }
  return out;
}

interface EngineStats {
  windowZoom?: number;
  preservesContentDuringLiveResize?: boolean;
  surfaces?: {
    ptr: number;
    label?: string | null;
    hidden: boolean;
    effectivelyHidden: boolean;
    autoresizingMask?: number;
    layerContentsRedrawPolicy?: number;
    layerContentsPlacement?: number;
    frame: AuditRect;
  }[];
}

export function normalizeNativeSurfaces(
  stats: EngineStats,
  innerHeight: number,
  windowZoom = stats.windowZoom ?? 1,
): NativeSurfaceFact[] {
  const scale = Number.isFinite(windowZoom) && windowZoom > 0 ? windowZoom : 1;
  return (stats.surfaces ?? []).map((surface) => ({
    ptr: surface.ptr,
    label: surface.label ?? null,
    hidden: surface.hidden,
    effectivelyHidden: surface.effectivelyHidden,
    autoresizingMask: Number.isFinite(surface.autoresizingMask)
      ? Number(surface.autoresizingMask)
      : null,
    layerContentsRedrawPolicy: Number.isFinite(surface.layerContentsRedrawPolicy)
      ? Number(surface.layerContentsRedrawPolicy)
      : null,
    layerContentsPlacement: Number.isFinite(surface.layerContentsPlacement)
      ? Number(surface.layerContentsPlacement)
      : null,
    nativeFrame: surface.frame,
    // NSView(bottom-left) → DOM(top-left). 입력과 출력 좌표계를 함께 공개해 변환을 숨기지 않는다.
    domFrame: {
      x: surface.frame.x / scale,
      y: innerHeight - (surface.frame.y + surface.frame.h) / scale,
      w: surface.frame.w / scale,
      h: surface.frame.h / scale,
    },
  }));
}

/** Tauri 합성의 공개 상태 — DOM 앵커와 실제 NSView frame을 같은 답에서 일대일 대조한다. */
export async function surfaceCompositionSnapshot(): Promise<SurfaceCompositionSnapshot> {
  const stats = await invoke<EngineStats>("engine_surface_stats");
  const anchors = visibleAnchorFacts();
  const surfaces = normalizeNativeSurfaces(stats, window.innerHeight);
  const visible = surfaces.filter((surface) => !surface.effectivelyHidden);
  const verdict = judgeSurfaces(
    visible.map((surface) => surface.domFrame),
    anchors.map((anchor) => anchor.rect),
  );
  const matches = visible.map((surface) => {
    const anchor = anchors.find((candidate) =>
      rectMatches(surface.domFrame, candidate.rect, SURFACE_RECT_TOLERANCE_PX),
    );
    return {
      surfaceLabel: surface.label,
      ptr: surface.ptr,
      anchorLabel: anchor?.label ?? null,
      viewId: anchor?.viewId ?? null,
      projectId: anchor?.projectId ?? null,
      matched: !!anchor,
    };
  });
  return {
    coordinateContract: {
      dom: "CSS px, viewport top-left",
      native: "AppKit pt, content-view bottom-left",
      windowZoom: stats.windowZoom ?? 1,
      tolerancePx: SURFACE_RECT_TOLERANCE_PX,
    },
    engine: {
      preservesContentDuringLiveResize:
        typeof stats.preservesContentDuringLiveResize === "boolean"
          ? stats.preservesContentDuringLiveResize
          : null,
    },
    anchors,
    surfaces,
    matches,
    verdict,
  };
}

/** 표면이 어느 슬롯에도 담기지 않는가 — 진단용 포함 판정. 슬롯보다 밖으로 1px 이라도
 *  나가면 침범이다: 그 픽셀이 이웃 칸을 덮는다. tol 은 반올림 오차만 흡수한다. */
export function containedIn(surface: AuditRect, anchors: AuditRect[], tol = 2): boolean {
  return anchors.some(
    (a) =>
      surface.x >= a.x - tol &&
      surface.y >= a.y - tol &&
      surface.x + surface.w <= a.x + a.w + tol &&
      surface.y + surface.h <= a.y + a.h + tol,
  );
}

// 서로 다른 것은 따로 선다 — 한 가방에 넣으면 그것은 상태가 아니라 가방이다.
/** 마지막으로 발행한 서명 — 같은 사실을 두 번 말하지 않기 위한 것. */
const lastSeen = moduleState("framework/tauri/surfaceAudit#lastSeen", () => ({
  lastSignature: "",
  lastMissingSig: "[]",
  lastDarkSig: "[]",
}));

/** 정착 대기 손잡이 — 서명과 수명이 다르다. */
const settleTimer = moduleState("framework/tauri/surfaceAudit#settleTimer", () => ({
  settle: null as ReturnType<typeof setTimeout> | null,
}));
async function runAudit(): Promise<void> {
  const composition = await surfaceCompositionSnapshot().catch(() => null);
  if (!composition) return;
  const anchors = { rects: composition.anchors.map((anchor) => anchor.rect), source: "content-view-slot" };
  const verdict = composition.verdict;
  // missing("보여야 하는데 안 보임" — 실사고: 활성 구글 페인이 검게 안뜸)은 로딩 과도기
  // (open 전·재페인트 전)가 정상적으로 스치는 상태라, 두 번 연속 같은 판정일 때만 위반으로
  // 발행한다(지속 = 결함, 스침 = 과도기).
  const missingSig = JSON.stringify(verdict.missing);
  const missingPersists = verdict.missing.length > 0 && missingSig === lastSeen.lastMissingSig;
  lastSeen.lastMissingSig = missingSig;
  // dark(빈 본문 뷰)도 지속 2회일 때만 — 마운트 직후 한 프레임은 정상적으로 비어 있다.
  // 부트 중에는 판정하지 않는다(활성화 진행 = 로딩 계약의 시간).
  const dark = useBootPhase.getState().phase === "ready" ? darkViewRects() : [];
  const darkSig = JSON.stringify(dark);
  const darkPersists = dark.length > 0 && darkSig === lastSeen.lastDarkSig;
  lastSeen.lastDarkSig = darkSig;
  const bad =
    verdict.misplaced.length > 0 ||
    verdict.stacked.length > 0 ||
    missingPersists ||
    darkPersists;
  const signature = bad
    ? JSON.stringify([verdict.misplaced, verdict.stacked.map((l) => l.length), missingPersists ? verdict.missing : [], darkPersists ? dark : []])
    : "clean";
  if (signature === lastSeen.lastSignature) return; // 같은 사실의 반복 발행 금지(원장 소음 절제)
  const wasBad = lastSeen.lastSignature !== "" && lastSeen.lastSignature !== "clean";
  lastSeen.lastSignature = signature;
  if (!bad && !wasBad) return; // 처음부터 깨끗 — 침묵이 정상
  void invoke("activity_publish", {
    kind: bad ? "surface.misplaced" : "surface.audit",
    source: "webview",
    payload: {
      misplaced: verdict.misplaced,
      stacked: verdict.stacked,
      missing: missingPersists ? verdict.missing : [],
      dark: darkPersists ? dark : [],
      surfaces: verdict.surfaces,
      holes: verdict.holes,
      anchorSource: anchors.source,
      origin: "internal",
      message: bad
        ? `· surface misplaced ×${verdict.misplaced.length} stacked ×${verdict.stacked.length} missing ×${missingPersists ? verdict.missing.length : 0} dark ×${darkPersists ? dark.length : 0} (surfaces ${verdict.surfaces}/holes ${verdict.holes})`
        : "· surfaces realigned — audit clean",
    },
  }).catch(() => {});
}

function schedule(): void {
  if (settleTimer.settle !== null) clearTimeout(settleTimer.settle);
  // 정착 디바운스(surface-audit-settleTimer.settle) — 사건 직후 레이아웃·bounds 반영이 끝난 뒤 1회 판정.
  settleTimer.settle = setTimeout(() => {
    settleTimer.settle = null;
    void runAudit();
  }, 400);
}

// "이미 붙였다"는 기억은 갈아끼우기 경계를 넘어야 한다 — 이 플래그만 사라지면 설치는
// 안 남았는데 채우던 쪽은 이미 돌았다고 알아 다시 붙이지 않는다(영영 미설치).
const installedFlag = moduleState("framework/tauri/surfaceAudit#installedFlag.on", () => ({ on: false }));

/** 상시 감사 설치 — 부트에서 1회(멱등). 트리거는 전부 사건이다. */
export function installSurfaceAudit(): void {
  if (installedFlag.on || typeof document === "undefined") return;
  installedFlag.on = true;
  onPluginEvent("layout.reflow", schedule);
  onPluginEvent("view.parked", schedule);
  onPluginEvent("window.live-resize", (p) => {
    if (!p.active) schedule();
  });
  // webview 세계의 변화(생성·파괴·숨김·복귀·유령)는 활동 허브로 흐른다 — 같은 채널을 구독.
  onPluginEvent("activity", (e) => {
    if (String(e.kind).startsWith("webview.") || String(e.kind).startsWith("surface.ghost"))
      schedule();
  });
  useBootPhase.subscribe((s) => {
    if (s.phase === "ready") schedule();
  });
}

/** 테스트 전용 초기화. */
export function __resetSurfaceAuditForTest(): void {
  installedFlag.on = false;
  lastSeen.lastSignature = "";
  lastSeen.lastMissingSig = "[]";
  lastSeen.lastDarkSig = "[]";
  if (settleTimer.settle !== null) clearTimeout(settleTimer.settle);
  settleTimer.settle = null;
}
