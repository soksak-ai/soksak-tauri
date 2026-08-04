// @vitest-environment node
// 라이브 판정 — 앱의 DOM 콘텐츠 뷰가 실제 Electron 에서 서고, 그려지고, 제어된다.
//
// 단위 검사(src/lib/contentViews.test.ts)는 jsdom 에서 태그 메서드를 흉내낸다. 그것은 계약을
// 지키지만 "이 프레임워크에서 정말 되는가"는 답하지 못한다 — 태그가 꺼져 있거나 게스트가
// 안 뜨면 요소는 만들어지고 메서드는 없는 채로 조용히 실패한다.
//
// 그래서 여기서는 실제 프로세스를 띄우고 ① 요소가 제어 메서드를 갖는지 ② 게스트가 실제로
// 그렸는지(픽셀) ③ 그 위에 얹은 DOM 이 위에 오는지를 함께 본다.
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const ELECTRON = require_("electron");

const PAGE = `<!doctype html><html><body style="margin:0;background:#000">
<div id="host" style="position:absolute;left:0;top:0"></div>
<div id="over" style="position:absolute;left:100px;top:100px;width:200px;height:200px;
                      background:#0000ff;z-index:10"></div>
</body></html>`;

// 앱의 DOM 구현이 하는 일과 같은 순서로 몬다: 요소 생성 → 배치 → 표시 → 제어.
const DRIVE = `
  const el = document.createElement("webview");
  el.setAttribute("data-content-view", "b-1");
  el.setAttribute("src", "data:text/html,<body style='margin:0;background:%23ff0000'></body>");
  el.style.cssText = "position:absolute;left:0px;top:0px;width:400px;height:400px";
  document.getElementById("host").appendChild(el);
  await new Promise((r) => el.addEventListener("dom-ready", r, { once: true }));
  return ({
    found: document.querySelectorAll("[data-content-view]").length,
    methods: ["loadURL","goBack","goForward","stop","setZoomLevel","openDevTools","executeJavaScript"]
      .filter((m) => typeof el[m] === "function"),
    evaluated: await el.executeJavaScript("1+1"),
  })
`;

const MAIN = `
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
app.commandLine.appendSwitch("disable-gpu");
// 이 프로세스는 **스스로** 끝난다 — 밖에서 죽이는 절차에 기대지 않는다.
//
// 실측: 측정 중 무엇이든 던지면 app.exit 에 닿지 못하고 Electron 이 그대로 남았다. 갈래가
// 여럿이면 그것이 배수로 쌓인다. 그래서 셋을 건다.
//   ① 잠금 — 같은 측정이 겹쳐 돌면 두 번째는 아무것도 만들지 않고 물러난다.
//   ② finally — 무엇이 나든 반드시 exit 한다.
//   ③ 감시 타이머 — 위 둘을 지나쳐도 이 프로세스는 정해진 시간에 죽는다.
// 잠금은 **측정마다** 갈린다. Electron 의 단일 인스턴스 잠금은 userData 경로로 갈리므로,
// 그 경로를 이 측정의 임시 디렉터리로 지목한다. 지목하지 않으면 두 측정이 같은 기본 경로를
// 공유해 나중 것이 "이미 도는 자신"으로 오인되고 **아무것도 재지 않고 물러난다**(실측).
app.setPath("userData", require("node:path").join(require("node:path").dirname(process.argv[3]), "ud"));
if (!app.requestSingleInstanceLock()) app.exit(0);
const WATCHDOG = setTimeout(() => app.exit(3), 40_000);
WATCHDOG.unref?.();
app.whenReady().then(async () => {
  try {
  const w = new BrowserWindow({
    width: 400, height: 400, show: false,
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false },
  });
  await w.loadFile(process.argv[2]);
  const drove = await w.webContents.executeJavaScript(\`(async () => { ${DRIVE} })()\`);
  await new Promise((r) => setTimeout(r, 1200));
  // 실제 어댑터와 같은 옵션. 부모 DOM뿐 아니라 별도 guest surface도 한 PNG에 합성되어야 한다.
  const img = await w.webContents.capturePage(undefined, { stayAwake: true });
  const { width, height } = img.getSize();
  const bmp = img.getBitmap();
  const at = (x, y) => { const i = (y * width + x) * 4; return { b: bmp[i], g: bmp[i+1], r: bmp[i+2] }; };
  fs.writeFileSync(process.argv[3], JSON.stringify({
    ...drove,
    content: at(Math.round(width * 0.12), Math.round(height * 0.12)),
    overlap: at(Math.round(width * 0.5), Math.round(height * 0.5)),
  }));
  } catch (e) {
    // 사유를 남기고 죽는다 — 조용히 남으면 그 프로세스가 무엇을 기다리는지 알 수 없다.
    try { fs.writeFileSync(process.argv[3], JSON.stringify({ error: String(e && e.stack || e) })); } catch {}
  } finally {
    clearTimeout(WATCHDOG);
    app.exit(0);
  }
});
`;

let dir;
/** 스폰한 자식 — 결과와 무관하게 afterEach 가 거둔다. 실패 경로에서 새면 인스턴스가 쌓인다. */
let spawned;
afterEach(() => {
  // 어떤 결과에서도 먼저 거둔다. kill 은 이미 죽은 pid 에 무해하고, 살아 있으면 이것이
  // 유일한 회수 지점이다 — 테스트가 던지면 아래 정리는 실행되지 않기 때문이다.
  if (spawned && !spawned.killed) spawned.kill("SIGKILL");
  spawned = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function run() {
  dir = mkdtempSync(join(tmpdir(), "cvlive-"));
  const page = join(dir, "p.html"), main = join(dir, "m.cjs"), out = join(dir, "o.json");
  writeFileSync(page, PAGE);
  writeFileSync(main, MAIN);
  return new Promise((resolve, reject) => {
    const child = (spawned = spawn(ELECTRON, [main, page, out], { stdio: ["ignore", "pipe", "pipe"] }));
    let err = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => { child.kill(); reject(new Error("측정이 끝나지 않았다")); }, 45_000);
    child.on("exit", (code) => {
      clearTimeout(t);
      try { resolve(JSON.parse(readFileSync(out, "utf8"))); }
      catch { reject(new Error(`측정 실패(code=${code}): ${err.slice(-500)}`)); }
    });
  });
}

describe("라이브 — DOM 콘텐츠 뷰", () => {
  it("선다 · 그린다 · 제어된다 · DOM 이 그 위에 온다", async () => {
    const r = await run();

    // ① 요소가 서고 label 로 찾힌다
    expect(r.found).toBe(1);

    // ② 제어면이 실제로 붙어 있다 — 태그가 꺼져 있으면 여기서 빈 배열이 온다
    expect(r.methods).toEqual(
      expect.arrayContaining(["loadURL", "goBack", "goForward", "stop", "setZoomLevel",
                              "openDevTools", "executeJavaScript"]),
    );
    // 게스트 안에서 코드가 돈다(프로세스가 갈렸음에도)
    expect(r.evaluated).toBe(2);

    // ③ 게스트가 실제로 그렸다 — 오라클 생존(검은 화면이면 ④ 가 공짜로 통과한다)
    expect(r.content.r).toBeGreaterThan(180);
    expect(r.content.b).toBeLessThan(80);

    // ④ 그 위에 얹은 DOM 이 위에 온다 — 홀·hitTest 없이
    expect(r.overlap.b).toBeGreaterThan(180);
    expect(r.overlap.r).toBeLessThan(80);
  }, 60_000);
});
