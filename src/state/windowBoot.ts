// 워크스페이스 영속 부트(A5) — main.tsx 부트가 1회 호출. core-kv 저장과 sessions 스토어를 잇는다.
//  1) 복원: "window/<label>" 스냅샷을 hydrate → 있으면 restoreProjects + reseed, 없으면 false 반환
//     (호출부가 bootstrapFirstProject 로 폴백).
//  2) 자동 저장: sessions 변경마다 디바운스로 스냅샷을 저장 + manifest upsert.
//  3) manifest: "windows" 키에 이 창(label) slot upsert.
//
// coreStore 가 localStorage 동기캐시 + app.data 권위·broadcast 를 흡수하므로 여기선 직렬화/배선만.

import { invoke, currentWindow, frameworkName } from "../framework";
import { safeListen } from "../lib/safeListen";
import { bootFactPayload } from "../lib/bootFact";
import { mayPersist } from "./persistGuard";
import { losesContent, previousGenerationKey } from "./snapshotGeneration";
import { noteDataChange } from "./dataChangeHealth";
import { currentWindowLabel } from "../lib/webviewLabels";
import { makeCoreStore } from "./coreStore";
import { validateProjectRoot, ensureDefaultProjectRoot } from "../lib/projectRoot";
import { claimRoots } from "./projectRegistry";
import { beginRestoreHydration } from "./hydration";
import { releaseWebviewGcHold } from "../lib/webviewGc";
import { reseedSessionsSnapshot } from "../plugins/hooks";
import { useProjection, type Pins } from "./projection";
import { listRecentProjects } from "./recentProjects";
import {
  useSessions,
  nextSplitIdGen,
  migrateSpaceTitle,
  type Project,
} from "./sessions";
import {
  snapshotWindow,
  restoreWindow,
  windowManifestEntry,
  upsertManifest,
  restorableSlots,
  forgetWindow,
  setManifestFocused,
  frameworkScopedKey,
  type WindowSnapshot,
  type WindowManifest,
} from "./windowPersistence";

// 이 창의 프레임(논리 px) — manifest rect 기록용. 실패는 rect 생략(복원은 OS 기본 위치).
async function currentFrame(): Promise<
  { x: number; y: number; w: number; h: number } | undefined
> {
  try {
    const win = currentWindow();
    const [pos, size, scale] = await Promise.all([
      win.outerPosition(),
      win.outerSize(),
      win.scaleFactor(),
    ]);
    return {
      x: Math.round(pos.x / scale),
      y: Math.round(pos.y / scale),
      w: Math.round(size.width / scale),
      h: Math.round(size.height / scale),
    };
  } catch {
    return undefined;
  }
}

// core ns data-change → coreStore 가 기대하는 (key)=>void. kv 키는 페이로드 id 필드.
function coreOnDataChange(cb: (key: string) => void): () => void {
  return safeListen<{ ns: string; id: string | null; op?: string }>("data-change", (e) => {
    // 도착을 먼저 센다 — 이 창이 안 쓰는 ns 의 알림도 **경로가 산 증거**다. 거르고 나서 세면
    // "안 왔다"와 "왔는데 내 것이 아니었다"가 같아 보인다(A22 알림 축).
    noteDataChange(e.payload.ns, e.payload.op ?? "");
    if (e.payload.ns === "core" && e.payload.id) cb(e.payload.id);
  });
}

// core kv 저장 의존성(invoke/data-change/ls) — viewLabels 등 다른 core 영속 상태도 공유.
export const coreStoreDeps = {
  invoke: (cmd: string, args: Record<string, unknown>) => invoke(cmd, args),
  onDataChange: coreOnDataChange,
  localStorage: window.localStorage,
};

const EMPTY_WINDOW: WindowSnapshot = { activeId: "", projects: [] };
const EMPTY_MANIFEST: WindowManifest = { slots: [] };

function debounce<A extends unknown[]>(
  fn: (...a: A) => void,
  ms: number,
): (...a: A) => void {
  let h: ReturnType<typeof setTimeout> | null = null;
  return (...a: A) => {
    if (h) clearTimeout(h);
    h = setTimeout(() => fn(...a), ms);
  };
}

