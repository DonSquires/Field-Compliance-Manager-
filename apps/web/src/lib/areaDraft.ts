// A form draft remembers the version it was started from. It is refreshed from the server only when it is a different
// area or still clean; an edited draft keeps its base version so a save after a concurrent change conflicts instead of
// silently overwriting.

export interface AreaDraftBase { zoneId: string | null; version: number; dirty: boolean }
export interface VersionedZone { id: string; configuration_version: number }

export function areaDraftSync(draft: AreaDraftBase, zone: VersionedZone): 'reset' | 'keep' {
  if (draft.zoneId !== zone.id) return 'reset';
  if (draft.version === zone.configuration_version) return 'keep';
  return draft.dirty ? 'keep' : 'reset';
}

export function isStaleAreaDraft(draft: AreaDraftBase, zone: VersionedZone | null | undefined) {
  return Boolean(zone) && draft.dirty && draft.zoneId === zone!.id && draft.version !== zone!.configuration_version;
}
