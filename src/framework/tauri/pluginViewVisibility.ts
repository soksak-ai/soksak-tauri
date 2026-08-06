export type ApplyPluginViewVisibility = (visible: boolean) => Promise<void>;

/** Pane renderer와 member의 visibility 적용을 소유하는 거래 경계. */
export class PluginViewVisibility {
  constructor(private readonly apply: ApplyPluginViewVisibility) {}

  request(visible: boolean): Promise<void> {
    return this.apply(visible);
  }

  settled(): Promise<void> {
    return Promise.resolve();
  }
}
