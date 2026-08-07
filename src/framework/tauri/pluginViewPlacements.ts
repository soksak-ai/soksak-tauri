import type { PluginViewPlacementFrame } from "./pluginViewProtocol";

type PlacementListener = (frame: PluginViewPlacementFrame) => void;

/**
 * 호스트가 native member surface 에 적용한 프레임이 사는 자리 — child renderer 쪽 수신단.
 *
 * 배치의 소유자는 PaneSurfaceHost 다. 그래서 그 자리에 사는 표면(엔진 서피스)은 자기 프레임을
 * 스스로 알 방법이 없고, 슬롯을 다시 재면 같은 자리를 두 기준으로 재는 쫓아가는 복사본이 된다.
 * 적용한 쪽이 적용한 값을 그대로 알리고, 여기는 그 값을 옮기기만 한다.
 *
 * 늦게 듣는 자는 못 들은 것이 아니다. 표면은 만들어진 뒤에야 자기 배치를 구독할 수 있고,
 * 만드는 거래 안에서 일어난 첫 적용이 곧 그 표면의 첫 프레임이다 — 담는 자리와 함께
 * "채웠다는 기억"을 둔다.
 */
export class PluginViewPlacementRegistry {
  readonly #applied = new Map<string, PluginViewPlacementFrame>();
  readonly #listeners = new Map<string, Set<PlacementListener>>();
  #disposed = false;

  /** 호스트가 그 프레임을 실제로 적용한 뒤에만 부른다. */
  commit(frame: PluginViewPlacementFrame): void {
    if (this.#disposed) return;
    const previous = this.#applied.get(frame.label);
    if (previous && previous.revision > frame.revision) return;
    this.#applied.set(frame.label, frame);
    for (const listener of [...(this.#listeners.get(frame.label) ?? [])]) listener(frame);
  }

  /** 이 label 에 마지막으로 적용된 프레임. 적용이 없었으면 undefined — 0 으로 답하지 않는다. */
  applied(label: string): PluginViewPlacementFrame | undefined {
    return this.#applied.get(label);
  }

  subscribe(label: string, listener: PlacementListener): { dispose(): void } {
    if (this.#disposed) return { dispose() {} };
    const listeners = this.#listeners.get(label) ?? new Set<PlacementListener>();
    listeners.add(listener);
    this.#listeners.set(label, listeners);
    const current = this.#applied.get(label);
    if (current) listener(current);
    return {
      dispose: () => {
        const current = this.#listeners.get(label);
        if (!current) return;
        current.delete(listener);
        if (current.size === 0) this.#listeners.delete(label);
      },
    };
  }

  dispose(): void {
    this.#disposed = true;
    this.#listeners.clear();
    this.#applied.clear();
  }
}
