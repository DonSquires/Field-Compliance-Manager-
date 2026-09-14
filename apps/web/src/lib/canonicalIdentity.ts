export type CanonicalPlaceKind = 'location' | 'site' | 'zone' | 'loi';
export type CanonicalEntityKind = 'organization' | 'place' | 'person' | 'vehicle' | 'scv';

export function normalizeCanonicalText(value: string | null | undefined): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

export function normalizePlateNumber(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function buildCanonicalOrganizationKey(id: string): string {
  const safeId = normalizeCanonicalText(id);
  if (!safeId) {
    throw new Error('A canonical organization id is required');
  }
  return `organization:${safeId}`;
}

export function buildCanonicalPlaceKey(kind: CanonicalPlaceKind, id: string): string {
  const safeId = normalizeCanonicalText(id);
  if (!safeId) {
    throw new Error('A canonical place id is required');
  }
  return `${kind}:${safeId}`;
}

export function buildCanonicalPersonKey(id: string): string {
  const safeId = normalizeCanonicalText(id);
  if (!safeId) {
    throw new Error('A canonical person id is required');
  }
  return `person:${safeId}`;
}

export function buildCanonicalVehicleKey(plate: string): string {
  const safePlate = normalizePlateNumber(plate);
  if (!safePlate) {
    throw new Error('A vehicle plate is required');
  }
  return `vehicle:${safePlate}`;
}

export function buildCanonicalScvKey(plate: string): string {
  const safePlate = normalizePlateNumber(plate);
  if (!safePlate) {
    throw new Error('A SCV plate is required');
  }
  return `scv:${safePlate}`;
}

export function dedupeByPlate(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = normalizePlateNumber(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

export function canonicalEntityKey(kind: CanonicalEntityKind | CanonicalPlaceKind, idOrPlate: string): string {
  switch (kind) {
    case 'organization':
      return buildCanonicalOrganizationKey(idOrPlate);
    case 'location':
    case 'site':
    case 'zone':
    case 'loi':
      return buildCanonicalPlaceKey(kind, idOrPlate);
    case 'place':
      return buildCanonicalPlaceKey('location', idOrPlate);
    case 'person':
      return buildCanonicalPersonKey(idOrPlate);
    case 'vehicle':
      return buildCanonicalVehicleKey(idOrPlate);
    case 'scv':
      return buildCanonicalScvKey(idOrPlate);
    default:
      return normalizeCanonicalText(idOrPlate);
  }
}
