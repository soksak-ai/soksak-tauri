// @vitest-environment node
// 문서 안 게스트에 **조상의 효과가 닿는가** — 프레임 단위로 잰다.
//
// 콘텐츠가 문서 밖인 프레임워크에서는 조상의 `filter` 가 콘텐츠에 안 닿는다. 그 보정은 해당
// 프레임워크 어댑터가 소유한다. 이 테스트는 문서 안 게스트에 공통 파킹이 더 필요하지 않음을 잰다.
// 그 둘이 홀 베일과 오프스크린 파킹의 존재 이유다.
//
// 문서 안 게스트에도 같은 것이 참인지는 **재기 전에는 모른다.** 참이 아닌데 같은 장치를 걸면
// 멀쩡한 판을 가리고 비운다. 참인데 안 걸면 흐려야 할 판이 안 흐려진다. 그래서 셋을 잰다.
//
//   U1 조상 `filter` 가 게스트 픽셀에 닿는가
//   U2 오프스크린 파킹에서 돌아오는 **첫 프레임**이 비는가
//   U3 `visibility:hidden` 만으로 게스트가 실제로 사라지는가
//
// 프레임은 추측하지 않는다: `beginFrameSubscription` 이 합성된 프레임을 그대로 준다.
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const ELECTRON = require_("electron");

/**
 * 게스트는 빨강, 판 배경은 검정 — 게스트가 빠진 프레임은 검정으로 나타난다.
 *
 * 두 장치가 더 있다. **박동**(파란 사각형이 매 rAF 마다 세대값을 올린다)은 합성기가 프레임을
 * 계속 만들게 한다 — 정지 화면에서는 새 프레임이 아예 안 나므로 "구독 직후 배달된 옛 프레임"과
 * "해동 뒤의 빈 프레임"이 구별되지 않는다. **표식**(초록 사각형)은 해동과 **같은 스크립트**에서
 * 켜지므로, 표식이 처음 보이는 프레임이 곧 해동이 반영될 수 있는 첫 프레임이다. 두 색 토글은
 * rAF와 프레임 구독의 위상이 같으면 한 색만 관측되는 aliasing이 생기므로 오라클로 쓰지 않는다.
 */
const PAGE = `<!doctype html><html><body style="margin:0;background:#000">
<div id="park" style="position:absolute;left:0;top:0;width:400px;height:400px">
  <webview id="c" src="data:text/html,<body style='margin:0;background:%23ff0000'></body>"
           style="position:absolute;inset:0"></webview>
</div>
<div id="beat" style="position:absolute;right:0;top:0;width:20px;height:20px;background:#000;z-index:9"></div>
<div id="mark" style="position:absolute;right:0;bottom:0;width:20px;height:20px;background:#000;z-index:9"></div>
<script>
  let n = 0;
  const beat = document.getElementById("beat");
  (function tick() {
    beat.style.background = 'rgb(0,0,' + (n++ % 251) + ')';
    requestAnimationFrame(tick);
  })();
</script>
</body></html>`;

const MAIN = `
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
app.commandLine.appendSwitch("disable-gpu");
app.setPath("userData", require("node:path").join(require("node:path").dirname(process.argv[3]), "ud"));
if (!app.requestSingleInstanceLock()) app.exit(0);
const WATCHDOG = setTimeout(() => app.exit(3), 60_000);
WATCHDOG.unref?.();

app.whenReady().then(async () => {
  const out = {};
  try {
    const w = new BrowserWindow({
      width: 400, height: 400, show: false,
      // 실사용 창을 건드리지 않는 숨은 측정 창에서도 rAF/합성 프레임이 멈추지 않아야
      // beginFrameSubscription이 "프레임 부재"를 "빈 프레임 부재"로 오판하지 않는다.
      webPreferences: { webviewTag: true, offscreen: false, backgroundThrottling: false },
    });
    await w.loadFile(process.argv[2]);
    await new Promise((r) => setTimeout(r, 2500));

    const wc = w.webContents;
    const px = (img, x, y) => {
      const { width, height } = img.getSize();
      const bmp = img.getBitmap(); // BGRA
      const i = (Math.round(y * height) * width + Math.round(x * width)) * 4;
      return { b: bmp[i], g: bmp[i + 1], r: bmp[i + 2] };
    };
    const centre = (img) => px(img, 0.5, 0.5);
    /** 한 프레임의 사실 셋: 게스트 빨강 · 박동 파랑 · 표식 초록. */
    const frameOf = (img) => ({
      guest: px(img, 0.5, 0.5).r,
      beat: px(img, 0.97, 0.03).b,
      mark: px(img, 0.97, 0.97).g,
    });
    const shot = async () => centre(await wc.capturePage());
    const run = (js) => wc.executeJavaScript(js);
    // 페인트가 한 번 지나가길 기다린다 — 선언 직후의 캡처는 아직 옛 프레임일 수 있다.
    const settle = () =>
      run("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120))))");

    // ── 기준: 게스트가 실제로 그려졌는가(오라클 생존) ──
    out.base = await shot();

    // ── U1: 조상 filter 가 게스트에 닿는가 ──
    await run("document.getElementById('park').style.filter = 'brightness(0.4)'");
    await settle();
    out.filtered = await shot();
    await run("document.getElementById('park').style.filter = ''");
    await settle();

    // ── U3: visibility:hidden 만으로 사라지는가 ──
    await run("document.getElementById('park').style.visibility = 'hidden'");
    await settle();
    out.visibilityHidden = await shot();
    await run("document.getElementById('park').style.visibility = ''");
    await settle();

    // ── U2: 공통 DOM 파킹에서 돌아오는 첫 프레임 ──
    // lib/layerPark 가 바르는 그대로 바른다 — 흉내가 아니라 같은 선언이어야 답이 같다.
    const park = \`(() => { const el = document.getElementById('park');
      el.style.visibility = 'hidden'; el.style.pointerEvents = 'none'; })()\`;
    const unpark = \`(() => { const el = document.getElementById('park');
      el.style.visibility = 'visible'; el.style.pointerEvents = ''; })()\`;

    // 파킹 선언을 **하나씩** 갈라 본다 — 어느 줄이 빈 프레임을 만드는지 이름으로 알아야
    // 고칠 자리가 정해진다. 통째로 재면 "파킹이 문제"까지만 알고 끝난다.
    const el = "document.getElementById('park').style";
    const VARIANTS = {
      full: [park, unpark],
      visibility: [\`\${el}.visibility='hidden'\`, \`\${el}.visibility='visible'\`],
    };
    out.variants = {};
    for (const [name, [on, off]] of Object.entries(VARIANTS)) {
      await run(\`document.getElementById('mark').style.background='#000'\`);
      await run(on);
      await settle();
      const hidden = await shot();
      const frames = [];
      wc.beginFrameSubscription(false, (image) => {
        if (frames.length < 60) frames.push(frameOf(image));
      });
      // 표식과 해동을 **같은 스크립트**에서 켠다 — 둘이 같은 프레임에 실린다.
      await run(\`document.getElementById('mark').style.background='#00ff00'; \${off}\`);
      await new Promise((r) => setTimeout(r, 700));
      wc.endFrameSubscription();
      out.variants[name] = { hidden: hidden.r, frames };
      await settle();
    }
    out.parked = { r: out.variants.full.hidden };

    fs.writeFileSync(process.argv[3], JSON.stringify(out));
  } catch (e) {
    try { fs.writeFileSync(process.argv[3], JSON.stringify({ error: String((e && e.stack) || e) })); } catch {}
  } finally {
    clearTimeout(WATCHDOG);
    app.exit(0);
  }
});
`;

