import { moduleState } from "../../lib/moduleState";

export type TauriSurfaceOwner = "direct" | "pane";

interface OwnershipEntry {
  direct: boolean;
  pane: string | null;
}

const registry = moduleState("framework/tauri#surfaceOwnership", () => ({
  entries: new Map<string, OwnershipEntry>(),
  listeners: new Set<() => void>(),
}));

const notify = (): void => {
  for (const listener of registry.listeners) listener();
};

const update = (label: string, mutate: (entry: OwnershipEntry) => void): void => {
  const before = registry.entries.get(label);
  const entry = before ? { ...before } : { direct: false, pane: null };
  mutate(entry);
  const empty = !entry.direct && entry.pane === null;
  const changed = before?.direct !== entry.direct || before?.pane !== entry.pane;
  if (!changed) return;
  if (empty) registry.entries.delete(label);
  else registry.entries.set(label, entry);
  notify();
};

/** Native content-view lifecycle owns the direct claim. A pane claim, when present, wins. */
export const claimDirectSurface = (label: string): void =>
  update(label, (entry) => { entry.direct = true; });

export const releaseDirectSurface = (label: string): void =>
  update(label, (entry) => { entry.direct = false; });

/** PaneSurfaceHost claims before opening/presenting a member, so no transient direct owner leaks. */
export const claimPaneSurface = (label: string, pane: string): void =>
  update(label, (entry) => { entry.pane = pane; });

export const releasePaneSurface = (label: string, pane: string): void =>
  update(label, (entry) => {
    if (entry.pane === pane) entry.pane = null;
  });

export function tauriSurfaceOwner(label: string): TauriSurfaceOwner | null {
  const entry = registry.entries.get(label);
  if (!entry) return null;
  return entry.pane !== null ? "pane" : entry.direct ? "direct" : null;
}

export function tauriSurfaceOwnershipFacts(): {
  label: string;
  owner: TauriSurfaceOwner;
  pane: string | null;
}[] {
  return [...registry.entries.entries()].flatMap(([label, entry]) => {
    const owner = entry.pane !== null ? "pane" : entry.direct ? "direct" : null;
    return owner ? [{ label, owner, pane: entry.pane }] : [];
  });
}

/** Event subscription; ownership changes are lifecycle edges, never a polling source. */
export function onTauriSurfaceOwnershipChanged(listener: () => void): () => void {
  registry.listeners.add(listener);
  return () => registry.listeners.delete(listener);
}

export function __resetTauriSurfaceOwnershipForTest(): void {
  registry.entries.clear();
  registry.listeners.clear();
}
