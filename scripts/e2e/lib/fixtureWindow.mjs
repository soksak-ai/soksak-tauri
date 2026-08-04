// 픽스처 창의 주인은 **루트 경로**다 — 한자리에서 확보하고 한 규칙으로 회수한다.
//
// RED 근거(실측 2026-07-28): rail-border 가 자기 창을 못 알아보고 "픽스처 창 확보 실패"로
// 멈췄다. 회수 판단을 state.tree 에 물었기 때문이다 — 그건 **창-지역 렌더러 상태**라,
// 정작 새는 창(렌더러가 굳은 창)은 그 질문에 답하지 못한다. 답하지 못하니 회수 대상에서
// 빠지고, 빠지니 다음 판이 새 창을 연다. 같은 자리에 창 21 개가 겹쳐 쌓여 있었다(실측).
//
// 소유는 창-지역 상태가 아니라 **프로세스 전역 장부**가 안다: window.projects 는 어느 창이
// 어느 루트를 들고 있는지 한 벌로 답한다(카탈로그 원문 — "Same answer from any window").
// 그 지도만 본다. 그러면 렌더러 생사와 무관하게 늘 같은 답이 나온다 = 멱등.
//
// 남의 창 불가침: 루트가 **정확히** 우리 픽스처일 때만 만진다. "앞서 목록에 있었느냐"로
// 가르지 마라 — 그 기준은 앞 판이 두고 간 우리 창까지 남의 것으로 만들어 회수를 막는다
// (그게 위 21 개를 만든 규칙이다).

import { resolveControlWindow, sleep } from "./client.mjs";

/** 봉투든 알맹이든 data 만 꺼낸다. */
const body = (r) => (r && typeof r === "object" && "data" in r ? (r.data ?? {}) : (r ?? {}));

/** 지도에서 이 루트를 든 창. 없으면 null. 순수 함수 — 지도만 보고 판단한다. */
export function windowForRoot(projects, root) {
  const want = String(root);
  for (const p of projects ?? []) {
    if (String(p?.root ?? "") === want) return String(p.window);
  }
  return null;
}

/**
 * 지도에서 **픽스처만 든** 창 전부. 픽스처 밭 통째 회수용.
 *
 * 판정은 "이 창에 픽스처가 있는가" 가 아니라 **"이 창이 픽스처뿐인가"** 다. 창은 프로젝트를
 * 여럿 들고, 그중 하나가 픽스처라고 창을 닫으면 같은 창에 있던 사용자 프로젝트가 함께 닫힌다.
 *
 * RED 근거(실측 2026-08-01): 사용자 창 하나가 core + 픽스처 둘을 들고 있었다. 회수가 그 창을
 * 픽스처 창으로 보고 닫았고 스냅샷 키까지 지웠다 — 백업에서 되살렸다.
 *
 * 같은 창은 한 번만 돌려준다. 두 번 돌려주면 이미 닫힌 창을 또 닫고, 그 실패는 조용하다.
 */
export function windowsUnder(projects, dir) {
  const prefix = String(dir).replace(/\/+$/, "") + "/";
  const byWindow = new Map();
  for (const p of projects ?? []) {
    const label = String(p?.window ?? "");
    const root = String(p?.root ?? "");
    const seen = byWindow.get(label) ?? { label, root, all: true };
    if (!root.startsWith(prefix)) seen.all = false;
    else if (!seen.root.startsWith(prefix)) seen.root = root;
    byWindow.set(label, seen);
  }
  return [...byWindow.values()]
    .filter((w) => w.all && w.label)
    .map((w) => ({ label: w.label, root: w.root }));
}

/**
 * 지도에서 루트 **이름**이 이 접두사로 시작하는 창 전부.
 *
 * 임시 디렉터리에 난 픽스처는 밭이 공용이라(os.tmpdir) 디렉터리로 가를 수 없다 — 그 밭째
 * 걷으면 남의 것을 닫는다. 이름 규약(`soksak-e2e-*`)이 우리 것임을 말하는 유일한 표식이다.
 */
export function windowsNamed(projects, prefix) {
  // windowsUnder 와 같은 판정이다: 이 창이 **픽스처뿐일 때만** 고른다. 하나라도 밖에 있으면
  // 사용자의 창이고, 닫으면 같은 창에 있던 사용자 프로젝트가 함께 닫힌다.
  const named = (root) => {
    const base = root.slice(root.replace(/\/+$/, "").lastIndexOf("/") + 1);
    return base.startsWith(prefix);
  };
  const byWindow = new Map();
  for (const p of projects ?? []) {
    const label = String(p?.window ?? "");
    const root = String(p?.root ?? "");
    const seen = byWindow.get(label) ?? { label, root, all: true };
    if (!named(root)) seen.all = false;
    else if (!named(seen.root)) seen.root = root;
    byWindow.set(label, seen);
  }
  return [...byWindow.values()]
    .filter((w) => w.all && w.label)
    .map((w) => ({ label: w.label, root: w.root }));
}

/**
 * 프로젝트를 하나도 들지 않은 워크스페이스 창 — 창 생성 검사가 두고 간 빈 껍데기.
 *
 * 이건 **기본 회수 대상이 아니다.** 사용자도 프로젝트를 열기 전 빈 창을 띄울 수 있고, 그 창을
 * 닫는 것은 사용자 창 침범이다. 부를 때 명시적으로 골라야 한다(reclaim --empty).
 */
export function emptyWorkspaceWindows(labels, projects) {
  const held = new Set((projects ?? []).map((p) => String(p?.window ?? "")));
  return (labels ?? []).map(String).filter((l) => l.startsWith("w-") && !held.has(l));
}

