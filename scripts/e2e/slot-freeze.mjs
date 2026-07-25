// 슬롯 동결(§4.6) E2E — 코어 이동-동결 엔진이 실행 중 앱에서 완주하는지 소켓으로 자가 검증한다.
// 멱등: 전용 임시 root 창 안에서만 동작(사용자 워크스페이스 무접촉), 끝에 창을 닫는다.
//
// 실행: SOKSAK_SOCKET=~/.soksak-dev/com.soksak.dev.sock node scripts/e2e/slot-freeze.mjs
//
// 검증:
//   1) 정착 선캡처 — 브라우저(홀) 뷰 정착 후 슬롯 dataset.freezeSnapAt 이 선다
//   2) 동결 사이클 — 뷰 교차 활성(move 위상)에 freeze 가 "0" 으로 남는다(동결→해동 완주)
//   3) 재캡처 — 사이클 뒤 freezeSnapAt 이 전진한다(착지 정착 에지가 다음 스냅을 굽는다)
//   4) 포커스 보존 — 포커스 인/아웃 양쪽에서 슬롯 영역 스냅샷이 블랭크가 아니다
//      (백지 판정 휴리스틱: 렌더된 영역의 PNG base64 는 블랭크보다 뚜렷이 크다)
//   6) 해 == 관측 — layout.arrangement 의 답이 실측(ui.measure)과 같다
//   7) 복도 계약 — 무관 포커스 변화의 허용 변화는 레일 복도의 railW 평행이동 하나뿐
//      (가로지른 패널만 정확히 railW, 폭·y 불변, 가로지르지 않은 패널 0)
//   8) 착지 일치 — 네이티브 child 이동량 == 슬롯 이동량(위상 중 표면 무이동 + 착지 1회의 결과)
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const SOCKET =
  process.env.SOKSAK_SOCKET ||
  path.join(os.homedir(), ".soksak-debug", "com.soksak.debug.sock");
// 픽스처 루트 — 고정 경로 재사용(멱등, /tmp 금지 규율). 창 폐쇄가 회수를 담당한다.
const FIXTURE_ROOT = path.join(os.homedir(), ".soksak-e2e", "slot-freeze");

