interface DisposableLike {
  dispose(): void;
}

interface SidecarHandleLike {
  send(message: Record<string, unknown>): Promise<Record<string, unknown>>;
  on(
    event: string,
    listener: (payload: Record<string, unknown>) => void,
  ): DisposableLike;
  close(): Promise<void>;
}

interface SidecarApiLike {
  open(name: string): Promise<SidecarHandleLike>;
}

interface Entry {
  handle: SidecarHandleLike;
  subscriptions: Set<DisposableLike>;
}

/** 한 pane renderer가 연 sidecar handle만 주소화하고 presentation 종료 때 전부 회수한다. */
export class PluginViewSidecars {
  private sequence = 0;
  private readonly entries = new Map<string, Entry>();

  async open(api: SidecarApiLike, name: string): Promise<string> {
    const handle = await api.open(name);
    const id = `sc${++this.sequence}`;
    this.entries.set(id, { handle, subscriptions: new Set() });
    return id;
  }

  async send(id: string, message: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await this.entry(id).handle.send(message);
  }

  subscribe(
    id: string,
    event: string,
    listener: (payload: Record<string, unknown>) => void,
  ): DisposableLike {
    const entry = this.entry(id);
    const inner = entry.handle.on(event, listener);
    const subscription: DisposableLike = {
      dispose: () => {
        if (!entry.subscriptions.delete(subscription)) return;
        inner.dispose();
      },
    };
    entry.subscriptions.add(subscription);
    return subscription;
  }

  async close(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    for (const subscription of [...entry.subscriptions]) subscription.dispose();
    await entry.handle.close();
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.close(id)));
  }

  private entry(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`알 수 없는 sidecar handle: ${id}`);
    return entry;
  }
}
