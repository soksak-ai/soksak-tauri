/**
 * realm 신원 선언 — 이 app 이 어느 realm 에 살고, 그 realm 에서 무엇을 부를 수 있는가.
 *
 * 왜 있나: 같은 플러그인 번들이 두 realm 에서 평가된다. 하나는 창 문서, 하나는 nativeSurface
 * 뷰의 자식 renderer 다. 두 realm 의 app 표면은 같지 않다 — 자식은 창 단위 등록(command·view
 * 등록부)을 소유하지 않고 실행만 소비한다. 지금까지 그 차이는 어디에도 적혀 있지 않았고,
 * 플러그인은 `typeof app.commands?.register === "function"` 같은 더듬기로 알아냈다. 세 브라우저
 * 플러그인이 같은 부재를 각자 다르게 더듬어 둘은 통과하고 하나는 그 자리에서 죽었다
 * (실측 2026-08-07: browser-chromium-offscreen, "app.commands.register is not a function").
 *
 * 더듬기는 답이 아니다. realm 이 자기 신원과 능력을 선언으로 답한다.
 *
 * 선언은 손으로 적지 않는다. 소비처가 나열한 목록은 반드시 하나 빠지고, 빠진 하나는 조용히
 * 거짓말이 된다. 능력 목록은 실제 app 객체에서 파생하므로 객체와 어긋날 수 없다.
 */

export type PluginRealmId =
  /** 창 문서에서 평가된 app. 창 단위 등록부의 소유자다. */
  | "window"
  /** nativeSurface 뷰의 자식 renderer 에서 평가된 app. 부모에게 RPC 로 위임한다. */
  | "view-renderer";

export interface PluginRealm {
  readonly id: PluginRealmId;
  /** 이 realm 에서 부를 수 있는 이름 전수(점 표기, 정렬). app 객체에서 파생된다. */
  readonly capabilities: readonly string[];
  /**
   * 부를 이름을 그대로 물어라. 네임스페이스가 있다고 그 안이 다 있는 것은 아니다 —
   * `supports("commands")` 는 거짓이고 `supports("commands.execute")` 가 답이다.
   */
  supports(capability: string): boolean;
}

/** realm 은 답이지 능력이 아니다 — 자기 자신은 목록에 세지 않는다. */
const REALM_KEY = "realm";
/** data.kv.get 이 가장 깊다. 그보다 깊은 중첩은 app 표면이 아니라 값이다. */
const MAX_DEPTH = 4;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * app 객체가 실제로 들고 있는 호출 가능한 이름 전수를 낸다.
 *
 * 접근자는 세지 않고 읽지도 않는다 — 세는 행위가 부작용을 내면 그 계측은 관측이 아니다.
 */
export function pluginRealmCapabilities(app: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown, prefix: string, depth: number): void => {
    if (depth > MAX_DEPTH || !isPlainObject(node)) return;
    for (const key of Object.keys(node)) {
      if (!prefix && key === REALM_KEY) continue;
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (!descriptor || !("value" in descriptor)) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof descriptor.value === "function") found.add(path);
      else walk(descriptor.value, path, depth + 1);
    }
  };
  walk(app, "", 1);
  return [...found].sort();
}

/**
 * 이 app 이 사는 realm 을 선언으로 붙인다. 한 app 은 realm 하나다 — 두 번째 선언은 거절한다.
 */
export function declarePluginRealm<T extends object>(
  id: PluginRealmId,
  app: T,
): T & { realm: PluginRealm } {
  const capabilities: readonly string[] = Object.freeze(pluginRealmCapabilities(app));
  const declared = new Set(capabilities);
  const realm: PluginRealm = Object.freeze({
    id,
    capabilities,
    supports: (capability: string) => declared.has(capability),
  });
  Object.defineProperty(app, REALM_KEY, {
    value: realm,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  return app as T & { realm: PluginRealm };
}
