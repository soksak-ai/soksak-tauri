// Tauri 프런트엔드 빌드의 유일한 어댑터 바인딩.
// 이 파일은 Vite alias `#framework-adapter`가 선택한다. 런타임 추측이나 상대 프레임워크
// fallback은 없다: 어떤 프레임워크인지 결정하는 책임은 그 프레임워크의 빌드에 있다.
export { tauriFramework as selectedFramework } from "./tauri";