// 부트 1회. 복원 성공 시 true(호출부는 bootstrap 생략), 없으면 false(호출부 폴백).
export async function initWorkspacePersistence(
): Promise<boolean> {
  const label = currentWindowLabel();
  const winStore = makeCoreStore<WindowSnapshot>({
    key: `window/${label}`,
    lsKey: `soksak.window.${label}`,
    fallback: EMPTY_WINDOW,
    ...coreStoreDeps,
  });
  const manifestStore = makeCoreStore<WindowManifest>({
    key: "windows",
    lsKey: "soksak.windows",
    fallback: EMPTY_MANIFEST,
    ...coreStoreDeps,
  });

  // 복원 경로 관찰면 — 백지/빈 복원은 스냅샷·DOM 으로 원인을 볼 수 없다(boot.error 와
  // 같은 이유). 단계 사실(hydrate 수·드롭 수·결과)을 활동 허브로 발행해 소켓만으로 읽는다.
  const bootFact = (step: string) =>
    void invoke("activity_publish", {
      kind: "boot.step",
      source: "boot",
      payload: bootFactPayload(step),
    }).catch(() => {});

  // 1) 복원
  let restored = false;
  // 복원 전에 **알고 있던 것**의 크기. 이 수가 있는데 하나도 못 살리면 저장을 막는다 —
  // 그때의 빈 상태는 사용자 의도가 아니라 복원 실패의 흔적이다(persistGuard 머리말).
  let snapshotProjects = 0;
  let restoredProjects = 0;
  try {
    const snap = await winStore.hydrate();
    snapshotProjects = snap.projects.length;
    bootFact(`restore:hydrated:${snap.projects.length}`);
    if (snap.projects.length > 0) {
      const { projects, activeId, projections } = restoreWindow(snap, nextSplitIdGen);
      // root 존재 검증 — 부재/무효 root 는 탭을 지우지 않고 rootMissing 으로 격하한다
      // (무단 삭제 금지). 배너가 알리고, 경로가 돌아오면 다음 복원에서 자연 해소.
      await Promise.all(
        projects.map(async (t) => {
          try {
            await validateProjectRoot(t.root);
          } catch {
            t.rootMissing = true;
            console.warn(`[restore] 프로젝트 root 부재 — 격하 탭으로 복원: ${t.root}`);
          }
        }),
      );
      // P6(전역 단일 오픈): 이 창 스냅샷의 root 들을 일괄 점유. 다른 창이 이미 점유한
      // root 의 탭은 이 창에서 드롭한다(같은 프로젝트 중복 창 금지 — 우아한 열화).
      const denied = await claimRoots(projects.map((t) => t.root));
      bootFact(`restore:denied:${denied.size}`);
      const owned = projects
        .filter((t) => !denied.has(t.root))
        // 로드-타임 마이그레이션 — 구 순수 숫자 스페이스 타이틀("3")을 "스페이스 3"(i18n)으로 승격(멱등,
        // 엑셀식 명명으로 스페이스임을 명확히). 사용자가 바꾼 타이틀은 보존(순수 숫자만 대상).
        .map((t) => ({
          ...t,
          spaces: t.spaces.map((c) => ({ ...c, title: migrateSpaceTitle(c.title) })),
        }));
      for (const t of projects) {
        if (denied.has(t.root))
          console.warn(`[P6] 복원 탭 드롭(다른 창 점유): ${t.root}`);
      }
      const active = owned.some((t) => t.id === activeId)
        ? activeId
        : (owned[0]?.id ?? "");
      if (owned.length > 0) {
        // 레일 핀 복원(§4.5·R9) — 추적 sweep 이전 씨딩(main 부트 순서 보장).
        for (const t of owned) {
          const seed = projections[t.id];
          if (seed) useProjection.getState().seedProject(t.id, seed);
        }
        useSessions.getState().restoreProjects(owned, active);
        // 복원은 생성이 아니다(§5 재생≠관찰) — diff 기준점을 지금으로 재씨딩해 복원 델타가
        // project.created(→ 플러그인 git.init 자동 실행 등)로 오인 발화되는 것을 원천 차단.
        reseedSessionsSnapshot();
        // B4 — 복원 hydration: 보이지 않는 복원 뷰의 본문 마운트를 미루고(PTY 동시
        // spawn 분산), idle 체인이 lastActivity 순으로 채운다. 외형은 즉시 전부.
        beginRestoreHydration();
      }
      restoredProjects = useSessions.getState().projects.length;
      restored = restoredProjects > 0;
    }
    bootFact(`restore:done:${restored}`);
  } catch (e) {
    bootFact(`restore:error:${String(e).slice(0, 120)}`);
    console.error("워크스페이스 복원 실패 — 기본 부트로 폴백:", e);
  }
  // 복원 시도 완료(성공·스냅샷 없음·실패 모두) — 이제 스토어가 이 창의 진실이므로
  // webviewGc 의 복구 리부트 보류를 해제한다(webviewGc.ts gcGate 머리말).
  releaseWebviewGcHold();

  // 2) 자동 저장 — 변경마다 디바운스(빠른 연속 변경 1회 저장). pagehide(창 닫힘·앱 종료
  // 직전)에 잔여 기록을 즉시 flush — 디바운스 창(≤400ms) 내 종료의 마지막 변경 유실 방지
  // (coreSync.ts 와 동일 패턴 — B1 정합성: 저장은 종료 시 flush 보장).
  const doPersist = () => {
    const { projects, activeId } = useSessions.getState();
    // 모르는 것으로 아는 것을 덮지 않는다 — 복원이 통째로 실패한 창은 저장하지 않는다.
    // 이 한 줄이 없어서 실측 2026-08-01 에 사용자 워크스페이스가 두 번 지워졌다(10KB → 32B).
    if (!mayPersist({ snapshotProjects, restoredProjects, liveProjects: projects.length })) {
      return;
    }
    const projections: Record<string, { pins: Pins }> = {};
    for (const [pid, e] of Object.entries(useProjection.getState().byProject)) {
      projections[pid] = { pins: e.pins };
    }
    void persistNow(label, projects, activeId, projections, winStore, manifestStore);
  };
  const persist = debounce(doPersist, 400);
  useSessions.subscribe(persist);
  // 핀·seen 변화도 저장 트리거(§4.5) — 같은 디바운스로 coalesce.
  useProjection.subscribe(persist);
  window.addEventListener("pagehide", doPersist);
  // 창 이동/리사이즈도 저장 트리거(B2 rect) — sessions 변화가 아니라 위 구독이 못 잡는다.
  // 네이티브 이벤트 기반(폴링 0), 같은 디바운스로 coalesce.
  void currentWindow().onMoved(persist);
  void currentWindow().onResized(persist);

  return restored;
}

