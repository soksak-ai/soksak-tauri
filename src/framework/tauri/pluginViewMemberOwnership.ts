/** label별 최신 renderer 세대만 native member를 닫을 수 있게 하는 소유권 장부. */
export class PluginViewMemberOwnership {
  private readonly owners = new Map<string, string>();

  claim(label: string, renderer: string): void {
    this.owners.set(label, renderer);
  }

  release(label: string, renderer: string): boolean {
    if (this.owners.get(label) !== renderer) return false;
    this.owners.delete(label);
    return true;
  }
}
