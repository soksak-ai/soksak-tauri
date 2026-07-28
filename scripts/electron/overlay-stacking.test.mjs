// @vitest-environment node
// 겹침 판정 — Electron 에서 DOM 이 웹 콘텐츠 **위에** 그려지는가.
//
// Tauri/macOS 는 자식이 네이티브 뷰(WKWebView)라 DOM 과 다른 컴포지터에 있다. 그래서 겹치려면
// z-순서를 뒤집고 투명 홀을 뚫고 hitTest 를 스위즐한다(webview.rs §레이어 원칙). 그 장치 전부가
// **네이티브 뷰이기 때문에** 필요하다.
//
// Electron 의 <webview> 는 HTMLElement 다(electron.d.ts: `interface WebviewTag extends
// HTMLElement`). 페이지 레이아웃에 참여한다면 겹침은 z-index 문제로 환원되고 홀·스위즐이
// 애초에 필요 없어진다. 타입이 그렇다고 해서 합성까지 그런지는 별개라 픽셀로 잰다.
//
// 오라클: 오버레이가 덮은 자리의 픽셀이 오버레이 색이면 DOM 이 위다. 콘텐츠 색이 나오면
// 웹 콘텐츠가 DOM 을 뚫고 올라온 것이고, 그때는 Tauri 와 같은 장치가 필요하다.
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const ELECTRON = require_("electron");

/** 콘텐츠는 빨강, 오버레이는 파랑. 겹친 자리에서 어느 색이 나오는지가 답이다. */
const PAGE = `<!doctype html><html><body style="margin:0;background:#000">
<webview id="c" src="data:text/html,<body style='margin:0;background:%23ff0000'></body>"
         style="position:absolute;left:0;top:0;width:400px;height:400px"></webview>
<div id="o" style="position:absolute;left:100px;top:100px;width:200px;height:200px;
                   background:#0000ff;z-index:10"></div>
</body></html>`;

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
    webPreferences: { webviewTag: true, offscreen: false },
  });
  await w.loadFile(process.argv[2]);
  // <webview> 가 자기 문서를 그릴 때까지 — 로드 완료 신호가 없으면 검은 화면을 재게 된다.
  await new Promise((r) => setTimeout(r, 2500));
  const img = await w.webContents.capturePage();
  const { width, height } = img.getSize();
  const bmp = img.getBitmap(); // BGRA
  const at = (x, y) => {
    const i = (y * width + x) * 4;
    return { b: bmp[i], g: bmp[i + 1], r: bmp[i + 2] };
  };
  fs.writeFileSync(process.argv[3], JSON.stringify({
    size: { width, height },
    overlap: at(Math.round(width * 0.5), Math.round(height * 0.5)),   // 오버레이가 덮은 자리
    contentOnly: at(Math.round(width * 0.12), Math.round(height * 0.12)), // 콘텐츠만 있는 자리
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

function measure() {
  dir = mkdtempSync(join(tmpdir(), "stack-"));
  const page = join(dir, "p.html");
  const main = join(dir, "m.cjs");
  const out = join(dir, "o.json");
  writeFileSync(page, PAGE);
  writeFileSync(main, MAIN);
  return new Promise((resolve, reject) => {
    const child = (spawned = spawn(ELECTRON, [main, page, out], { stdio: ["ignore", "pipe", "pipe"] }));
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("측정이 끝나지 않았다"));
    }, 40_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(require_("node:fs").readFileSync(out, "utf8")));
      } catch (e) {
        reject(new Error(`측정 실패(code=${code}): ${err.slice(-400)}`));
      }
    });
  });
}

describe("겹침 — DOM 이 웹 콘텐츠 위에 그려지는가", () => {
  it("오버레이가 덮은 자리는 오버레이 색이고, 그 밖은 콘텐츠 색이다", async () => {
    const px = await measure();

    // 오라클 생존: 콘텐츠가 실제로 그려졌는지 먼저 본다. 검은 화면이면 두 단언 다 무의미하다.
    expect(px.contentOnly.r).toBeGreaterThan(180);
    expect(px.contentOnly.b).toBeLessThan(80);

    // 판정: 겹친 자리는 파랑이어야 한다. 빨강이면 웹 콘텐츠가 DOM 을 뚫고 올라온 것이고,
    // 그때는 Tauri 와 같은 홀·hitTest 장치가 Electron 에서도 필요하다.
    expect(px.overlap.b).toBeGreaterThan(180);
    expect(px.overlap.r).toBeLessThan(80);
  }, 60_000);
});