async function persistNow(
  label: string,
  projects: Project[],
  activeId: string,
  projections: Record<string, { pins: Pins }>,
  winStore: ReturnType<typeof makeCoreStore<WindowSnapshot>>,
  manifestStore: ReturnType<typeof makeCoreStore<WindowManifest>>,
): Promise<void> {
  try {
    const snap = snapshotWindow(projects, activeId, projections);
    // 잃는 쓰기 전에 직전 값을 남긴다 — 저장은 덮어쓰기라 이전 값이 그 자리에서 사라지고,
    // 백업 링은 최소 간격이 1시간이라 그 사이는 어디에도 없다(snapshotGeneration 머리말).
    // 원인은 다 막을 수 없으니(크래시·강제종료·앞으로 생길 버그) 되돌릴 자리를 남긴다.
    const prevSnap = await winStore.hydrate().catch(() => null);
    if (losesContent(prevSnap, snap)) {
      await invoke("data_kv_set", {
        ns: "core",
        key: previousGenerationKey(`window/${label}`),
        value: prevSnap,
      }).catch((e) => console.error("직전 세대 보존 실패:", e));
    }
    await winStore.save(snap);
    const manifest = await manifestStore.hydrate();
    // 창 프레임(B2) — 리스폰이 같은 자리·크기로 되살린다(듀얼 모니터 배치 유지).
    const entry = { ...windowManifestEntry(label, projects, activeId), rect: await currentFrame() };
    let next = upsertManifest(manifest, entry);
    // 마지막 포커스 창(B2) — 재시작 후 그 창을 앞으로.
    if (document.hasFocus()) next = setManifestFocused(next, label);
    await manifestStore.save(next);
  } catch (e) {
    console.error("워크스페이스 저장 실패:", e);
  }
}