let sock;
let seq = 0;
const pending = new Map();
let rbuf = "";
function connect() {
  return new Promise((resolve, reject) => {
    sock = net.createConnection(SOCKET);
    sock.setNoDelay(true);
    sock.once("connect", resolve);
    sock.once("error", reject);
    sock.on("data", (d) => {
      rbuf += d.toString("utf8");
      let i;
      while ((i = rbuf.indexOf("\n")) >= 0) {
        const line = rbuf.slice(0, i);
        rbuf = rbuf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          p(msg);
        }
      }
    });
  });
}
// 요청 봉투(MESSAGE-PROTOCOL·multiwindow.mjs 와 동형): { id, method, params, window? }.
function rpc(method, params = {}, window) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, resolve);
    const req = { id, method, params };
    if (window) req.window = window;
    sock.write(`${JSON.stringify(req)}\n`);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`TIMEOUT ${method}`));
      }
    }, 15000);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pollUntilGentle(label, deadlineMs, intervalMs, fn) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > deadlineMs) throw new Error(`시한 초과: ${label}`);
    await sleep(intervalMs);
  }
}
async function pollUntil(label, deadlineMs, fn) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > deadlineMs) throw new Error(`시한 초과: ${label}`);
    await sleep(300);
  }
}
let failures = 0;
function assert(name, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function main() {
  // 전역 워치독 — 어떤 단계가 행이어도 유한 종료(멱등 재실행 가능).
  setTimeout(() => {
    console.error("✗ slot-freeze E2E 워치독(90s) — 행 감지, 중단");
    process.exit(1);
  }, 90_000).unref?.();
  await connect();
  console.log(`소켓 연결: ${SOCKET}`);

  // ── 픽스처: 전용 임시 root 창 + 브라우저(홀 뷰) + 터미널(교차 활성 상대) ──
  console.log(`픽스처 창 열기: ${FIXTURE_ROOT}`);
  const opened = await rpc("window.open", { root: FIXTURE_ROOT });
  if (!opened.ok) throw new Error(`window.open 실패: ${opened.message}`);
  const win = opened.data?.label ?? opened.data?.existingWindow;
  if (!win) throw new Error("창 label 없음");

  // 새 창의 플러그인 적재는 비동기 — 프로그램 목록에 브라우저가 설 때까지 대기한다.
  await pollUntil("browser 프로그램 적재", 20000, async () => {
    const progs = await rpc("program.list", {}, win);
    const ids = (progs.data?.programs ?? []).map((p) => p.id);
    return ids.includes("browser") ? true : null;
  });

  try {
  // 픽스처 루트의 영속 상태는 지난 실행이 남긴 것이다 — 패널이 없는 스페이스로 복원될 수
  // 있으므로(중단된 실행의 잔재) 쓸 수 있는 평면을 보장한다. 멱등: 이미 패널이 있으면 무동작.
  const panels = await rpc("panel.list", {}, win);
  if (!panels.ok || !(panels.data?.panels ?? []).length) {
    const made = await rpc("space.create", {}, win);
    if (!made.ok) throw new Error(`스페이스 생성 실패: ${made.message}`);
    await sleep(400);
  }
  const bv = await rpc("view.open", { program: "browser" }, win);
  if (!bv.ok) throw new Error(`browser view.open 실패: ${bv.message}`);
  const browserView = bv.data?.viewId;
  // 명시 URL 항행 + 로드 신원 검증 — 기본 홈페이지에 기대지 않는다. 픽셀 판정은 "알려진
  // 페이지가 실제로 로드됐다"가 전제될 때만 의미가 있다(빈 페이지를 빈 페이지 하한으로
  // 통과시키는 검사는 검사가 아니다).
  // webview 준비 대기 — 생성 완료 전 navigate 는 유실/파손 레이스다(조기 항행 함정).
  // 기본 홈(example.com)의 h1 이 읽히면 웹뷰·페이지 파이프라인 전체가 준비된 것이다.
  // 준비 신호는 비침습이어야 한다 — dom.* 는 페이지에 JS 를 주입하므로 초기 로드와 경합해
  // 로드 자체를 죽인다(실측: 폴링한 창만 <body> 빈 문서로 남음 — 감시가 대상을 파괴).
  // 뷰 타이틀은 플러그인이 코어에 올리는 이벤트라 페이지 무접촉이다.
  // 생성 정착 대기(고정 4s — 조기 dom 프로브는 초기 로드를 죽인다: 300ms 폴링에 body 가
  // 영영 빈 문서로 남던 실측) 후 명시 항행, 2s 간격의 완만한 프로브로 신원을 단언한다.
  await sleep(4000);
  await rpc("plugin.soksak-plugin-browser-native.navigate", { url: "https://example.com/" }, win);
  await sleep(2000);
  await pollUntilGentle("example.com 로드(h1 텍스트)", 20000, 2000, async () => {
    const q = await rpc("plugin.soksak-plugin-browser-native.dom.text", { selector: "h1" }, win);
    const txt = JSON.stringify(q.data ?? "");
    return txt.includes("Example Domain") ? true : null;
  });
  console.log("✓ 페이지 신원 — example.com h1 확인");
  // 터미널 프로그램 적재 대기 — 브라우저만 기다리고 분할하면 뷰 없는 빈 패널이 생겨
  // 이후 활성 전환이 INVALID_PARAMS 로 떨어진다(하니스 레이스, 실측).
  // 교차 활성 상대의 program id 는 목록에서 해소한다 — "terminal" 은 등록 id 가 아니라
  // 엔진 별칭이고, 미등록 id 는 계약대로 빈 패널(뷰 없음)을 만든다. 그러면 이후 활성 전환이
  // INVALID_PARAMS 로 떨어져 위상이 아예 서지 않는다(실측 — 하니스가 낡아 있었다).
  const termProgram = await pollUntil("terminal 엔진 program id", 20000, async () => {
    const progs = await rpc("program.list", {}, win);
    const ids = (progs.data?.programs ?? []).map((p) => p.id);
    return ids.find((id) => id.startsWith("terminal-")) ?? null;
  });
  const tv = await rpc("panel.split", { side: "right", program: termProgram }, win);
  if (!tv.ok) throw new Error(`panel.split 실패: ${tv.message}`);
  const termView = tv.data?.viewId;
  if (!termView) throw new Error(`분할이 뷰를 만들지 못함: ${JSON.stringify(tv.data)}`);
  // 분할 응답은 착지한 배치를 싣는다 — 변경 직후 퍼즐이 이미 풀려 있다는 계약.
  assert(
    "분할 응답에 배치 동봉(station·cleanLines)",
    Number.isFinite(tv.data?.arrangement?.station) &&
      Array.isArray(tv.data?.arrangement?.cleanLines),
    JSON.stringify(tv.data?.arrangement ?? null),
  );
  // 배치를 명시한다 — 픽스처 루트에 영속된 옛 PIN 에 기대면 게이트가 환경에 따라 갈린다.
  const flowSet = await rpc("sidebar.left.position", { mode: "flow" }, win);
  assert(
    "레일 배치 = flow(포커스 추종)",
    flowSet.data?.leftRailPosition?.mode === "flow",
    JSON.stringify(flowSet.data?.leftRailPosition ?? flowSet.message),
  );
  const slotAddr = `win/${win}/chrome/layout/slot/${browserView}`;

  const measure = async () => {
    const m = await rpc("ui.measure", { address: slotAddr }, win);
    return m.ok ? m.data : null;
  };

  // 1) 정착 선캡처 — 청정(스팟) 슬롯만 구워진다(dim 슬롯 skip 정책). 분할 직후엔 터미널이
  // 활성이라 브라우저 슬롯이 dim — 실사용처럼 브라우저를 먼저 활성해 스팟 상태에서 기다린다.
  await rpc("view.activate", { view: browserView }, win);
  const settled = await pollUntil("정착 스냅(freezeSnapAt)", 15000, async () => {
    const d = await measure();
    return d?.dataset?.freezeSnapAt ? d : null;
  });
  const snapAt0 = Number(settled.dataset.freezeSnapAt);
  assert("정착 선캡처 — freezeSnapAt 존재", Number.isFinite(snapAt0), String(snapAt0));

  // 2) 동결 사이클 — 교차 활성이 move 위상을 태우고, 착지에서 해동돼 있어야 한다.
  // 위상이 서지 않으면 원인을 즉시 판독할 수 있게 계기를 찍는다: 해(station)가 실제로
  // 바뀌었는지, 그리드가 주행 위상에 들어갔는지, 슬롯이 동결 대상이었는지.
  {
    const spaceId = (await rpc("state.tree", {}, win)).data?.projects?.[0]?.activeSpaceId;
    const before = await rpc("layout.arrangement", {}, win);
    const act = await rpc("view.activate", { view: termView }, win);
    console.log(
      `  활성 전환: ok=${act.ok} code=${act.code} data=${JSON.stringify(act.data ?? null)} ` +
        `before.cells=${JSON.stringify(before.data?.cells?.map((c) => [c.id, c.rect.left]))} ` +
        `activePanel=${JSON.stringify((await rpc("panel.list", {}, win)).data?.activePanelId)}`,
    );
    const probes = [];
    for (let i = 0; i < 12; i++) {
      const grid = await rpc("ui.measure", { address: `win/${win}/chrome/layout/grid/${spaceId}` }, win);
      const slot = await measure();
      probes.push({
        t: i,
        traveling: grid.data?.dataset?.traveling,
        freeze: slot?.dataset?.freeze,
        scope: slot?.dataset?.freezeScope,
        x: slot?.rect?.x,
      });
      if (probes.at(-1).freeze === "1") break;
      await sleep(60);
    }
    const after = await rpc("layout.arrangement", {}, win);
    console.log(
      `  계기: station ${before.data?.station} → ${after.data?.station} · ` +
        probes.map((q) => `${q.t}:trav=${q.traveling},frz=${q.freeze ?? "-"},x=${q.x}`).join(" | "),
    );
  }
  await sleep(700);
  await rpc("view.activate", { view: browserView }, win);
  const cycled = await pollUntil("동결 사이클(freeze=0)", 10000, async () => {
    const d = await measure();
    return d?.dataset?.freeze === "0" ? d : null;
  });
  assert("동결 사이클 — 동결→해동 완주(freeze=0)", cycled.dataset.freeze === "0");

  // 3) 재캡처 — 착지 정착 에지가 다음 스냅을 굽는다(freezeSnapAt 전진).
  const recaptured = await pollUntil("착지 재캡처(freezeSnapAt 전진)", 10000, async () => {
    const d = await measure();
    return Number(d?.dataset?.freezeSnapAt) > snapAt0 ? d : null;
  });
  assert(
    "착지 재캡처 — freezeSnapAt 전진",
    Number(recaptured.dataset.freezeSnapAt) > snapAt0,
    `${snapAt0} → ${recaptured.dataset.freezeSnapAt}`,
  );

  // 4) 포커스 보존 — 포커스 인/아웃 양쪽에서 슬롯 영역이 렌더되어 있다(블랭크 금지).
  // 블랭크(단색) 영역의 PNG 는 ~2KB 로 붕괴한다 — 렌더 하한은 그보다 뚜렷이 위, dim 압축
  // (어두워지면 몇 % 줄어든다)은 통과할 만큼 아래로 잡는다. 추가로 인/아웃 비율을 묶어
  // "포커스 아웃에서만 내용이 사라지는" 퇴행을 잡는다.
  const BLANK_FLOOR = 4_000;
  const slotShot = async () => {
    const d = await measure();
    const r = d?.rect;
    if (!r) return 0;
    const s = await rpc(
      "window.snapshot",
      { rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }, base64: true },
      win,
    );
    return (s.media?.base64 ?? "").length; // media 는 봉투 예약키(최상위) — data 아님
  };
  // 단일 사이클이 아니라 반복 사이클 뒤에 판정한다 — hide→show 를 여러 번 겪은 WKWebView 가
  // 뷰어빌리티를 잃고 빈 레이어로 잠드는 회귀(실사고)는 반복 후에만 드러난다.
  for (let i = 0; i < 3; i++) {
    await rpc("view.activate", { view: termView }, win);
    await sleep(500);
    await rpc("view.activate", { view: browserView }, win);
    await sleep(700);
  }
  const focusedLen = await slotShot();
  await rpc("view.activate", { view: termView }, win);
  await sleep(600);
  const unfocusedLen = await slotShot();
  const alive = await rpc("plugin.soksak-plugin-browser-native.dom.text", { selector: "h1" }, win);
  assert(
    "포커스 보존 — 사이클 후 페이지 신원 유지(h1)",
    JSON.stringify(alive.data ?? "").includes("Example Domain"),
  );
  assert("포커스 보존 — 포커스 시 렌더", focusedLen > BLANK_FLOOR, `len=${focusedLen}`);
  assert("포커스 보존 — 포커스 아웃 시 렌더", unfocusedLen > BLANK_FLOOR, `len=${unfocusedLen}`);
  assert(
    "포커스 보존 — 인/아웃 내용 등가(비율)",
    unfocusedLen > focusedLen * 0.3,
    `${unfocusedLen}/${focusedLen}`,
  );

    // 5) 홀 페인트 게이트 — 홀-슬롯은 어떤 pane 스타일에서도 스스로 배경을 칠하지 않는다.
  // RED 근거(실사고): pane-style 배경 규칙이 홀 투명 규칙을 특이성으로 이겨 card/floating
  // 에서 모든 홀이 닫혔다(포커스 시 블랭크로 위장). ui.hit painters 가 슬롯을 지목하면 RED.
  {
    const d0 = await measure();
    const r0 = d0?.rect;
    if (r0) {
      const cx = Math.round(r0.x + r0.w / 2);
      const cy = Math.round(r0.y + r0.h / 2);
      await rpc("view.activate", { view: browserView }, win);
      await sleep(400);
      // pane 스타일은 테마 소유(설정 축 아님) — 현재 활성 스타일 하에서 단언한다.
      // 계약은 스타일 무관("홀은 표면 종류의 사실")이므로 어떤 테마에서 돌아도 유효하다.
      const hit = await rpc("ui.hit", { x: cx, y: cy }, win);
      const painters = hit.data?.painters ?? [];
      const slotPaints = painters.some(
        (q) => typeof q.node === "string" && q.node.startsWith("layout/slot/"),
      );
      assert("홀 페인트 게이트 — 홀-슬롯 무배경(현 테마)", !slotPaints,
        slotPaints ? JSON.stringify(painters[0]) : "");
    }
  }

  // 6) 해 == 관측 — layout.arrangement 가 답한 셀 rect 가 실측 슬롯 rect 와 같은가.
  //    소수점까지 본다(정수로 자르면 소수 변화가 숨는다).
  {
    await rpc("view.activate", { view: browserView }, win);
    await sleep(600);
    const solved = await rpc("layout.arrangement", {}, win);
    const cells = solved.data?.cells ?? [];
    const railW = (await rpc("ui.measure", { address: `win/${win}/chrome/rail/left` }, win))
      ?.data?.rect?.w;
    assert(
      "해 조회 — 셀·station·레일 폭이 사실로 나온다",
      cells.length >= 2 && Number.isFinite(solved.data?.station) && railW > 0,
      JSON.stringify({ cells: cells.length, station: solved.data?.station, railW }),
    );

    // 7) 복도 계약 — 무관 포커스 변화가 허용하는 기하 변화는 레일 복도의 railW 평행이동
    //    하나뿐이다: 레일이 가로지른 패널만 정확히 railW 이동하고, 폭·높이·y 는 불변이며,
    //    가로지르지 않은 패널은 0 이동. 그 밖의 어떤 이동도 결함이다.
    const rectOf = async (view) => {
      const m = await rpc("ui.measure", { address: `win/${win}/chrome/layout/slot/${view}` }, win);
      return m.ok ? m.data.rect : null;
    };
    const b0 = await rectOf(browserView);
    const t0r = await rectOf(termView);
    await rpc("view.activate", { view: termView }, win);
    await sleep(900); // 340ms 주행 + 착지 스냅 여유
    const b1 = await rectOf(browserView);
    const t1r = await rectOf(termView);
    const dx = Math.abs(b1.x - b0.x);
    assert(
      "복도 계약 — 레일이 가로지른 브라우저만 railW 평행이동(폭·y 불변)",
      Math.abs(dx - railW) < 1.5 &&
        Math.abs(b1.w - b0.w) < 1 &&
        Math.abs(b1.h - b0.h) < 1 &&
        Math.abs(b1.y - b0.y) < 1,
      `dx=${dx.toFixed(3)} railW=${railW} w=${b0.w}->${b1.w} y=${b0.y}->${b1.y}`,
    );
    assert(
      "복도 계약 — 가로지르지 않은 터미널은 전 축 0 이동",
      Math.abs(t1r.x - t0r.x) < 1 &&
        Math.abs(t1r.y - t0r.y) < 1 &&
        Math.abs(t1r.w - t0r.w) < 1,
      `${JSON.stringify(t0r)} → ${JSON.stringify(t1r)}`,
    );

    // 8) 착지 일치 — 네이티브 child 의 프레임 이동량이 슬롯 이동량과 같다. 위상 중 표면은
    //    움직이지 않고 착지에서 한 번 놓이므로, 착지 후 둘은 정확히 같은 만큼 옮겨져 있어야
    //    한다(오프셋 무관 델타 비교 — 플러그인 크롬 높이를 코어는 모른다).
    // 브라우저 child 는 창의 네이티브 계층에서 WryWebView 로 선다(메인 웹뷰는 KVO 래핑된
    // 전체 창 크기 항목이라 제외). 슬롯과 폭이 같은 항목이 그 child 다 — 높이는 플러그인
    // 툴바만큼 짧고, 코어는 그 오프셋을 모르므로 폭으로 짚고 이동량(델타)만 비교한다.
    const childX = async (slotW) => {
      const h = await rpc("window.layers", {}, win);
      const lines = String(h.data?.hierarchy ?? "").split("\n");
      let best = null;
      for (const line of lines) {
        if (!line.includes("WryWebView") || line.includes("NSKVONotifying_")) continue;
        const m = /frame=\((-?[\d.]+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\)/.exec(line);
        if (!m) continue;
        const [x, , w] = [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
        const d = Math.abs(w - slotW);
        if (d < 8 && (!best || d < best.d)) best = { x, d };
      }
      return best?.x ?? null;
    };
    const c1 = await childX(b1.w);
    await rpc("view.activate", { view: browserView }, win);
    await sleep(900);
    const b2 = await rectOf(browserView);
    const c2 = await childX(b2.w);
    if (c1 == null || c2 == null) {
      assert("착지 일치 — 네이티브 프레임 판독", false, `c1=${c1} c2=${c2} slotW=${b1.w}`);
    } else {
      const slotDelta = b2.x - b1.x;
      const childDelta = c2 - c1;
      assert(
        "착지 일치 — 네이티브 child 이동량 == 슬롯 이동량(±1.5px)",
        Math.abs(slotDelta - childDelta) < 1.5,
        `slot=${slotDelta.toFixed(2)} child=${childDelta.toFixed(2)}`,
      );
    }
  }

  } finally {
  // ── 자기정리 — 실패 경로 포함 픽스처 창 폐쇄(멱등: 다음 실행은 새로 연다).
    // KEEP=1 이면 검안을 위해 보존한다(brestore 와 동일 관례).
    if (process.env.KEEP !== "1") await rpc("window.close", { label: win }).catch(() => {});
    else console.log(`KEEP=1 — 픽스처 창 보존: ${win}`);
  }

  if (failures > 0) {
    console.log(`✗ slot-freeze E2E 실패 ${failures}건`);
    process.exit(1);
  }
  console.log("✓ slot-freeze E2E 전체 GREEN");
  process.exit(0);
}

main().catch((e) => {
  console.error(`✗ slot-freeze E2E 중단: ${e.message}`);
  process.exit(1);
});
