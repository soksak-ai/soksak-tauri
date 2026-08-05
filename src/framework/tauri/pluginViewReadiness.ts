export interface PluginViewReadinessStatus {
  total: number;
  grouped: number;
  pending: string[];
}

/** presentation lifecycle의 grouped 변화를 사건으로 공개하는 유한 barrier. */
export class PluginViewReadiness {
  readonly #grouped = new Map<string, boolean>();
  readonly #listeners = new Set<() => void>();

  set(id: string, grouped: boolean): void {
    if (this.#grouped.get(id) === grouped) return;
    this.#grouped.set(id, grouped);
    for (const listener of this.#listeners) listener();
  }

  delete(id: string): void {
    if (!this.#grouped.delete(id)) return;
    for (const listener of this.#listeners) listener();
  }

  status(): PluginViewReadinessStatus {
    const pending = [...this.#grouped].filter(([, grouped]) => !grouped).map(([id]) => id).sort();
    return { total: this.#grouped.size, grouped: this.#grouped.size - pending.length, pending };
  }

  wait(minGrouped: number, timeoutMs = 30_000): Promise<PluginViewReadinessStatus> {
    const current = this.status();
    if (current.grouped >= minGrouped) return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value?: PluginViewReadinessStatus, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#listeners.delete(onChange);
        if (error) reject(error);
        else resolve(value!);
      };
      const onChange = () => {
        const next = this.status();
        if (next.grouped >= minGrouped) finish(next);
      };
      const timer = setTimeout(() => {
        const status = this.status();
        finish(undefined, new Error(
          `plugin presentation ready 시간 초과: ${status.grouped}/${minGrouped} (${timeoutMs}ms)`,
        ));
      }, timeoutMs);
      this.#listeners.add(onChange);
      onChange();
    });
  }
}
