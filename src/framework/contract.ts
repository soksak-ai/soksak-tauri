import type { EngineProvision } from "@soksak-ai/plugin-spec";
// 앱 프레임워크 계약 — 앱이 "어떤 프레임워크 위에서 도는가"를 모르게 하는 경계.
//
// 여기서 프레임워크는 Tauri·Electron 이다. 창·웹뷰 생성, IPC, 네이티브 API, 패키징을
// 함께 주는 것이라 그 전부를 담는 말이 프레임워크다. 한때 이것을 "셸"이라 불렀는데
// 그 말은 이미 로그인 셸(zsh·bash)의 것이고, 이 저장소는 PTY·터미널을 핵심으로 다뤄
// 그 충돌이 실재한다(login_shell.rs·--login-shell·shell_which).
//
// 원칙: 앱 코드는 프레임워크 벤더 SDK 를 직접 부르지 않는다. 부르면 그 순간 그것이 교체 불가능한
// 전제가 되고, 교체 시도는 57개 파일을 동시에 뜯는 일이 된다(실측 2026-07-27: @tauri-apps
// 를 직접 import 하던 파일 57개, invoke 호출 193곳). 벤더를 아는 파일은 어댑터 하나뿐이며
// 그 규칙은 정적 게이트(frameworkSeam.test.ts)가 시행한다.
//
// 이 파일에는 **실제로 쓰이는 것만** 있다. 쓰지 않는 능력을 미리 선언하면 어댑터마다
// 구현할 수 없는 빈칸이 생기고, 빈칸은 결국 벤더 우회로 메워진다.

/** 구독 해지 — 멱등해야 한다(중복 호출이 던지지 않는다). */
export type Unlisten = () => void;

/** 이벤트 봉투 — 셸마다 필드가 다르므로 payload 하나로 좁힌다. */
export interface ShellEvent<T> {
  payload: T;
}

/**
 * 스트림 수신구. 코어가 만들어 명령 인자로 넘기면 백엔드가 프레임을 밀어 넣는다
 * (터미널 출력·프로세스 stdout/stderr·소켓 메시지). 인자로 직렬화되는 형태는 셸마다
 * 다르므로 **불투명**하다 — 앱은 onmessage 만 안다.
 */
export interface Stream<T> {
  onmessage: (msg: T) => void;
}

/** 창 하나에 대한 조작면 — 현재 창이거나 라벨로 찾은 창. */
export interface ShellWindowHandle {
  readonly label: string;
  setTitle(title: string): Promise<void>;
  /** 논리 픽셀(스케일 나눈 값) — 물리 픽셀은 셸이 환산한다. */
  setSize(width: number, height: number): Promise<void>;
  setPosition(x: number, y: number): Promise<void>;
  setFocus(): Promise<void>;
  /** 창 크롬(네이티브 외장)의 밝기 모드. 비지원 플랫폼은 무해히 무시한다. */
  setTheme(mode: "light" | "dark"): Promise<void>;
  /** 물리 픽셀 축 — 자동화·복원이 화면 좌표를 그대로 다룰 때 쓴다(논리 축과 별개). */
  outerPosition(): Promise<{ x: number; y: number }>;
  /** 창 내용 영역의 화면 좌표(물리) — 창 크롬을 뺀 원점. */
  innerPosition(): Promise<{ x: number; y: number }>;
  outerSize(): Promise<{ width: number; height: number }>;
  scaleFactor(): Promise<number>;
  setPhysicalPosition(x: number, y: number): Promise<void>;
  setPhysicalSize(width: number, height: number): Promise<void>;
  setAlwaysOnTop(on: boolean): Promise<void>;
  maximize(): Promise<void>;
  unmaximize(): Promise<void>;
  onResized(cb: (size: { width: number; height: number }) => void): Promise<Unlisten>;
  onMoved(cb: (pos: { x: number; y: number }) => void): Promise<Unlisten>;
  onDragDrop(cb: (event: unknown) => void): Promise<Unlisten>;
  /** 이 창으로 **타겟된** 이벤트만 받는다(전역 브로드캐스트 아님). */
  listen<T>(event: string, cb: (e: ShellEvent<T>) => void): Promise<Unlisten>;
}

export interface ShellNotification {
  isPermissionGranted(): Promise<boolean>;
  requestPermission(): Promise<string>;
  send(options: {
    title: string;
    body?: string;
    actionTypeId?: string;
    extra?: Record<string, unknown>;
  }): void;
  /** 알림 클릭 — 앱이 실제로 읽는 것은 발신 시 실은 extra 뿐이다(라우팅 정보). */
  onAction(cb: (action: { extra?: Record<string, unknown> }) => void): Promise<Unlisten>;
}

export interface AppFramework {
  /**
   * "이 요소를 끌면 창이 움직인다"를 프레임워크에 말하는 속성.
   *
   * 방식이 프레임워크마다 다르다. Tauri 는 웹뷰가 `data-tauri-drag-region` 속성을 가로채고,
   * Electron 은 CSS `-webkit-app-region: drag` 를 본다. 어느 쪽도 상대를 알지 못한다.
   *
   * 계약에 두는 이유: 이 실패는 **아무것도 남기지 않는다.** 틀린 표식은 던지지도 로그를 남기지도
   * 않고 그냥 창이 안 움직인다 — 오류로 보이지 않아 오래 안 보인다(실측 2026-07-28).
   * 요소에 그대로 펼치는 props 로 돌려주므로 앱은 무엇이 붙는지 몰라도 된다.
   */
  readonly dragRegion: Record<string, unknown>;

  /**
   * 이 프레임워크가 제공하는 것 — 플러그인의 요구(requiresEngine 등)를 채우는 쪽의 사실.
   *
   * 계약에 두는 이유: 어댑터가 빠뜨리면 컴파일이 막는다. 선택으로 두면 새 프레임워크가
   * 조용히 미신고 상태로 붙고, 그때 앱은 "요구가 없다"와 "모른다"를 구분하지 못한다.
   */
  readonly engineProvision: EngineProvision;

  /** 어댑터 이름 — 진단·원장에 싣는다("어느 셸에서 난 일인가"). */
  readonly name: string;

  /** 백엔드 명령 호출. 셸이 프로세스 내부 호출이든 소켓이든 앱은 모른다. */
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;

  /** 스트림 수신구 생성 — invoke 인자로 그대로 넘긴다. */
  createStream<T>(): Stream<T>;

  /** 전역(브로드캐스트) 이벤트 구독. 창 타겟 신호는 currentWindow().listen 을 쓴다. */
  listen<T>(event: string, cb: (e: ShellEvent<T>) => void): Promise<Unlisten>;

  currentWindow(): ShellWindowHandle;
  windowByLabel(label: string): Promise<ShellWindowHandle | null>;

  app: {
    name(): Promise<string>;
    version(): Promise<string>;
  };

  path: {
    tempDir(): Promise<string>;
    join(...parts: string[]): Promise<string>;
  };

  dialog: {
    /** 디렉터리 선택 — 취소는 null. */
    openDirectory(options?: { title?: string; defaultPath?: string }): Promise<string | null>;
  };

  notification: ShellNotification;

  deepLink: {
    onOpenUrl(cb: (urls: string[]) => void): Promise<Unlisten>;
    current(): Promise<string[] | null>;
  };
}
