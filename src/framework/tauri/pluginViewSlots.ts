import type { PluginViewSlotFrame } from "./pluginViewProtocol";

interface Waiter {
  resolve(frame: PluginViewSlotFrame): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** child renderer의 slot 보고와 surface open 요청을 사건으로 합류시킨다. */
export class PluginViewSlotRegistry {
  readonly #frames = new Map<string, PluginViewSlotFrame>();
  readonly #waiters = new Map<string, Set<Waiter>>();

  report(frame: PluginViewSlotFrame): void {
    this.#frames.set(frame.label, frame);
    const waiters = this.#waiters.get(frame.label);
    if (!waiters) return;
    this.#waiters.delete(frame.label);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    }
  }

  frame(label: string): PluginViewSlotFrame | undefined {
    return this.#frames.get(label);
  }

  wait(label: string, timeoutMs = 10_000): Promise<PluginViewSlotFrame> {
    const current = this.#frames.get(label);
    if (current) return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.get(label)?.delete(waiter);
          reject(new Error(`plugin renderer content slot 시간 초과: ${label} (${timeoutMs}ms)`));
        }, timeoutMs),
      };
      const waiters = this.#waiters.get(label) ?? new Set<Waiter>();
      waiters.add(waiter);
      this.#waiters.set(label, waiters);
      // 등록 직전 report와의 경쟁을 닫는다.
      const raced = this.#frames.get(label);
      if (raced) this.report(raced);
    });
  }

  dispose(): void {
    const error = new Error("plugin renderer slot registry가 종료되었습니다");
    for (const waiters of this.#waiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.#waiters.clear();
    this.#frames.clear();
  }
}
