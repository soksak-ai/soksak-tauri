// 표면 정합 상시 감사 — 관측은 기계적이어야 한다(사용자 확정 2026-07-27: "언제는 관측,
// 언제는 비관측이면 안 된다"). 사람이 명령(webview.surfaces)을 치는 순간에만 보이는 관측은
// 관측이 아니다 — 표면 세계가 변하는 사건마다 앱이 스스로 판정하고, 위반을 활동 허브에
// 사실(surface.misplaced)로 남긴다. `sok events --kinds surface.misplaced` 가 실시간 판독면.
//
// 판정 계약: 화면에 보이는 엔진 서피스(코어 layer 실측 — engine_surface_stats)는 반드시
// 보이는 홀 슬롯(.tab-body.hole — 네이티브 표면의 자리) 하나와 일치해야 한다. 홀 없는
// 서피스 = 오배치(misplaced), 한 홀에 둘 = 겹침(stacked). 실사고: 콜드 부팅에서 서피스가
// 전부 오른쪽 열로 몰려 native 브라우저 위에 다른 엔진 프레임이 겹쳐 보였는데("이전
// 브라우저"), 카운트 기준 관측은 그것을 정상이라 했다 — 판정 축은 개별 frame 이다.
//
// 폴링 아님: 트리거는 전부 사건(layout.reflow·view.parked·webview.* 활동·리사이즈 종료·
// 부트 ready)이고, 타이머는 사건 후 레이아웃 정착 대기 1개뿐(400ms 디바운스 — 사건 이름
// surface-audit-settle, 연속 사건은 마지막 것만 판정).
import { invoke } from "../platform";
import { onPluginEvent } from "../plugins/hooks";
import { useBootPhase } from "../state/bootPhase";

