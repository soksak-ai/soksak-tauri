// Electron 프런트엔드 빌드의 유일한 어댑터 바인딩.
// Tauri 어댑터를 함께 import한 뒤 런타임에서 고르는 구조는 선택하지 않은 구현까지 번들에
// 넣으므로 금지한다. 이 잎에서 Electron 하나만 정적으로 연결한다.
export { electronFramework as selectedFramework } from "./electron";
