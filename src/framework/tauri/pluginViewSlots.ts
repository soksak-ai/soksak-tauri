import type { PluginViewSlotFrame } from "./pluginViewProtocol";

interface Waiter {
  resolve(frame: PluginViewSlotFrame): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface CommitWaiter extends Waiter {
  rootW: number;
  rootH: number;
}

const belongsToRoot = (frame: PluginViewSlotFrame, rootW: number, rootH: number) =>
  frame.rootW === rootW && frame.rootH === rootH;

/** child renderer의 slot 보고와 surface open 요청을 사건으로 합류시킨다. */
export class PluginViewSlotRegistry {
  readonly #frames = new Map<string, PluginViewSlotFrame>();
  readonly #committed = new Map<string, PluginViewSlotFrame>();
  readonly #receivedAt = new Map<string, number>();
  readonly #waiters = new Map<string, Set<Waiter>>();
  readonly #commitWaiters = new Map<string, Set<CommitWaiter>>();

  report(frame: PluginViewSlotFrame): void {
    const previous = this.#frames.get(frame.label);
    if (previous && previous.revision > frame.revision) return;
    this.#frames.set(frame.label, frame);
    this.#receivedAt.set(frame.label, Date.now());
    const waiters = this.#waiters.get(frame.label);
    if (!waiters) return;
    this.#waiters.delete(frame.label);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    }
  }

  /** Native adapter가 이 측정 epoch를 실제 member frame에 적용한 뒤에만 호출한다. */
  commit(frame: PluginViewSlotFrame): void {
    const previous = this.#committed.get(frame.label);
    if (previous && previous.revision > frame.revision) return;
    this.#committed.set(frame.label, frame);
    const waiters = this.#commitWaiters.get(frame.label);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      if (!belongsToRoot(frame, waiter.rootW, waiter.rootH)) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    }
    if (waiters.size === 0) this.#commitWaiters.delete(frame.label);
  }

  frame(label: string): PluginViewSlotFrame | undefined {
    return this.#frames.get(label);
  }

  frames(): (PluginViewSlotFrame & { receivedAtUnixMs: number })[] {
    return [...this.#frames.values()].map((frame) => ({
      ...frame,
      receivedAtUnixMs: this.#receivedAt.get(frame.label) ?? 0,
    }));
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

  waitCommittedRoot(
    label: string,
    rootW: number,
    rootH: number,
    timeoutMs = 10_000,
  ): Promise<PluginViewSlotFrame> {
    const current = this.#committed.get(label);
    if (current && belongsToRoot(current, rootW, rootH)) return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      const waiter: CommitWaiter = {
        rootW,
        rootH,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#commitWaiters.get(label)?.delete(waiter);
          const reported = this.#frames.get(label);
          const committed = this.#committed.get(label);
          const facts = (value: PluginViewSlotFrame | undefined) => value
            ? JSON.stringify({ rootW: value.rootW, rootH: value.rootH, revision: value.revision })
            : "null";
          reject(new Error(
            `plugin renderer native commit 시간 초과: ${label} root=${rootW}x${rootH}`
            + ` reported=${facts(reported)} committed=${facts(committed)} (${timeoutMs}ms)`,
          ));
        }, timeoutMs),
      };
      const waiters = this.#commitWaiters.get(label) ?? new Set<CommitWaiter>();
      waiters.add(waiter);
      this.#commitWaiters.set(label, waiters);
      // 등록 직전 commit과의 경쟁을 닫는다.
      const raced = this.#committed.get(label);
      if (raced) this.commit(raced);
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
    for (const waiters of this.#commitWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.#waiters.clear();
    this.#commitWaiters.clear();
    this.#frames.clear();
    this.#committed.clear();
    this.#receivedAt.clear();
  }
}
