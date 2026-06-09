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

## 이 저장소의 추가 동작

- GUARD 5는 조합 중 Enter/Tab/Esc/Ctrl+A-Z를 한 번만 커밋·전송하고 `_customKey`로 Xterm의 중복
  처리를 막는다.

## 알려진 미해결 버그 (capture 1회 필요)

- **공백 뒤 + 받침 붙는 음절이 받침 없는 형태를 흘림.** 재현: 단어 뒤 공백 후 받침이 추가되는 음절 입력.
  - `있습니다` → `이있습니다` (이 누출)
  - `갔습니다` → `가갔습니다` (가 누출)
  - `했습니다` → `해했습니다` (해 누출)
  - 패턴: 받침 추가 순간(이→있) 중간 완성음절이 xterm onData echo 로 새고 GUARD 1/2 가 못 잡음으로 추정. 정확한 수정엔 실제 WKWebView 이벤트 트레이스(beforeinput/input/onData+skip) 1회 캡처 필요.
