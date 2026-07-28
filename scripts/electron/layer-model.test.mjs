// @vitest-environment node
// 레이어 모델 스파이크 — Electron 에서 홀·hitTest 위임이 필요한가.
//
// Tauri/macOS 의 답은 z-순서 역전이다(webview.rs §레이어 원칙): DOM(메인 webview)이 항상
// 최상위이고 자식 webview 를 그 아래로 내린 뒤, 메인이 배경을 안 칠해 투명 슬롯으로 아래가
// 비치게 한다. 마우스는 hitTest 가 위임한다 — 홀 안이면 아래 webview 가 받는다.
//
// 목적은 배치가 아니라 겹침이다 — 모달·메뉴·드롭 인디케이터를 브라우저 **위에** 그리기
// 위해서다.
//
// 이 파일이 재는 것은 **WebContentsView 를 골랐을 때**의 사실이다: 그 길에는 뷰 단위 히트
// 위임이 없다. 그러나 그것이 "Electron 도 같은 문제를 갖는다"는 뜻은 아니다 — 홀·스위즐이
// 필요한 이유는 자식이 **네이티브 뷰**라 DOM 과 다른 컴포지터에 있기 때문이고, Electron 에는
// 자식을 DOM 안에 두는 길(<webview> 태그, HTMLElement)이 따로 있다. 그 길에서는 겹침이
// z-index 로 환원되어 문제 자체가 발생하지 않는다 — overlay-stacking.test.mjs 가 픽셀로 잰다.
//
// 그러므로 이 표는 "Electron 이 못 한다"가 아니라 **"WebContentsView 로 Tauri 모델을 흉내내지
// 마라"** 로 읽어야 한다. 흉내내면 뷰 단위 수단이 없어 막히고, 흉내낼 이유도 없다.
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require_ = createRequire(import.meta.url);

/** Electron 의 뷰 API 표면 — 무엇으로 층을 쌓을 수 있는지가 답의 전제다. */
function electronSurface() {
  const pkg = require_("electron/package.json");
  return { version: pkg.version };
}

/** electron.d.ts 에서 한 클래스의 메서드 이름을 뽑는다 — 문서가 아니라 배포된 타입이 답이다. */
function methodsOf(className) {
  const d = readFileSync(require_.resolve("electron/electron.d.ts"), "utf8").split("\n");
  const start = d.findIndex((l) => new RegExp(`^  class ${className}\\b`).test(l));
  if (start < 0) throw new Error(`클래스를 못 찾았다: ${className}`);
  const out = [];
  for (let i = start + 1; i < d.length; i++) {
    if (/^  class /.test(d[i]) || /^  \}/.test(d[i])) break;
    const m = d[i].match(/^\s{4}([A-Za-z][A-Za-z0-9]*)\(/);
    if (m) out.push(m[1]);
  }
  return out;
}

describe("레이어 모델 — 겹침에서 무엇이 위에 오는가", () => {
  it("Electron 버전이 WebContentsView 를 갖는 대(帶)에 있다", () => {
    // WebContentsView + contentView.addChildView 는 Electron 30 에서 들어왔다.
    // 그 이전이면 BrowserView 뿐이고 층 쌓기 규칙이 다르다 — 전제부터 갈린다.
    const { version } = electronSurface();
    const major = Number(version.split(".")[0]);
    expect(Number.isFinite(major)).toBe(true);
    expect(major).toBeGreaterThanOrEqual(30);
  });

  // 오라클 생존 — 파서가 죽으면 아래 단언들이 "없다"를 공짜로 통과시킨다(0 의 두 얼굴).
  it("타입 파서가 실제로 표면을 읽는다", () => {
    expect(methodsOf("View")).toContain("addChildView");
    expect(methodsOf("BaseWindow")).toContain("setIgnoreMouseEvents");
  });

  // 여기가 판정이다. Tauri/macOS 는 hitTest 를 스위즐해 **홀 안이면 아래 webview 가 받게**
  // 위임한다. 같은 일을 하려면 뷰 단위로 "이 영역은 통과시켜라"를 말할 수 있어야 한다.
  it("Electron 의 View 에는 per-view 히트 위임이 없다", () => {
    const view = methodsOf("View");
    for (const absent of [
      "setIgnoreMouseEvents", // 창 단위로만 있다
      "setHitTestRegions",
      "setMouseEventsEnabled",
    ]) {
      expect(view).not.toContain(absent);
    }
    // 있는 것은 기하와 그리기뿐이다 — 겹침에서 입력을 가를 수단이 아니다.
    expect(view).toEqual(
      expect.arrayContaining(["addChildView", "setBounds", "setBackgroundColor", "setVisible"]),
    );
  });

  // 그래서 통과는 **창 단위**로만 말할 수 있다. 창 하나에 UI 와 콘텐츠가 같이 사는 우리
  // 배치에서는 쓸 수 없다 — 창 전체를 통과시키면 UI 도 같이 못 받는다.
  it("통과 지정은 창 단위뿐이다", () => {
    expect(methodsOf("BaseWindow")).toContain("setIgnoreMouseEvents");
    expect(methodsOf("View")).not.toContain("setIgnoreMouseEvents");
  });
});