/** 창→프로젝트 지도. 컨트롤 창에 묻는다(어느 창에서 물어도 같은 답). */
export async function projectMap(rpc, ctrl) {
  const at = ctrl ?? (await resolveControlWindow(rpc));
  return body(await rpc("window.projects", {}, at)).projects ?? [];
}

/**
 * 이 루트의 픽스처 창을 확보한다 — 있으면 물려받고, 없으면 연다. 멱등.
 *
 * 물려받은 창이 답하지 못하면(렌더러가 굳은 창) 닫고 다시 연다. 굳은 창을 그대로 쓰면
 * 판정이 아니라 타임아웃이 나오고, 그 타임아웃은 결함처럼 보이지 않는다.
 */
export async function acquireFixtureWindow(rpc, root, opts = {}) {
  const probe = opts.probe ?? ((label) => rpc("state.tree", {}, label));
  const ctrl = opts.ctrl ?? (await resolveControlWindow(rpc));

  const adopted = windowForRoot(await projectMap(rpc, ctrl), root);
  if (adopted) {
    const alive = await Promise.resolve(probe(adopted))
      .then((r) => r?.ok !== false)
      .catch(() => false);
    if (alive) return { label: adopted, adopted: true };
    await rpc("window.close", { label: adopted }, ctrl).catch(() => {});
    await sleep(opts.settleMs ?? 500);
  }

  // 시각 검증은 포커스 상태가 아니라 화면을 측정한다. 새 창·기존 창 모두 뒤에서
  // 제어할 수 있으므로 사용자의 현재 앱을 활성화할 권한이 없다.
  const opened = body(await rpc("window.open", { root, focus: false }, ctrl));
  const label = opened.label ?? opened.existingWindow;
  if (typeof label !== "string" || !label.startsWith("w-")) {
    throw new Error(`픽스처 창 확보 실패 — ${JSON.stringify(opened).slice(0, 140)}`);
  }
  // 장부로 확인한다: 그 라벨이 **우리 루트**를 든 창이라고 장부가 말해야 우리 창이다.
  // 라벨만 믿으면 남의 창을 우리 것으로 오인할 수 있고, 그 오염은 되돌릴 수 없다.
  for (let i = 0; i < (opts.confirmTries ?? 10); i += 1) {
    if (windowForRoot(await projectMap(rpc, ctrl), root) === label) {
      return { label, adopted: false };
    }
    await sleep(opts.settleMs ?? 500);
  }
  throw new Error(`창 ${label} 이 ${root} 를 든다고 장부가 말하지 않는다 — 오염 방지로 중단`);
}

/** 이 루트의 픽스처 창을 회수한다. 없으면 아무 일도 하지 않는다(멱등). */
export async function releaseFixtureWindow(rpc, root, opts = {}) {
  const ctrl = opts.ctrl ?? (await resolveControlWindow(rpc));
  const label = windowForRoot(await projectMap(rpc, ctrl), root);
  if (label) await rpc("window.close", { label }, ctrl).catch(() => {});
  return label;
}

/** 이 디렉터리 아래 픽스처 창을 전부 회수한다 — 앞 판들이 두고 간 것까지. 멱등. */
export async function releaseFixtureWindowsUnder(rpc, dir, opts = {}) {
  const ctrl = opts.ctrl ?? (await resolveControlWindow(rpc));
  return closeAll(rpc, ctrl, windowsUnder(await projectMap(rpc, ctrl), dir), opts);
}

/** 루트 이름이 이 접두사인 픽스처 창을 전부 회수한다(공용 임시 밭용). 멱등. */
export async function releaseFixtureWindowsNamed(rpc, prefix, opts = {}) {
  const ctrl = opts.ctrl ?? (await resolveControlWindow(rpc));
  return closeAll(rpc, ctrl, windowsNamed(await projectMap(rpc, ctrl), prefix), opts);
}

async function closeAll(rpc, ctrl, found, opts) {
  for (const w of found) {
    await rpc("window.close", { label: w.label }, ctrl).catch(() => {});
    await sleep(opts.settleMs ?? 150);
    // 창을 닫는 것으로 끝나지 않는다 — 그 창이 **저장소에 남긴 것**까지가 이 픽스처의 것이다.
    await forgetFixtureData(rpc, ctrl, w);
  }
  return found;
}

/**
 * 픽스처가 저장소에 남긴 것을 거둔다 — **회수는 화면만이 아니다.**
 *
 * RED 근거(실측 2026-08-01): 하니스들이 창은 닫고 나갔지만 스냅샷 키(`window/<label>`)와 최근
 * 프로젝트 항목은 그대로 남았다. 사용자 홈에 유령 창 스냅샷 7개가 쌓였고, 최근 목록 20칸 중
 * 19칸을 픽스처가 차지해 **사용자의 실제 프로젝트가 목록 밖으로 밀려났다**(RECENT_CAP=20).
 * 화면에서 사라진 것과 저장소에서 사라진 것은 다른 사실이다.
 *
 * 못 지운 것은 조용히 넘기지 않는다 — 남은 것이 있으면 다음 판이 같은 자리에서 다시 만난다.
 */
export async function forgetFixtureData(rpc, ctrl, w) {
  const gone = { key: false, recent: false };
  if (w.label) {
    const r = await rpc("data.kv.delete", { ns: "core", key: `window/${w.label}` }, ctrl).catch(() => null);
    gone.key = r?.ok !== false;
    // 직전 세대도 이 창의 것이다 — 남기면 되돌릴 대상 없는 세대만 쌓인다.
    await rpc("data.kv.delete", { ns: "core", key: `window/${w.label}#prev` }, ctrl).catch(() => {});
  }
  if (w.root) {
    const r = await rpc("project.recent.remove", { root: w.root }, ctrl).catch(() => null);
    gone.recent = r?.ok !== false;
  }
  return gone;
}