let dir;
let spawned;
afterEach(() => {
  if (spawned && !spawned.killed) spawned.kill("SIGKILL");
  spawned = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function measure() {
  dir = mkdtempSync(join(tmpdir(), "guest-fx-"));
  const page = join(dir, "p.html");
  const main = join(dir, "m.cjs");
  const out = join(dir, "o.json");
  writeFileSync(page, PAGE);
  writeFileSync(main, MAIN);
  return new Promise((resolve, reject) => {
    const child = (spawned = spawn(ELECTRON, [main, page, out], { stdio: ["ignore", "pipe", "pipe"] }));
    let err = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("측정이 끝나지 않았다"));
    }, 60_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(readFileSync(out, "utf8")));
      } catch (e) {
        reject(new Error(`측정 실패(code=${code}): ${err.slice(-400)}`));
      }
    });
  });
}

describe("문서 안 게스트 — 조상의 효과가 닿는가", () => {
  it("U1·U2·U3 을 한 번에 잰다", async () => {
    const px = await measure();
    expect(px.error, px.error).toBeUndefined();

    // 오라클 생존 — 게스트가 애초에 안 그려졌으면 아래 전부가 같은 이유로 통과한다.
    expect(px.base.r, "게스트가 안 그려졌다").toBeGreaterThan(180);

    // U1 — 조상 filter 가 닿으면 빨강이 어두워진다. 안 닿으면 그대로다.
    //      닿는다면 홀 슬롯에서 filter 를 끌 이유가 없다(베일은 문서 밖 표면의 보상이다).
    const filterReaches = px.filtered.r < px.base.r * 0.7;
    expect(filterReaches, `조상 filter 가 게스트에 안 닿는다(base ${px.base.r} → ${px.filtered.r})`).toBe(true);

    // U3 — visibility:hidden 만으로 사라져야 한다. 안 사라지면 오프스크린 파킹이 필요하다.
    expect(px.visibilityHidden.r, "visibility:hidden 인데 게스트가 남아 있다").toBeLessThan(60);

    // U2 — 파킹에서 돌아온 뒤 **비는 프레임이 없어야** 한다.
    expect(px.parked.r, "파킹했는데 게스트가 남아 있다").toBeLessThan(60);

    const report = [];
    const blanky = [];
    for (const [name, v] of Object.entries(px.variants)) {
      // 박동이 도는지 먼저 본다 — 프레임이 안 흐르면 아래 판정이 공짜로 통과한다.
      const beats = new Set(v.frames.map((f) => f.beat)).size;
      // 해동이 실릴 수 있는 **첫 프레임** = 표식이 처음 보인 프레임. 그 전 프레임의 검정은
      // 파킹 상태 그 자체이지 결함이 아니다.
      const from = v.frames.findIndex((f) => f.mark > 120);
      const after = from < 0 ? [] : v.frames.slice(from);
      const blanks = after.filter((f) => f.guest < 60).length;
      const painted = after.filter((f) => f.guest >= 180).length;
      report.push(
        `${name}: 표식 ${from} · 해동후 [${after.slice(0, 6).map((f) => f.guest).join(",")}] · 빈 ${blanks}`,
      );
      expect(beats, `${name}: 박동 세대가 안 변한다 — 프레임이 흐르지 않는다`).toBeGreaterThan(1);
      expect(from, `${name}: 표식을 실은 프레임이 없다 — 해동 시점을 특정할 수 없다`).toBeGreaterThanOrEqual(0);
      expect(painted, `${name}: 해동 뒤 그려진 프레임이 하나도 없다`).toBeGreaterThan(0);
      if (blanks > 0) blanky.push(name);
    }
    expect(blanky, `해동 첫 프레임이 비는 파킹 — ${report.join(" | ")}`).toEqual([]);
  }, 90_000);
});
