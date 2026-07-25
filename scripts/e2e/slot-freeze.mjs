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
// 검증 대상 엔진 — 홀(네이티브 표면) 뷰는 엔진마다 표면 소유자가 다르다(자식 웹뷰 vs 사이드카
// 프로세스). 한 엔진만 태우면 나머지는 검증되지 않은 채 남는다(실측: chromium 경로에서 깜빡임).
// BROWSER_ENGINE=browser|browser-chromium|browser-chromium-offscreen.
const ENGINE = process.env.BROWSER_ENGINE || "browser";
const ENGINE_PLUGIN = {
  browser: "soksak-plugin-browser-native",
  "browser-chromium": "soksak-plugin-browser-chromium",
  "browser-chromium-offscreen": "soksak-plugin-browser-chromium-offscreen",
}[ENGINE];
if (!ENGINE_PLUGIN) throw new Error(`알 수 없는 엔진: ${ENGINE}`);

// 소켓 클라이언트 — 연결마다 독립 봉투 큐. 둘 이상 열 수 있어야 한다: 녹화(window.record)는
// 프레임 수만큼 응답을 붙잡으므로, 같은 연결로는 녹화 도중 위상을 태울 수 없다(실측: 활강이
// 한 프레임도 안 찍히거나 이미 정착한 화면만 남았다). 카메라와 조작자는 다른 연결을 쓴다.
function openClient() {
  const state = { sock: null, seq: 0, pending: new Map(), buf: "" };
  return new Promise((resolve, reject) => {
    state.sock = net.createConnection(SOCKET);
    state.sock.setNoDelay(true);
    state.sock.once("error", reject);
    state.sock.once("connect", () =>
      resolve({
        rpc(method, params = {}, window) {
          return new Promise((res, rej) => {
            const id = ++state.seq;
            state.pending.set(id, res);
            const req = { id, method, params };
            if (window) req.window = window;
            state.sock.write(`${JSON.stringify(req)}\n`);
            setTimeout(() => {
              if (state.pending.has(id)) {
                state.pending.delete(id);
                rej(new Error(`TIMEOUT ${method}`));
              }
            }, 30000);
          });
        },
        close: () => state.sock.destroy(),
      }),
    );
    state.sock.on("data", (d) => {
      state.buf += d.toString("utf8");
      let i;
      while ((i = state.buf.indexOf("\n")) >= 0) {
        const line = state.buf.slice(0, i);
        state.buf = state.buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const p = state.pending.get(msg.id);
        if (p) {
          state.pending.delete(msg.id);
          p(msg);
        }
      }
    });
  });
}