// 멀티윈도우 리스폰(B2) — main 창 부트가 1회 호출: manifest 의 다른 slot 창들을 라벨 그대로
// 되살린다(각 창은 자기 스냅샷을 스스로 복원). 스냅샷 없는 유령 slot(B1 이전 잔재·수동 삭제)은
// 건너뛰고 manifest 에서 정리한다. 스폰이 포커스를 차례로 뺏으므로, 마지막에 focusedLabel 을
// 1회 포커스해 사용자가 마지막으로 보던 창이 앞으로 온다.
export async function respawnSavedWindows(): Promise<void> {
  if (currentWindowLabel() !== "main") return; // 리스폰 소유자는 main 부트 하나(멱등 가드)
  const manifestStore = makeCoreStore<WindowManifest>({
    key: "windows",
    lsKey: "soksak.windows",
    fallback: EMPTY_MANIFEST,
    ...coreStoreDeps,
  });
  // 복원 경로의 관찰면 — "창이 안 열렸다"는 결과만으로는 장부가 빈 것인지, 점유를 못 읽은
  // 것인지, 스냅샷이 없는 것인지 가릴 수 없다. 셋은 서로 다른 결함이고 고치는 자리도 다르다.
  const respawnFact = (step: string) =>
    void invoke("activity_publish", {
      kind: "boot.step",
      source: "boot",
      payload: bootFactPayload(step),
    }).catch(() => {});

  try {
    let manifest = await manifestStore.hydrate();
    let pruned = false;
    // 점유는 **모든 호스트**의 사실이라 cored 에게 묻는다 — 자기 프로세스만 세면 상대
    // 프레임워크가 든 창을 "없다"고 읽고 같은 라벨을 또 만든다(restorableSlots 머리말).
    // 못 물으면 되살리지 않는다: 안 여는 것은 다음 부팅에 회복되지만 겹쳐 만든 창은 남는다.
    const live = await liveWindowLabels();
    const slots = restorableSlots(manifest, live);
    respawnFact(
      `respawn:slots:${manifest.slots.length}:live:${live === null ? "unknown" : live.size}:restorable:${slots.length}`,
    );
    for (const slot of slots) {
      const snapStore = makeCoreStore<WindowSnapshot>({
        key: `window/${slot.label}`,
        lsKey: `soksak.window.${slot.label}`,
        fallback: EMPTY_WINDOW,
        ...coreStoreDeps,
      });
      const snap = await snapStore.hydrate();
      if (snap.projects.length === 0) {
        manifest = upsertManifest(manifest, { ...slot, roots: [] }); // slot 제거
        pruned = true;
        respawnFact(`respawn:ghost:${slot.label}`);
        console.warn(`[restore] 유령 slot 정리(스냅샷 없음): ${slot.label}`);
        continue;
      }
      // 창 라벨 불변식(NAMING 4b) — 런타임 창은 w-<uuid> 뿐이다. 다른 라벨은 capability 밖이라
      // 스폰하면 귀머거리 창(전 명령 TIMEOUT)이 된다. 스폰을 거부하고 데이터는 건드리지 않는다
      // — 구세대 데이터 교정은 일회용 마이그레이션(scripts/migrations/20260704-window-label-uuid.sh).
      if (!slot.label.startsWith("w-")) {
        console.error(
          `[restore] 구세대 라벨 slot 스폰 거부: ${slot.label} — ` +
            `scripts/migrations/20260704-window-label-uuid.sh 실행 필요(NAMING 4b)`,
        );
        continue;
      }
      await invoke("window_create", {
        label: slot.label,
        rect: slot.rect ?? null,
        // 백그라운드 복원 — 포커스를 뺏지 않는다. 오케스트레이터를 열면 오케스트레이터가 포커스를
        // 유지하고, 복원된 워크스페이스 창들은 뒤에 되살아난다(임의 포커스 이동 금지, 자연스러운 동작).
        focus: false,
      })
        .then(() => respawnFact(`respawn:spawned:${slot.label}`))
        .catch((e) => {
          respawnFact(`respawn:failed:${slot.label}:${String(e).slice(0, 80)}`);
          console.error(`창 리스폰 실패(${slot.label}):`, e);
        });
    }
    if (pruned) await manifestStore.save(manifest);
    // 복원은 포커스를 옮기지 않는다 — 직전 포커스 창으로 강제 이동하던 로직 제거. 부팅 시 활성 창
    // (오케스트레이터 등)이 그대로 유지된다. 사용자가 원하면 창 목록의 포커스 아이콘으로 부른다.
    // 첫 실행(리스폰할 워크스페이스 slot 0 + 최근 프로젝트 0) — 기본 프로젝트 워크스페이스 창을
    // 하나 연다. 사용자가 창을 전부 닫아둔 경우(recents 존재)는 존중해 아무것도 열지 않는다.
    const hasSlots = manifest.slots.some((s) => s.label !== "main");
    if (!hasSlots) {
      const recents = await listRecentProjects().catch(() => []);
      if (recents.length === 0) {
        try {
          const root = await ensureDefaultProjectRoot("project1");
          await invoke("window_create", { init: `root=${encodeURIComponent(root)}` });
        } catch (e) {
          console.error("첫 실행 기본 워크스페이스 생성 실패:", e);
        }
      }
    }
  } catch (e) {
    respawnFact(`respawn:error:${String(e).slice(0, 100)}`);
    console.error("멀티윈도우 리스폰 실패:", e);
  }
}

