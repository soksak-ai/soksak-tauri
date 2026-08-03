// 테스트의 중립 어댑터. 제품 프레임워크를 흉내내지 않는다: 구체 프레임워크 동작이 필요한 테스트는
// 해당 어댑터를 직접 import하거나 명시적으로 mock한다. 공통 모듈이 우연히 Tauri를 기준으로
// 적재되는 것을 막는 것이 이 구현의 목적이다.
import type { AppFramework, FrameworkWindowHandle } from "./contract";

const unsupported = async (): Promise<never> => {
  throw new Error("중립 테스트 어댑터에는 제품 프레임워크 기능이 없습니다");
};

const testWindow: FrameworkWindowHandle = {
  // 기존 테스트 계약은 런타임 밖 현재 창을 빈 라벨로 표현한다. 중립 어댑터가 제품 identity를
  // 지어내면 모든 명령 응답과 브라우저 라벨이 오염된다.
  label: "",
  setTitle: unsupported,
  setSize: unsupported,
  setPosition: unsupported,
  setFocus: unsupported,
  setTheme: unsupported,
  outerPosition: unsupported,
  innerPosition: unsupported,
  outerSize: unsupported,
  scaleFactor: unsupported,
  setPhysicalPosition: unsupported,
  setPhysicalSize: unsupported,
  setAlwaysOnTop: unsupported,
  maximize: unsupported,
  unmaximize: unsupported,
  onResized: unsupported,
  onMoved: unsupported,
  onDragDrop: unsupported,
  listen: unsupported,
};

export const selectedFramework: AppFramework = {
  name: "test",
  dragRegion: {},
  engineProvision: {
    chromium: false,
    nativeChildWebview: false,
    engineModules: false,
    supportsDocumentStart: false,
    supportsInputInjection: false,
  },
  emitLocal: () => {},
  install: async () => {},
  invoke: unsupported,
  createStream: () => ({ onmessage: () => {} }),
  listen: unsupported,
  currentWindow: () => testWindow,
  windowByLabel: unsupported,
  app: { name: unsupported, version: unsupported },
  path: { tempDir: unsupported, join: unsupported },
  dialog: { openDirectory: unsupported },
  notification: {
    isPermissionGranted: unsupported,
    requestPermission: unsupported,
    send: () => {},
    onAction: unsupported,
  },
  deepLink: { onOpenUrl: unsupported, current: unsupported },
};
