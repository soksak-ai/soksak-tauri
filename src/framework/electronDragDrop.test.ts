// 창 드래그드롭 — 부팅이 밟는 자리다.
//
// 활동 원장 실측(2026-07-28): boot plugin-body:begin 직후
// `reject: Error: Electron 어댑터 미구현: 창 드래그드롭(onDragDrop)` 이 뜨고 unhandledrejection
// 으로 이어졌다. 앱은 부팅에서 이 구독을 건다(App.tsx) — 미구현이면 그 자리에서 부팅 경로가
// 예외를 던진다.
//
// Tauri 는 네이티브 창 이벤트로 받는다. Electron 은 그럴 필요가 없다 — 파일 드롭이 DOM 으로
// 그대로 온다(dataTransfer.files 의 항목이 경로를 갖는다). 페이로드 모양은 앱의 것 그대로여야
// 한다: { payload: { type: "drop", paths } }. 번역하면 소비자가 프레임워크마다 다른 것을 본다.
import { beforeEach, describe, expect, it, vi } from "vitest";

async function load() {
  vi.resetModules();
  return import("./electron");
}

/** preload 창구 — 어댑터가 붙었는지만 보는 최소 스텁. */
function installBridge() {
  (globalThis as unknown as Record<string, unknown>).__soksakFramework = {
    invoke: async () => ({ ok: true, value: null }),
    host: async () => ({ ok: true, value: null }),
    window: async () => ({ ok: true, value: null }),
    label: "main",
    on: () => () => {},
  };
}

function dropEvent(paths: string[]) {
  const e = new Event("drop", { bubbles: true, cancelable: true }) as Event & {
    dataTransfer: unknown;
  };
  Object.defineProperty(e, "dataTransfer", {
    value: { files: paths.map((p) => ({ path: p, name: p.split("/").pop() })) },
  });
  return e;
}

describe("창 드래그드롭 — DOM 이 그대로 준다", () => {
  beforeEach(() => {
    installBridge();
    document.body.innerHTML = "";
  });

  it("드롭이 앱의 페이로드 모양으로 온다", async () => {
    const m = await load();
    const seen: unknown[] = [];
    const off = await m.electronFramework.currentWindow().onDragDrop((e) => seen.push(e));

    document.dispatchEvent(dropEvent(["/a/b.txt", "/c/d.log"]));
    expect(seen).toEqual([{ payload: { type: "drop", paths: ["/a/b.txt", "/c/d.log"] } }]);

    // 해지는 실제로 끊는다 — 안 끊으면 창을 닫아도 구독이 남아 죽은 창에 보낸다.
    off();
    document.dispatchEvent(dropEvent(["/x"]));
    expect(seen).toHaveLength(1);
  });

  it("경로 없는 드롭은 보내지 않는다 — 빈 배열은 소비자에게 의미가 없다", async () => {
    const m = await load();
    const seen: unknown[] = [];
    await m.electronFramework.currentWindow().onDragDrop((e) => seen.push(e));
    document.dispatchEvent(dropEvent([]));
    expect(seen).toEqual([]);
  });

  // 브라우저 기본 동작은 파일을 창에 **열어 버린다** — 앱이 사라진다. 반드시 막는다.
  it("기본 동작을 막는다", async () => {
    const m = await load();
    await m.electronFramework.currentWindow().onDragDrop(() => {});
    const e = dropEvent(["/a"]);
    document.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    // dragover 도 막아야 drop 이 아예 발생한다.
    const over = new Event("dragover", { bubbles: true, cancelable: true });
    document.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
  });
});
