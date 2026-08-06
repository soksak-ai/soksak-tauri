export type ApplyPluginViewVisibility = (visible: boolean) => Promise<void>;

/** Pane renderer와 member의 visibility 적용을 소유하는 거래 경계. */
export class PluginViewVisibility {
  private desired: boolean | null = null;
  private requested = false;
  private draining: Promise<void> | null = null;
  private readonly waiters: { resolve(): void; reject(error: unknown): void }[] = [];

  constructor(private readonly apply: ApplyPluginViewVisibility) {}

  request(visible: boolean): Promise<void> {
    this.desired = visible;
    this.requested = true;
    const done = this.wait();
    this.start();
    return done;
  }

  settled(): Promise<void> {
    return this.requested || this.draining ? this.wait() : Promise.resolve();
  }

  private wait(): Promise<void> {
    return new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private start(): void {
    if (this.draining) return;
    this.draining = (async () => {
      while (this.requested) {
        this.requested = false;
        const desired = this.desired;
        if (desired === null) continue;
        await this.apply(desired);
        if (this.desired !== desired) this.requested = true;
      }
    })()
      .then(() => {
        this.draining = null;
        if (this.requested) {
          this.start();
          return;
        }
        for (const waiter of this.waiters.splice(0)) waiter.resolve();
      })
      .catch((error) => {
        this.draining = null;
        for (const waiter of this.waiters.splice(0)) waiter.reject(error);
      });
  }
}