let primary;
async function connect() {
  primary = await openClient();
}
// 요청 봉투(MESSAGE-PROTOCOL·multiwindow.mjs 와 동형): { id, method, params, window? }.
const rpc = (method, params, window) => primary.rpc(method, params, window);
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
  console.log(`소켓 연결: ${SOCKET} — 엔진 ${ENGINE}`);

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
    return ids.includes(ENGINE) ? true : null;
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
  const bv = await rpc("view.open", { program: ENGINE }, win);
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
  await rpc(`plugin.${ENGINE_PLUGIN}.navigate`, { url: "https://example.com/" }, win);
  await sleep(2000);
  await pollUntilGentle("example.com 로드(h1 텍스트)", 20000, 2000, async () => {
    const q = await rpc(`plugin.${ENGINE_PLUGIN}.dom.text`, { selector: "h1" }, win);
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
  await rpc("view.activate", { view: termView }, win);
  await sleep(700);
  await rpc("view.activate", { view: browserView }, win);
  const cycled = await pollUntil("동결 사이클(freeze=0)", 10000, async () => {
    const d = await measure();
    return d?.dataset?.freeze === "0" ? d : null;
  });
  assert("동결 사이클 — 동결→해동 완주(freeze=0)", cycled.dataset.freeze === "0");

  // 2.5) 스탠드인 피복 — §4.6-3(표면을 숨기지 않는다)이 전적으로 기대는 가정: 스탠드인이
  //      유일한 홀을 완전히 덮는다. 이 가정이 깨지면 표면이 스탠드인 위로 드러나 활강 내내
  //      옛 자리의 픽셀이 보인다(핸드오프 §8 경고). 위상 한복판에 슬롯 중심을 히트해 최상단이
  //      동결 프레임인지 직접 확인한다.
  {
    await rpc("view.activate", { view: browserView }, win);
    await sleep(900);
    const r0 = (await measure())?.rect;
    const standinRect = async () => {
      const m = await rpc(
        "ui.measure",
        { address: `win/${win}/chrome/layout/standin/${browserView}` },
        win,
      );
      return m.ok ? m.data.rect : null;
    };
    await rpc("view.activate", { view: termView }, win);
    let covered = null;
    for (let i = 0; i < 10 && covered === null; i++) {
      const st = await standinRect();
      if (st) covered = st;
      else if ((await measure())?.dataset?.freeze !== "1") break; // 위상 종료 — 더 볼 것 없음
      await sleep(40);
    }
    const slotNow = (await measure())?.rect;
    // 기준은 슬롯 rect 가 아니라 **표면 rect** 다. 슬롯은 분수고(실측 866.42×416.78) 네이티브
    // 표면은 정수 픽셀에만 선다(866×415) — 슬롯에 맞춰 늘린 스탠드인은 표면이 없던 자리에서
    // 늘어난 사진이고, 실측으로 하단 콘텐츠가 2.6px 밀렸다. 스탠드인은 표면 자리에 1:1 로 선다.
    const surf = slotNow
      ? {
          w: Math.floor(slotNow.x + slotNow.w) - Math.ceil(slotNow.x),
          h: Math.floor(slotNow.y + slotNow.h) - Math.ceil(slotNow.y),
        }
      : null;
    assert(
      "스탠드인 정합 — 활강 중 스탠드인이 표면 rect 에 1:1 로 선다(늘리지 않는다)",
      !!covered && !!surf && Math.abs(covered.w - surf.w) <= 1 && Math.abs(covered.h - surf.h) <= 1,
      covered
        ? `standin=${JSON.stringify(covered)} surface=${JSON.stringify(surf)} slot=${JSON.stringify(slotNow)}`
        : "동결 중 스탠드인 주소가 잡히지 않았다",
    );
    await sleep(600);
  }

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
  const alive = await rpc(`plugin.${ENGINE_PLUGIN}.dom.text`, { selector: "h1" }, win);
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

    // 8) 위상 쓰기 0 / 착지 1 — 표면 소유자의 송신 누계를 veil 전후로 읽는다. 착지 일치는
    //    결과이고, 이것은 그 결과가 "아무도 안 썼기 때문"임을 증명한다.
    {
      const sendsOf = async () => {
        const r = await rpc(`plugin.${ENGINE_PLUGIN}.surface.stats`, {}, win);
        const row = (r.data?.views ?? []).find((v) => v.viewId === browserView);
        return row ? Number(row.sends) : -1;
      };
      await rpc("view.activate", { view: browserView }, win);
      await sleep(900);
      const s0 = await sendsOf();
      await rpc("view.activate", { view: termView }, win);
      await sleep(120); // 위상 한복판(340ms 주행 중)
      const sMid = await sendsOf();
      await sleep(1200); // 착지 + 정착
      const s1 = await sendsOf();
      assert(
        "위상 쓰기 0 — 스탠드인 뒤에서는 아무도 표면에 쓰지 않는다",
        s0 >= 0 && sMid === s0,
        `before=${s0} mid=${sMid}`,
      );
      assert(
        "착지 1 — 해동 에지에 정확히 한 번 쓴다",
        s1 - s0 === 1,
        `before=${s0} after=${s1}`,
      );
    }

    // 9) 착지 일치 — 네이티브 child 의 프레임 이동량이 슬롯 이동량과 같다. 위상 중 표면은
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

  // 9.5) 절대 정합 — 델타 비교는 일정한 오프셋을 통과시킨다. 착지 후 네이티브 child 의
  //      좌·우 경계가 슬롯의 그것과 같은 자리인지 절대값으로 잰다(가로는 오프셋이 없어야
  //      한다 — 세로만 플러그인 크롬 높이만큼 다르다).
  {
    await rpc("view.activate", { view: browserView }, win);
    await sleep(1100);
    const slot = (await measure())?.rect;
    const h = await rpc("window.layers", {}, win);
    let child = null;
    for (const line of String(h.data?.hierarchy ?? "").split("\n")) {
      if (!line.includes("WryWebView") || line.includes("NSKVONotifying_")) continue;
      const m = /frame=\((-?[\d.]+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\)/.exec(line);
      if (!m) continue;
      const [x, y, w, hh] = m.slice(1, 5).map(parseFloat);
      if (Math.abs(w - slot.w) < 8 && (!child || Math.abs(w - slot.w) < Math.abs(child.w - slot.w)))
        child = { x, y, w, h: hh };
    }
    // 슬롯의 분수 rect 를 표면 규칙(ceil-left / floor-right)으로 접은 것이 표면이 서야 할 자리다.
    const sx = Math.ceil(slot.x);
    const sw = Math.floor(slot.x + slot.w) - sx;
    assert(
      "절대 정합 — 착지한 표면이 접힌 표면 rect 에 정확히 선다(±1px)",
      !!child && Math.abs(child.x - sx) <= 1 && Math.abs(child.w - sw) <= 1,
      child
        ? `child x=${child.x} w=${child.w} / surface x=${sx} w=${sw} (slot x=${slot.x} w=${slot.w})`
        : "child 판독 실패",
    );
  }


  // 9.7) 레일 영역 인계 — 빠질 자리와 생길 자리. 규정: 빠지는 자리는 **원래 서 있던 것**이
  //      닫히고(새것을 끼워넣지 않는다), 생기는 자리에 새것이 열린다. 이어져야 하는 것은
  //      표면이므로 두 자리가 각자 투영 표면을 들고 있어야 한다 — 도착 자리가 빈 채로 열리면
  //      그것이 "새것으로 교체"로 보인다. 주행 한복판에 투영 프레임 수와 x 를 직접 센다.
  {
    await rpc("view.activate", { view: browserView }, win);
    await sleep(900);
    const places = async () => {
      const t = await rpc("ui.tree", {}, win);
      const nodes = JSON.stringify(t.data ?? {});
      const n = (re) => (nodes.match(re) ?? []).length;
      return {
        // 상주·도착 = rail/left, 빠지는 자리 = rail/left/leaving. nodePath 만 센다
        // (address 가 같은 문자열을 한 번 더 싣는다).
        standing: n(/"nodePath":"rail\/left"/g),
        leaving: n(/"nodePath":"rail\/left\/leaving"/g),
        // 표면 — 각 자리가 자기 투영 프레임을 들고 있어야 한다(빈 자리가 열리면 "교체"다).
        surfaces: n(/"nodePath":"projection\/left\/frame\//g),
        // 어떤 표면인지 — 빠지는 자리는 자기가 들고 있던 투영으로 닫혀야 한다. 두 자리가
        // 같은 refKey 면 빠지는 자리가 새 투영으로 교체된 것이다(= 새로 마운트됐다).
        refKeys: (nodes.match(/"nodePath":"projection\/left\/frame\/([^"]+)"/g) ?? []).map(
          (m) => m.replace(/.*frame\//, "").replace(/"$/, ""),
        ),
      };
    };
    const resting = await places();
    await rpc("view.activate", { view: termView }, win);
    let during = { standing: 0, leaving: 0, surfaces: 0 };
    for (let i = 0; i < 8; i++) {
      const now = await places();
      if (now.leaving > during.leaving) during = now;
      if (during.leaving >= 1) break;
    }
    await sleep(900);
    const landed = await places();
    assert(
      "레일 영역 인계 — 주행 중 빠질 자리와 생길 자리가 함께 서고 각자 표면을 든다",
      resting.standing === 1 &&
        resting.leaving === 0 &&
        during.standing === 1 &&
        during.leaving === 1 &&
        during.surfaces >= 2 &&
        landed.standing === 1 &&
        landed.leaving === 0,
      `정차=${JSON.stringify(resting)} 주행중=${JSON.stringify(during)} 착지=${JSON.stringify(landed)}`,
    );
  }

  // 10) 행 불일치 스위칭 — 사용자가 규정한 예외 규칙의 라이브 증명. 아래를 둘로 나눠
  //     [위 1 / 아래 2] 를 만들고 아래 뒷쪽을 포커스하면, 그 패널이 앞으로 스위칭되고
  //     해가 만들어진 인접(switched)을 보고해야 한다(점선 봉합의 근거).
  {
    await rpc("view.activate", { view: termView }, win);
    const below = await rpc("panel.split", { side: "bottom", program: termProgram }, win);
    if (below.ok) {
      const rear = await rpc("panel.split", { side: "right", program: termProgram }, win);
      if (rear.ok && rear.data?.viewId) {
        await rpc("view.activate", { view: rear.data.viewId }, win);
        await sleep(700);
        const solved = await rpc("layout.arrangement", {}, win);
        const cells = solved.data?.cells ?? [];
        const focusedLeft = cells.find((c) => c.id === rear.data.panelId)?.rect?.left;
        assert(
          "행 불일치 스위칭 — 뒷쪽 포커스가 앞으로 서고 해가 그것을 보고한다",
          solved.data?.switched === true &&
            Math.abs((focusedLeft ?? -1) - solved.data.station) < 0.01,
          `switched=${solved.data?.switched} focusedLeft=${focusedLeft} station=${solved.data?.station}`,
        );
      } else {
        assert("행 불일치 스위칭 — 픽스처 분할", false, JSON.stringify(rear.data ?? rear.message));
      }
    } else {
      assert("행 불일치 스위칭 — 픽스처 분할", false, JSON.stringify(below.message));
    }
  }

  // 10.5) 모션 판독(옵션) — SLOT_FREEZE_MOTION 으로 활강 구간을 프레임 열로 남긴다.
  //       정착 스냅샷·계수는 모션에 대해 아무것도 증명하지 않는다(핸드오프 §1·§6-4): 출력
  //       픽셀만이 근거다. 모션 프레임은 창이 전면일 때만 찍힌다(가려진 창은 애니를 최종
  //       프레임으로 settle 한다) — 그래서 이 단계만 창을 전면으로 가져온다.
  if (process.env.SLOT_FREEZE_MOTION) {
    const dir =
      process.env.SLOT_FREEZE_MOTION_DIR || path.join(os.tmpdir(), "slot-freeze-motion");
    await rpc("window.focus", {}, win);
    await sleep(500);
    await rpc("view.activate", { view: browserView }, win);
    await sleep(900);
    // 카메라를 먼저 돌리고 위상을 태운다 — 한 연결로는 불가능하다(녹화가 프레임 수만큼 응답을
    // 붙잡는다). 위상을 먼저 태우고 녹화하면 카메라 준비 지연만큼 앞이 잘려 이미 정착한 화면만
    // 남는다(실측 두 번). 카메라 = 별 연결, 조작자 = 주 연결.
    const cam = await openClient();
    const rec = cam.rpc("window.record", { dir, frames: 34, intervalMs: 16 }, win);
    // 카메라 준비 — 첫 프레임은 요청 즉시가 아니라 캡처 파이프라인이 서는 뒤에 떨어진다
    // (실측 프레임 간격 ~108ms, 첫 프레임 지연 ~500ms). 짧게 기다리면 위상이 카메라보다
    // 앞서 끝나 꼬리만 남는다.
    await sleep(800);
    await rpc("view.activate", { view: termView }, win);
    const done = await rec;
    cam.close();
    console.log(`  모션 프레임: ${done.data?.frames ?? "?"}장 → ${done.data?.dir ?? dir}`);
    await sleep(500);
  }

  // 11) 시각 확인(옵션) — SLOT_FREEZE_SHOTS 로 정지 프레임 두 장을 남긴다: 브라우저 포커스와
  //    터미널 포커스. 레일이 포커스 패널의 왼쪽 선에 서 있는지, 복도가 열린 자리가 맞는지,
  //    표면이 온전히 렌더되는지는 사람이 픽셀로 확인해야 하는 사실이다(R3).
  if (process.env.SLOT_FREEZE_SHOTS) {
    const dir = process.env.SLOT_FREEZE_SHOTS_DIR || path.join(os.tmpdir(), "slot-freeze-shots");
    for (const [name, view] of [["browser-focus", browserView], ["terminal-focus", termView]]) {
      await rpc("view.activate", { view }, win);
      await sleep(900);
      const shot = await rpc("window.snapshot", { path: path.join(dir, `${name}.png`) }, win);
      console.log(`  캡처 ${name}: ${shot.ok ? shot.media?.path ?? shot.data?.media?.path : shot.message}`);
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