export interface AuditRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SurfaceVerdict {
  misplaced: AuditRect[]; // 어느 홀과도 안 맞는 가시 서피스
  stacked: AuditRect[][]; // 같은 홀을 차지한 서피스 묶음(겹침)
  missing: AuditRect[]; // 가시 서피스가 하나도 안 맞는 보이는 홀 — "보여야 하는데 안 보임"
  surfaces: number;
  holes: number;
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const matches = (s: AuditRect, h: AuditRect, tol: number) =>
  near(s.x, h.x, tol) && near(s.y, h.y, tol) && near(s.w, h.w, tol) && near(s.h, h.h, tol);

/** 순수 판정 — 서피스·홀 rect 는 같은 좌표계(DOM top-left)로 넘긴다. */
export function judgeSurfaces(
  surfaces: AuditRect[],
  holes: AuditRect[],
  tol = 12,
): SurfaceVerdict {
  const byHole = new Map<number, AuditRect[]>();
  const misplaced: AuditRect[] = [];
  for (const s of surfaces) {
    const hi = holes.findIndex((h) => matches(s, h, tol));
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

/** 보이는 네이티브 앵커 rect 수집 — 정본 앵커는 .bv-area("bounds 구동원 — 네이티브
 *  webview 가 DOM 슬롯(.bv-area)을 추종한다", 두 브라우저 플러그인 공통 계약)다.
 *  .tab-body.hole(툴바 포함 탭 전체)을 앵커로 삼으면 툴바 높이만큼 어긋나 정상 배치를
 *  오배치로 오판한다(실측: 48px 오프셋 misplaced ×2 — 첫 판의 측정 앵커 오류).
 *  플러그인 뷰는 shadow root 안에 그리므로 라이트 DOM 과 shadow 둘 다 훑는다.
 *  bv-area 가 하나도 없으면 hole 로 폴백(브라우저 외 네이티브 표면). */
export function visibleAnchorRects(): { rects: AuditRect[]; source: string } {
  const collect = (els: Iterable<HTMLElement>, out: AuditRect[]) => {
    for (const el of els) {
      if (el.style.visibility === "hidden" || el.style.display === "none") continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (r.x + r.width <= 0 || r.x >= window.innerWidth) continue; // 파킹(오프스크린)
      out.push({ x: r.x, y: r.y, w: r.width, h: r.height });
    }
  };
  const bv: AuditRect[] = [];
  collect(document.querySelectorAll<HTMLElement>(".bv-area"), bv);
  for (const hostEl of document.querySelectorAll<HTMLElement>(".tab-viewer")) {
    const sr = hostEl.shadowRoot;
    if (sr) collect(sr.querySelectorAll<HTMLElement>(".bv-area"), bv);
  }
  if (bv.length > 0) return { rects: bv, source: "bv-area" };
  const holes: AuditRect[] = [];
  collect(document.querySelectorAll<HTMLElement>(".tab-body.hole"), holes);
  return { rects: holes, source: "hole" };
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
  surfaces?: { ptr: number; hidden: boolean; effectivelyHidden: boolean; frame: AuditRect }[];
}

/** 표면이 어느 슬롯에도 담기지 않는가 — 포함 판정(집행의 조건). 슬롯보다 밖으로 1px 이라도
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

let lastSignature = "";
let lastMissingSig = "[]";
let lastDarkSig = "[]";
let settle: ReturnType<typeof setTimeout> | null = null;

async function runAudit(): Promise<void> {
  const stats = await invoke<EngineStats>("engine_surface_stats").catch(() => null);
  if (!stats) return;
  const innerH = window.innerHeight;
  // NSView(bottom-left) → DOM(top-left) 변환. 줌 1 기준 pt=CSSpx — 오차는 tol 이 흡수.
  const visible = (stats.surfaces ?? [])
    .filter((s) => !s.effectivelyHidden)
    .map((s) => ({
      x: s.frame.x,
      y: innerH - (s.frame.y + s.frame.h),
      w: s.frame.w,
      h: s.frame.h,
    }));
  const anchors = visibleAnchorRects();
  const verdict = judgeSurfaces(visible, anchors.rects);
  // 집행 — 어느 앵커에도 담기지 않는 가시 표면은 코어가 즉시 가린다(마지막 방어선).
  // 판정만 하고 두면 이웃 칸이 계속 덮인다(실측: 좌 129px 침범이 사용자 화면에 남았다).
  // 되살리기는 소유자의 정상 경로(bounds→가시성)가 한다 — 코어는 넘은 것을 가릴 뿐이다.
  for (const s of stats.surfaces ?? []) {
    if (s.effectivelyHidden) continue;
    const dom = {
      x: s.frame.x,
      y: innerH - (s.frame.y + s.frame.h),
      w: s.frame.w,
      h: s.frame.h,
    };
    if (!containedIn(dom, anchors.rects)) {
      void invoke("engine_surface_hide", { ptr: s.ptr, hidden: true }).catch(() => {});
    }
  }
  // missing("보여야 하는데 안 보임" — 실사고: 활성 구글 페인이 검게 안뜸)은 로딩 과도기
  // (open 전·재페인트 전)가 정상적으로 스치는 상태라, 두 번 연속 같은 판정일 때만 위반으로
  // 발행한다(지속 = 결함, 스침 = 과도기).
  const missingSig = JSON.stringify(verdict.missing);
  const missingPersists = verdict.missing.length > 0 && missingSig === lastMissingSig;
  lastMissingSig = missingSig;
  // dark(빈 본문 뷰)도 지속 2회일 때만 — 마운트 직후 한 프레임은 정상적으로 비어 있다.
  // 부트 중에는 판정하지 않는다(활성화 진행 = 로딩 계약의 시간).
  const dark = useBootPhase.getState().phase === "ready" ? darkViewRects() : [];
  const darkSig = JSON.stringify(dark);
  const darkPersists = dark.length > 0 && darkSig === lastDarkSig;
  lastDarkSig = darkSig;
  const bad =
    verdict.misplaced.length > 0 ||
    verdict.stacked.length > 0 ||
    missingPersists ||
    darkPersists;
  const signature = bad
    ? JSON.stringify([verdict.misplaced, verdict.stacked.map((l) => l.length), missingPersists ? verdict.missing : [], darkPersists ? dark : []])
    : "clean";
  if (signature === lastSignature) return; // 같은 사실의 반복 발행 금지(원장 소음 절제)
  const wasBad = lastSignature !== "" && lastSignature !== "clean";
  lastSignature = signature;
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
  if (settle !== null) clearTimeout(settle);
  // 정착 디바운스(surface-audit-settle) — 사건 직후 레이아웃·bounds 반영이 끝난 뒤 1회 판정.
  settle = setTimeout(() => {
    settle = null;
    void runAudit();
  }, 400);
}

let installed = false;

/** 상시 감사 설치 — 부트에서 1회(멱등). 트리거는 전부 사건이다. */
export function installSurfaceAudit(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
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
  installed = false;
  lastSignature = "";
  lastMissingSig = "[]";
  lastDarkSig = "[]";
  if (settle !== null) clearTimeout(settle);
  settle = null;
}
