const rect = (value) => {
  const frame = {
    x: Number(value?.x), y: Number(value?.y),
    w: Number(value?.w), h: Number(value?.h),
  };
  return [frame.x, frame.y, frame.w, frame.h].every(Number.isFinite)
    && frame.w > 0 && frame.h > 0
    ? frame
    : null;
};

const physical = (frame, scaleFactor) => {
  const left = Math.round(frame.x * scaleFactor);
  const top = Math.round(frame.y * scaleFactor);
  const right = Math.round((frame.x + frame.w) * scaleFactor);
  const bottom = Math.round((frame.y + frame.h) * scaleFactor);
  return { x: left, y: top, w: right - left, h: bottom - top };
};

const same = (a, b) => ["x", "y", "w", "h"].every((key) => a[key] === b[key]);

const inspectSpace = (value, path, errors) => {
  if (!value || typeof value !== "object") {
    errors.push(`${path}:coordinate-space=declared`);
    return null;
  }
  if (value.logical !== "css-px") errors.push(`${path}:coordinate-logical=${value.logical}/css-px`);
  if (value.origin !== "presenter-local") {
    errors.push(`${path}:coordinate-origin=${value.origin}/presenter-local`);
  }
  if (typeof value.referenceId !== "string" || value.referenceId.length === 0) {
    errors.push(`${path}:coordinate-reference=non-empty`);
  }
  return value;
};

/**
 * Windowed engine bounds are presenter-local facts. The PaneSurfaceHost adapter exposes the
 * matching member frame in that same local space; window-absolute UI rectangles are not a
 * substitute and never participate in this verdict.
 */
export function windowedSurfaceCompositionVerdict({
  stats,
  paneComposition,
  viewIds,
  labels,
  scaleFactor,
}) {
  const errors = [];
  const surfaces = Array.isArray(stats?.surfaces) ? stats.surfaces : [];
  const byId = new Map(surfaces.map((surface) => [Number(surface?.id), surface]));
  const mappedIds = viewIds.map((viewId) => Number(stats?.idMap?.[`chromium-${viewId}`]));
  const ledger = Array.isArray(stats?.ledger) ? stats.ledger.map(Number) : [];
  const sortedMapped = [...mappedIds].sort((a, b) => a - b);
  const sortedLedger = [...ledger].sort((a, b) => a - b);
  if (mappedIds.some((id) => !Number.isFinite(id) || !byId.has(id))
      || JSON.stringify(sortedMapped) !== JSON.stringify(sortedLedger)) {
    errors.push(`surface-ownership mapped=${JSON.stringify(sortedMapped)} ledger=${JSON.stringify(sortedLedger)}`);
  }
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
    errors.push(`scaleFactor=${scaleFactor}`);
    return { ok: false, errors };
  }

  for (let index = 0; index < viewIds.length; index += 1) {
    const viewId = viewIds[index];
    const label = labels[index];
    const surface = byId.get(mappedIds[index]);
    if (!surface) {
      errors.push(`${viewId}:surface=missing`);
      continue;
    }
    if (surface.surfaceKey !== label) {
      errors.push(`${viewId}:surface-key=${surface.surfaceKey}/${label}`);
    }
    const surfaceSpace = inspectSpace(surface.coordinateSpace, `${viewId}:surface`, errors);
    const members = (paneComposition?.matches ?? []).flatMap((pane) => pane.memberMatches ?? [])
      .filter((member) => member?.label === label);
    if (members.length !== 1 || members[0]?.ok !== true) {
      errors.push(`${viewId}:pane-member=${members.length}/1:exact`);
      continue;
    }
    const member = members[0];
    const memberSpace = inspectSpace(member.coordinateSpace, `${viewId}:member`, errors);
    if (surfaceSpace && memberSpace) {
      if (surfaceSpace.origin !== memberSpace.origin) {
        errors.push(`${viewId}:coordinate-origin=${surfaceSpace.origin}/${memberSpace.origin}`);
      }
      if (surfaceSpace.referenceId !== memberSpace.referenceId) {
        errors.push(`${viewId}:coordinate-reference=${surfaceSpace.referenceId}/${memberSpace.referenceId}`);
      }
      if (surfaceSpace.referenceId !== label || memberSpace.referenceId !== label) {
        errors.push(`${viewId}:coordinate-reference=${surfaceSpace.referenceId}/${memberSpace.referenceId}/${label}`);
      }
    }
    const expected = rect(member.domFrame);
    const actual = rect(surface.bounds);
    if (!expected || !actual) {
      errors.push(`${viewId}:frame=finite-positive`);
      continue;
    }
    const expectedPhysical = physical(expected, scaleFactor);
    const actualPhysical = physical(actual, scaleFactor);
    if (!same(expectedPhysical, actualPhysical)) {
      errors.push(`${viewId}:frame=${JSON.stringify(actualPhysical)}/${JSON.stringify(expectedPhysical)}`);
    }
  }
  return { ok: errors.length === 0, errors };
}
