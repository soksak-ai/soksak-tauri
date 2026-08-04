// @vitest-environment node
// 캡처 갈래 — 창의 픽셀을 값으로 낸다.
//
// 이 갈래가 없어서 R3(UI 는 시각 검증한다)를 이 프레임워크에서 지킬 수 없었다. 검증에 필요한
// 노출면이 없으면 **먼저 만든다** — 눈으로 본 척하고 넘어가는 것이 이 규칙이 막으려는 일이다.
//
// Electron 은 띄우지 않는다. 표는 electron 을 require 하지 않고 창을 문맥으로 받으므로,
// capturePage 를 흉내내는 창 하나로 그대로 몰 수 있다.
//
// 여기서 고정하는 것은 셋이다: ① 빈 캡처를 성공으로 올리지 않는다(그 성공은 "화면이 검다"로만
// 보인다), ② rect 는 CSS px 그대로 간다(단위를 바꾸면 잘린 자리가 조용히 어긋난다),
// ③ 캡처가 창을 앞으로 내지 않는다(사용자가 보던 화면이 캡처 때문에 바뀌면 안 된다).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireCjs = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const native = requireCjs(join(HERE, "../../frameworks/electron/native/index.cjs"));

const SNAPSHOT = "plugin:webview-capture|snapshot";
const REGION = "plugin:webview-capture|snapshot_region";
const OCCLUSION = "plugin:webview-capture|set_occlusion";

/** 실제 PNG 바이트 — 파일이 그대로 쓰였는지 보는 표식. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

let root;
let demands;

const record = (cmd, served, code) => demands.push({ cmd, served, code });

/** capturePage 를 흉내내는 창. 무엇으로 불렸는지·앞으로 나갔는지를 남긴다. */
function fakeWindow({ png = PNG_BYTES, empty = false } = {}) {
  const calls = [];
  const captureOptions = [];
  let focused = false;
  let throttling = null;
  const win = {
    isDestroyed: () => false,
    focus: () => {
      focused = true;
    },
    webContents: {
      on: () => {},
      capturePage: async (rect, opts) => {
        calls.push(rect); // 받은 그대로 — 없음(undefined)과 null 을 뭉개면 단위 검사가 무의미해진다
        captureOptions.push(opts);
        return {
          isEmpty: () => empty,
          toPNG: () => (empty ? Buffer.alloc(0) : png),
        };
      },
      setBackgroundThrottling: (v) => {
        throttling = v;
      },
    },
  };
  return {
    calls,
    captureOptions,
    win,
    get focused() {
      return focused;
    },
    get throttling() {
      return throttling;
    },
  };
}

const ctxFor = (w) => ({ window: w.win, surfaces: () => [], labels: () => [] });

const serve = (cmd, args, w) => native.serve(cmd, args, ctxFor(w), record);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "soksak-capture-"));
  demands = [];
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("캡처 — 창의 픽셀을 값으로", () => {
  it("파일 모드는 PNG 를 그 경로에 쓰고 경로를 답한다", async () => {
    const w = fakeWindow();
    const out = join(root, "shots", "a.png");
    const r = await serve(SNAPSHOT, { path: out }, w);
    expect(r.ok).toBe(true);
    expect(r.value).toBe(out);
    // 부모 폴더는 만들어 준다 — 앱의 같은 명령과 같은 약속이다.
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out)).toEqual(PNG_BYTES);
    expect(w.calls).toEqual([undefined]);
  });

  it("영역 모드는 rect 를 CSS px 그대로 넘기고 base64 를 답한다", async () => {
    const w = fakeWindow();
    const r = await serve(REGION, { x: 10.4, y: 20.6, w: 100, h: 50 }, w);
    expect(r.ok).toBe(true);
    expect(r.value).toBe(PNG_BYTES.toString("base64"));
    // 단위를 바꾸면 잘린 자리가 조용히 어긋난다 — 반올림만 한다.
    expect(w.calls).toEqual([{ x: 10, y: 21, width: 100, height: 50 }]);
  });

  it("rect 없이 부르면 창 전체다", async () => {
    const w = fakeWindow();
    const r = await serve(REGION, {}, w);
    expect(r.ok).toBe(true);
    expect(w.calls).toEqual([undefined]);
  });

  it("빈 캡처는 성공이 아니다 — 그 성공은 화면이 검다로만 보인다", async () => {
    const w = fakeWindow({ empty: true });
    const r = await serve(SNAPSHOT, { path: join(root, "b.png") }, w);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("FRAMEWORK_EMPTY_CAPTURE");
    expect(existsSync(join(root, "b.png"))).toBe(false);
    expect(demands.at(-1)).toMatchObject({ served: false, code: "FRAMEWORK_EMPTY_CAPTURE" });
  });

  it("망가진 rect 는 이름을 달고 거절한다 — 지어낸 사각형으로 담지 않는다", async () => {
    const w = fakeWindow();
    for (const bad of [
      { x: 0, y: 0, w: 0, h: 10 },
      { x: 0, y: 0, w: 10, h: -1 },
      { x: "a", y: 0, w: 10, h: 10 },
    ]) {
      const r = await serve(REGION, bad, w);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(r.code).toBe("FRAMEWORK_BAD_RECT");
    }
    expect(w.calls).toEqual([]);
  });

  it("창이 없으면 이름을 달고 실패한다 — 빈 PNG 를 답하지 않는다", async () => {
    const r = await native.serve(SNAPSHOT, { path: join(root, "c.png") }, { window: null }, record);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("FRAMEWORK_NO_WINDOW");
  });

  it("path 없이 파일 모드를 부르면 지어내지 않는다", async () => {
    const w = fakeWindow();
    const r = await serve(SNAPSHOT, {}, w);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID_PARAMS");
  });

  // 사용자 창 불가침 — 캡처가 포커스를 뺏으면 사용자가 보던 화면이 캡처 때문에 바뀐다.
  it("캡처는 창을 앞으로 내지 않는다", async () => {
    const w = fakeWindow();
    await serve(SNAPSHOT, { path: join(root, "d.png") }, w);
    await serve(REGION, { x: 0, y: 0, w: 5, h: 5 }, w);
    expect(w.focused).toBe(false);
  });

  it("비전면 캡처는 창을 포커스하지 않고 게스트 합성을 위해 캡처 동안 visible로 취급한다", async () => {
    const w = fakeWindow();
    await serve(SNAPSHOT, { path: join(root, "hidden.png") }, w);
    await serve(REGION, { x: 0, y: 0, w: 5, h: 5 }, w);
    expect(w.captureOptions).toEqual([
      { stayAwake: true },
      { stayAwake: true },
    ]);
  });

  it("가림 손잡이는 배경 스로틀을 민다 — 정지한 창은 옛 프레임을 담는다", async () => {
    const w = fakeWindow();
    expect((await serve(OCCLUSION, { enabled: false }, w)).ok).toBe(true);
    expect(w.throttling).toBe(false);
    expect((await serve(OCCLUSION, { enabled: true }, w)).ok).toBe(true);
    expect(w.throttling).toBe(true);
  });

  it("표가 이 갈래를 자기 것으로 주장한다 — 소켓으로 새지 않는다", () => {
    for (const cmd of [SNAPSHOT, REGION, OCCLUSION]) {
      expect(native.claims(cmd), cmd).toBe(true);
    }
  });
});
