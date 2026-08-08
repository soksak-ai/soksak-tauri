// @vitest-environment node
// 구멍은 픽셀만 비우는 게 아니라 **입력도** 비운다.
//
// 콘텐츠가 네이티브 자식 웹뷰로 사는 뷰는 그 자리에 구멍을 낸다. 지금 그 구멍은 배경만
// 투명하게 한다 — 그러면 자식이 **보이기는 하는데 눌리지는 않는다.**
//
// 자식 표면은 메인 DOM 웹뷰 **아래**에 깔린다(layer.rs: `NSWindowOrderingMode::Below` — 위로
// 올리면 사이드바·모달을 덮으므로 그 결정은 옳다). 그래서 그 자리의 클릭은 위에 있는 메인
// 웹뷰가 먼저 받고, 거기에 그려진 컨테이너가 사건을 먹는다. 자식은 구조적으로 클릭을 못 받는다.
//
// 실측 2026-08-08: 브라우저 세 종의 주소줄이 그랬다. 커서는 프로그램으로 넣으면 들어가는데
// (`activeElement=urlbar`) 그 문서는 키보드를 못 받았고(`realmFocused=false`), 사람이 눌러도
// 아무 일도 없었다. 합성면이 아니므로 남는 답은 하나다 — 호스트가 그 자리를 비켜야 한다.
//
// 비우는 것은 **구멍뿐**이다. 조상까지 비우면 그 위의 크롬·오버레이가 같이 안 눌린다.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "./styles.css"), "utf8");

/** 이 셀렉터 블록이 든 선언. */
function block(selector: string): string {
  const at = css.indexOf(selector);
  if (at < 0) return "";
  const open = css.indexOf("{", at);
  return open < 0 ? "" : css.slice(open, css.indexOf("}", open) + 1);
}

describe("네이티브 자식이 사는 구멍은 입력을 통과시킨다", () => {
  it("콘텐츠 구멍이 포인터 사건을 안 먹는다", () => {
    expect(block(`[data-tauri-hole="content"]`)).toMatch(/pointer-events:\s*none/);
  });

  it("구멍 프레임도 안 먹는다 — 프레임이 먹으면 구멍까지 못 간다", () => {
    expect(block(`.tab-body[data-tauri-hole-frame]`)).toMatch(/pointer-events:\s*none/);
  });

  // 비우는 것은 구멍뿐이다. 조상을 비우면 그 위의 호스트 크롬이 같이 죽는다.
  it("구멍이 아닌 컨테이너까지 비우지 않는다", () => {
    expect(block(".tab-viewer.transparent")).not.toMatch(/pointer-events:\s*none/);
  });
});
