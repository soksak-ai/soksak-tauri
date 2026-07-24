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
  const tv = await rpc("panel.split", { side: "right", program: "terminal" }, win);
  if (!tv.ok) throw new Error(`panel.split 실패: ${tv.message}`);
  const termView = tv.data?.viewId;
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

  // 6) 기하 소유권 불변식 — 간접 사건(다른 뷰 포커스)은 브라우저 슬롯을 1px 도 못 움직인다.
  // 근본 원칙(NATIVE-SURFACES §2): 네이티브 표면의 기하는 직접 조작으로만 변한다. 이 게이트가
  // 깨지면 어떤 새 기능(레일 이주·투영·스왑)이 간접 이동을 재도입한 것이다 — 기능을 고쳐라.
  {
    await rpc("view.activate", { view: browserView }, win);
    await sleep(600);
    const before = (await measure())?.rect;
    for (let i = 0; i < 3; i++) {
      await rpc("view.activate", { view: termView }, win);
      await sleep(500);
    }
    const after = (await measure())?.rect;
    const same =
      before && after &&
      Math.abs(before.x - after.x) < 1 && Math.abs(before.y - after.y) < 1 &&
      Math.abs(before.w - after.w) < 1 && Math.abs(before.h - after.h) < 1;
    assert(
      "기하 소유권 — 간접 포커스 사건에 브라우저 슬롯 부동",
      !!same,
      same ? "" : `${JSON.stringify(before)} → ${JSON.stringify(after)}`,
    );
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