/**
 * 지금 살아 있는 창 라벨 — **모든 호스트의 것**. 못 읽으면 null.
 *
 * 자기 프로세스의 창 목록으로는 답이 안 된다: 상대 프레임워크가 든 창이 안 보이고, 안 보이는
 * 창은 "없다"로 읽혀 같은 라벨이 두 번 만들어진다. cored 는 붙은 호스트를 전부 알고, 라벨마다
 * 그 라벨을 든 호스트 수를 답한다.
 *
 * 실패를 빈 집합으로 뭉개지 않는다 — 빈 집합은 "아무도 안 들었다"라서 전부 되살리게 된다.
 */
async function liveWindowLabels(): Promise<Set<string> | null> {
  try {
    const r = await invoke<{ windows?: { label?: string }[] }>("window_census");
    const rows = r?.windows;
    if (!Array.isArray(rows)) return null;
    return new Set(rows.map((w) => w?.label).filter((l): l is string => typeof l === "string"));
  } catch (e) {
    console.error("창 점유 조회 실패 — 복원을 건너뛴다:", e);
    return null;
  }
}

/**
 * 창을 장부에서 지운다 — `window.close` 명령이 부른다.
 *
 * 닫기가 창만 없애고 장부를 안 고치면 다음 부팅이 그 창을 되살린다. 종료 경로에서는 부르지
 * 않는다: 종료도 창을 전부 닫지만 그때 장부를 비우면 다음 실행에 아무것도 안 열린다.
 */
export async function forgetWindowSlot(label: string): Promise<void> {
  const manifestStore = makeCoreStore<WindowManifest>({
    key: "windows",
    lsKey: "soksak.windows",
    fallback: EMPTY_MANIFEST,
    ...coreStoreDeps,
  });
  try {
    const manifest = await manifestStore.hydrate();
    const next = forgetWindow(manifest, label);
    if (next !== manifest) await manifestStore.save(next);
  } catch (e) {
    console.error(`창 slot 정리 실패(${label}):`, e);
  }
}

// 컨트롤 플레인(main) 프레임 영속 — 워크스페이스 manifest 와 분리된 자체 키. main 은 워크스페이스
// 스냅샷을 갖지 않으므로(오케스트레이터 전용) 프레임만 기억한다. 이동/리사이즈는 디바운스 저장.
//
// 키는 프레임워크를 싣는다(frameworkScopedKey) — 공유하면 두 프레임워크의 컨트롤 플레인 창이
// 같은 자리에 겹쳐 뜬다. 옛 키(프레임워크 없음)는 첫 부팅이 읽어 자기 키로 옮긴다.
export async function initControlPlaneFrame(): Promise<void> {
  type Frame = { x: number; y: number; w: number; h: number } | null;
  const key = frameworkScopedKey("controlPlaneFrame", frameworkName);
  const store = makeCoreStore<Frame>({
    key,
    lsKey: `soksak.${key}`,
    fallback: null,
    ...coreStoreDeps,
  });
  const legacyStore = makeCoreStore<Frame>({
    key: "controlPlaneFrame",
    lsKey: "soksak.controlPlaneFrame",
    fallback: null,
    ...coreStoreDeps,
  });
  try {
    // 내 키가 비었으면 옛 키를 입양한다 — 이 변경 한 번에 창 자리가 초기화되지 않는다.
    const rect = (await store.hydrate()) ?? (await legacyStore.hydrate().catch(() => null));
    if (rect) {
      const win = currentWindow();
      await win.setPosition(rect.x, rect.y).catch(() => {});
      await win.setSize(rect.w, rect.h).catch(() => {});
    }
  } catch (e) {
    console.error("컨트롤 플레인 프레임 복원 실패:", e);
  }
  const persist = debounce(() => {
    void currentFrame().then((f) => f && store.save(f));
  }, 400);
  void currentWindow().onMoved(persist);
  void currentWindow().onResized(persist);
}
