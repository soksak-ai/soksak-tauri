# Vendored: xterm-addon-webkit-ime

WKWebView(Tauri/Safari) 한글·CJK IME 입력 보정 xterm.js 애드온.

## 저작권·라이선스 고지

- 저작자: yejune
- 프로젝트: xterm-addon-webkit-ime — https://github.com/yejune/xterm-addon-webkit-ime
- 고지 기준 commit: `863eb327ac9442ba11093c51994ca180e8812be0`
- 라이선스: MIT

## 벤더링 이유

npm 미배포 + 저장소에 `dist` 빌드 산출물·`prepare` 스크립트가 없어 git 설치로는 빌드되지 않는다. 단일 파일(`index.ts`) TS 소스라 프로젝트에 직접 포함해 Vite가 함께 번들한다.

## 갱신 계약

`index.ts`를 변경할 때는 Xterm 6 타입 경계, WKWebView 조합 이벤트, 중복 입력 방지 테스트를 같은
변경에서 통과시키고 고지 기준 commit을 갱신한다.
