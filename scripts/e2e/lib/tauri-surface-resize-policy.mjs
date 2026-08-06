export const APPKIT_EXPLICIT_BOUNDS_MASK = 0;
export const APPKIT_PARENT_WIDTH_HEIGHT_MASK = 18;

const labelOf = (surface) => surface?.label ?? surface?.ptr ?? "unknown";

/**
 * Tauri has one bounds owner per native surface state:
 * - standalone: explicit DOM/engine bounds, therefore no AppKit autoresize mask;
 * - PaneSurfaceHost member: the parent frame transaction, therefore width+height inheritance.
 * The later explicit bounds event is an acknowledgement of the same geometry, not another owner.
 */
export function tauriSurfaceResizePolicyVerdict(surfaces) {
  const errors = [];
  if (!Array.isArray(surfaces) || surfaces.length === 0) {
    return { ok: false, errors: ["surface:none"] };
  }

  for (const surface of surfaces) {
    const label = labelOf(surface);
    if (surface?.layerContentsRedrawPolicy !== 2) {
      errors.push(`${label}:redraw=${String(surface?.layerContentsRedrawPolicy)}/2`);
    }
    if (surface?.layerContentsPlacement !== 11) {
      errors.push(`${label}:placement=${String(surface?.layerContentsPlacement)}/11`);
    }

    if (surface?.pane === null) {
      if (surface.autoresizingMask !== APPKIT_EXPLICIT_BOUNDS_MASK) {
        errors.push(
          `${label}:autoresizing=${String(surface.autoresizingMask)}/${APPKIT_EXPLICIT_BOUNDS_MASK}(standalone)`,
        );
      }
    } else if (typeof surface?.pane === "string" && surface.pane.length > 0) {
      if (surface.autoresizingMask !== APPKIT_PARENT_WIDTH_HEIGHT_MASK) {
        errors.push(
          `${label}:autoresizing=${String(surface.autoresizingMask)}/${APPKIT_PARENT_WIDTH_HEIGHT_MASK}(grouped:${surface.pane})`,
        );
      }
    } else {
      errors.push(`${label}:pane=missing`);
    }
  }

  return { ok: errors.length === 0, errors };
}
