// @vitest-environment node
// 실제 Electron/Chromium — 창을 포커스하지 않고 적대 resize마다 DOM slot ↔ <webview> ↔ guest
// viewport와 native presentation 거래가 함께 착지하는지 수치로 판정한다.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const ELECTRON = require_("electron");
const SETTLEMENT = fileURLToPath(
  new URL("../../frameworks/electron/resizeSettlement.cjs", import.meta.url),
);
const FRAME_SUBSCRIPTIONS = fileURLToPath(
  new URL("../../frameworks/electron/frameSubscriptionBroker.cjs", import.meta.url),
);
const DISPLAY_GEOMETRY = fileURLToPath(
  new URL("../../frameworks/electron/displayGeometry.cjs", import.meta.url),
);
const CAPTURE = fileURLToPath(
  new URL("../../frameworks/electron/native/capture.cjs", import.meta.url),
);

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body,#slot{position:absolute;inset:0;margin:0;overflow:hidden}
webview{position:absolute;inset:0}
</style></head><body><div id="slot" data-content-view-body="b-live"></div><script>
const slot=document.querySelector('#slot');
const view=document.createElement('webview');
view.setAttribute('data-content-view','b-live');
view.src='data:text/html,'+encodeURIComponent('<!doctype html><style>html,body{margin:0;background:#17324d;color:white}</style><body>settlement</body>');
slot.appendChild(view);
window.ready=new Promise(resolve=>view.addEventListener('dom-ready',()=>resolve(view.getWebContentsId()),{once:true}));
let resizeRevision=0,observerRevision=0,lastObserved=null;
addEventListener('resize',()=>{resizeRevision+=1});
new ResizeObserver(entries=>{const root=entries.find(entry=>entry.target===document.documentElement);if(!root)return;
  observerRevision+=1;lastObserved={width:root.contentRect.width,height:root.contentRect.height};
}).observe(document.documentElement);
window.sample=()=>{const s=slot.getBoundingClientRect(),v=view.getBoundingClientRect();return {
  viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},
  slot:{x:s.x,y:s.y,width:s.width,height:s.height},
  surface:{x:v.x,y:v.y,width:v.width,height:v.height},
  layout:{resizeRevision,observerRevision,lastObserved},
  id:view.getWebContentsId()
}};
</script></body></html>`;

const MAIN = `
const { app, BrowserWindow, screen, webContents }=require('electron');
const fs=require('node:fs'), path=require('node:path');
app.setPath('userData',path.join(path.dirname(process.argv[3]),'ud'));
const watchdog=setTimeout(()=>app.exit(3),45000); watchdog.unref?.();
const close=(value)=>{try{fs.writeFileSync(process.argv[3],JSON.stringify(value));}finally{clearTimeout(watchdog);app.exit(0)}};
app.whenReady().then(async()=>{try{
  const {createResizeSettlementLedger}=require(process.argv[4]);
  const {createFrameSubscriptionBroker}=require(process.argv[5]);
  const {createDisplayGeometry}=require(process.argv[6]);
  const win=new BrowserWindow({width:800,height:600,show:false,paintWhenInitiallyHidden:true,
    titleBarStyle:'hiddenInset',webPreferences:{webviewTag:true,contextIsolation:true,nodeIntegration:false,
    backgroundThrottling:false}});
  await win.loadFile(process.argv[2]);
  const guestId=await win.webContents.executeJavaScript('window.ready');
  const guest=webContents.fromId(guestId);
  const ledger=createResizeSettlementLedger({timeoutMs:5000,
    frameSubscriptions:createFrameSubscriptionBroker(),
    displayGeometry:createDisplayGeometry({screen,platform:process.platform})});
  ledger.register('w-live',win);
  const requested=[{width:620,height:480},{width:980,height:520},{width:640,height:760},{width:800,height:600}];
  const samples=[];
  for(const dip of requested){
    const scale=screen.getDisplayMatching(win.getBounds()).scaleFactor||1;
    const receipt=await ledger.resize({label:'w-live',win,
      requestedPhysical:{width:Math.round(dip.width*scale),height:Math.round(dip.height*scale)},surfaces:[guest]});
    const host=await win.webContents.executeJavaScript('window.sample()');
    const guestViewport=await guest.executeJavaScript('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})');
    samples.push({receipt,host,guestViewport});
  }
  let evidence=null;
  if(process.argv[8]){
    const capture=require(process.argv[7]);
    evidence=await capture['plugin:webview-capture|snapshot'].answer(
      {window:win},{path:process.argv[8]},
    );
  }
  close({samples,evidence});
}catch(error){close({error:String(error&&error.stack||error)})}});
`;

let fixtureDir;
let child;
afterEach(() => {
  if (child && !child.killed) child.kill("SIGKILL");
  child = undefined;
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
});

function runLive() {
  fixtureDir = mkdtempSync(join(tmpdir(), "electron-resize-settlement-"));
  const page = join(fixtureDir, "page.html");
  const main = join(fixtureDir, "main.cjs");
  const output = join(fixtureDir, "result.json");
  writeFileSync(page, PAGE);
  writeFileSync(main, MAIN);
  return new Promise((resolve, reject) => {
    child = spawn(ELECTRON, [
      main,
      page,
      output,
      SETTLEMENT,
      FRAME_SUBSCRIPTIONS,
      DISPLAY_GEOMETRY,
      CAPTURE,
      process.env.ELECTRON_RESIZE_EVIDENCE ?? "",
    ], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, SOKSAK_START_INACTIVE: "1" },
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => {
      child?.kill("SIGKILL");
      reject(new Error(`Electron resize settlement live timeout: ${stderr.slice(-800)}`));
    }, 50_000);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(readFileSync(output, "utf8")));
      } catch {
        reject(new Error(`Electron resize settlement live 실패(code=${code}): ${stderr.slice(-800)}`));
      }
    });
  });
}

describe("Electron live resize settlement", () => {
  it("비포커스 창의 적대 resize에서도 slot·surface·guest viewport가 매 단계 같은 크기다", async () => {
    const result = await runLive();
    expect(result.error).toBeUndefined();
    expect(result.samples).toHaveLength(4);
    expect(result.samples.map((sample) => sample.receipt.transactionGeneration)).toEqual([1, 2, 3, 4]);
    expect(result.samples.map((sample) => sample.receipt.settledRevision)).toEqual([1, 2, 3, 4]);

    for (const sample of result.samples) {
      expect(sample.receipt.status).toBe("settled");
      expect(sample.receipt.renderer.presentationRevision).toBeGreaterThan(0);
      expect(sample.receipt.surfaces[0].presentationRevision).toBeGreaterThan(0);
      expect(sample.receipt.renderer.proof.transactionGeneration).toBe(sample.receipt.transactionGeneration);
      expect(sample.receipt.surfaces[0].proof.transactionGeneration).toBe(sample.receipt.transactionGeneration);
      expect(sample.receipt.renderer.proof.frameSize).toEqual(sample.receipt.renderer.proof.expectedPhysical);
      expect(sample.receipt.surfaces[0].proof.frameSize).toEqual(sample.receipt.surfaces[0].proof.expectedPhysical);
      expect(sample.host.slot).toEqual(sample.host.surface);
      expect(sample.host.surface.width).toBe(sample.host.viewport.width);
      expect(sample.host.surface.height).toBe(sample.host.viewport.height);
      expect(sample.guestViewport.width).toBe(sample.host.surface.width);
      expect(sample.guestViewport.height).toBe(sample.host.surface.height);
      expect(sample.host.layout.resizeRevision).toBeGreaterThan(0);
      expect(sample.host.layout.observerRevision).toBeGreaterThan(0);
      expect(sample.host.layout.lastObserved).toEqual({
        width: sample.host.viewport.width,
        height: sample.host.viewport.height,
      });
      expect(sample.receipt.native.outerDip.width).toBe(sample.receipt.requested.dip.width);
      expect(sample.receipt.native.outerDip.height).toBe(sample.receipt.requested.dip.height);
    }

    const restored = result.samples.at(-1);
    expect(restored.receipt.native.outerDip).toMatchObject({ width: 800, height: 600 });
  }, 60_000);
});
