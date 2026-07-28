// 선언적 벤더 누출 스윕 — 게이트가 쓰는 순수 로직.
//
// import 누출은 정적으로 잡기 쉽고 실패도 시끄럽다(모듈을 못 찾으면 빌드가 죽는다). 반면
// **선언적** 누출은 아무것도 던지지 않는다: 속성은 뜻 없이 앉아 있고, CSS 속성은 무시되고,
// 없는 전역은 `undefined` 일 뿐이다. 부르는 쪽이 없으면 그냥 아무 일도 안 일어난다.
//
// 그래서 종류를 **전부 적어야** 한다. 증상을 듣고 그 하나만 찾는 것은 다음에도 증상을
// 기다린다는 뜻이다 — 실제로 `data-tauri-drag-region` 을 그렇게 찾았다(2026-07-28,
// 사용자가 "헤더가 안 끌린다"고 보고할 때까지 아무 로그도 없었다).

/** 벤더가 선언으로 새는 자리. 새 프레임워크를 붙일 때 그쪽 것도 여기 적는다. */
export const VENDOR_DECL: { re: RegExp; what: string }[] = [
  { re: /data-tauri-[a-z-]+/g, what: "Tauri 웹뷰가 가로채는 속성" },
  { re: /-webkit-app-region/g, what: "Electron 창 드래그 CSS" },
  { re: /__TAURI__|__TAURI_INTERNALS__/g, what: "Tauri 주입 전역" },
  { re: /tauri:\/\//g, what: "Tauri URL 스킴" },
  { re: /asset:\/\//g, what: "Tauri 에셋 프로토콜" },
  { re: /convertFileSrc/g, what: "Tauri 에셋 URL 변환" },
  { re: /window\.electron\b/g, what: "Electron 주입면" },
];

/**
 * 주석을 지운다 — 벤더 동작을 **설명하는** 문장까지 위반으로 잡으면 그 설명을 지우게 되고,
 * 다음 사람이 왜 그 우회가 있는지 모르게 된다(실측: `asset://` 를 쓰지 **않는** 이유를 적어
 * 둔 주석이 걸렸다). 코드에 남은 것만이 누출이다.
 *
 * 줄 주석은 앞이 `:`·따옴표·단어문자가 아닐 때만 센다 — `tauri://` 의 `//` 를 주석으로 보면
 * 그 스킴 누출을 영영 못 잡는다.
 */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:"'`\w])\/\/.*$/, "$1"))
    .join("\n");
}

/** 한 파일에서 찾은 누출들. 빈 배열이면 깨끗하다. */
export function leaksIn(rel: string, source: string): string[] {
  const body = stripComments(source);
  const out: string[] = [];
  for (const { re, what } of VENDOR_DECL) {
    for (const m of body.matchAll(new RegExp(re.source, "g"))) {
      out.push(`${rel} → ${m[0]} (${what})`);
    }
  }
  return out;
}
