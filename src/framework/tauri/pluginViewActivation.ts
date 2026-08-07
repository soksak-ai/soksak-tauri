/**
 * 문서 밖 renderer 에서 플러그인을 살리는 한 자리, 그리고 그 결과를 부모가 읽는 한 신호.
 *
 * 왜 여기 있나: nativeSurface 뷰의 플러그인 본체는 자식 renderer 안에서 활성된다. 그 안에서
 * 던져진 예외는 자식 webview 의 unhandled rejection 으로 끝나 부모에게 한 글자도 남기지
 * 않았다(실측 2026-08-07: browser-chromium-offscreen 이 renderer 에서 app.commands.register
 * 를 불러 그 자리에서 죽었고, 뒤따르는 registerView 가 영영 실행되지 않아 뷰 자체가 없었다).
 * 부모의 준비 약속은 영원히 pending 이 되고, tab.open 은 이유 없는 mounted:false 를 답하며,
 * 눈에 보이는 것은 한참 뒤 다른 명령의 NO_VIEW 뿐이었다 — 증상이 소유자를 가렸다.
 *
 * 실패는 성공값으로도, 침묵으로도 표현될 수 없다. 못 살렸으면 그 사실을 이름과 함께 낸다.
 */

export interface PluginViewActivationFailure {
  pluginId: string;
  reason: string;
}

interface PluginViewActivationInput {
  pluginId: string;
  /** 플러그인 모듈을 가져온다. 이 함수의 실패도 활성 실패다. */
  load: () => Promise<unknown>;
  /** 플러그인 activate 가 받을 컨텍스트. 이 모듈은 내용을 해석하지 않는다. */
  context: unknown;
  report: (failure: PluginViewActivationFailure) => void;
}

function reasonOf(error: unknown): string {
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}

/**
 * 자식 renderer 안에서 플러그인 하나를 활성한다. 성공이면 참, 실패면 보고하고 거짓.
 * 던지지 않는다 — 호출자는 renderer 부팅 경로라 던져 봐야 받을 사람이 없다.
 */
export async function activatePluginInViewRenderer(
  input: PluginViewActivationInput,
): Promise<boolean> {
  try {
    const module = await input.load();
    const plugin = (module as { default?: unknown }).default ?? module;
    const activate = (plugin as { activate?: unknown })?.activate;
    if (typeof activate !== "function") {
      throw new Error("플러그인 모듈에 activate 가 없습니다");
    }
    await (activate as (context: unknown) => unknown).call(plugin, input.context);
    return true;
  } catch (error) {
    input.report({ pluginId: input.pluginId, reason: reasonOf(error) });
    return false;
  }
}

export interface PluginViewReadySignal {
  /** 그 뷰가 명령을 받을 수 있게 된 시점에 완료된다. 실패하면 사유로 거절된다. */
  readonly ready: Promise<void>;
  /** 처음 정착시켰으면 참. 이미 정착했으면 거짓 — 늦은 신호가 앞선 사실을 덮지 않는다. */
  markReady(): boolean;
  markFailed(reason: string): boolean;
}

/** 준비는 한 번만 정착한다. 실패는 매달림이 아니라 이름 붙은 거절이다. */
export function createPluginViewReadySignal(): PluginViewReadySignal {
  let settle!: (error?: Error) => void;
  let settled = false;
  const ready = new Promise<void>((resolve, reject) => {
    settle = (error?: Error) => (error ? reject(error) : resolve());
  });
  const finish = (error?: Error): boolean => {
    if (settled) return false;
    settled = true;
    settle(error);
    return true;
  };
  return {
    ready,
    markReady: () => finish(),
    markFailed: (reason: string) => finish(new Error(reason)),
  };
}
