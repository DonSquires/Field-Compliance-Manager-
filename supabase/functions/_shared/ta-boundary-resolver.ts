import { NZTA_TA_FEATURESERVER, TA_NAME_CANDIDATES } from './ta-validation.ts';

const STATSNZ_API_KEY = Deno.env.get('STATSNZ_API_KEY') ?? '';
const STATSNZ_TA_QUERY_URL = Deno.env.get('STATSNZ_TA_QUERY_URL') ?? 'https://datafinder.stats.govt.nz/services/query/v1/vector.json';
const STATSNZ_TA_LAYER = Deno.env.get('STATSNZ_TA_LAYER') ?? '123497';
const STATSNZ_TA_NAME_FIELD = Deno.env.get('STATSNZ_TA_NAME_FIELD') ?? 'TA2026_V1_00_NAME_ASCII';
const GOOGLE_API_KEY = Deno.env.get('GOOGLE_MAPS_API_KEY') ?? Deno.env.get('GOOGLE_API_TOKEN') ?? '';

type TaBoundarySource = 'nzta_featureserver' | 'statsnz_datafinder';
type SourceResult = {
  state: 'matched' | 'not_found' | 'field_error' | 'source_unavailable';
  source: TaBoundarySource;
  geometry?: Record<string, unknown>;
  detail?: string;
};

export type TaBoundaryResolution = {
  geometry: Record<string, unknown> | null;
  source: TaBoundarySource | null;
  source_status: 'matched' | 'not_found' | 'source_unavailable';
  detail: string | null;
};

function quotedValue(value: string): string {
  return value.replace(/'/g, "''");
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: { message: text.slice(0, 160) || 'non-JSON response' } };
  }
}

function apiError(body: unknown): { code?: unknown; message?: unknown } | null {
  const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : null;
  return error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : null;
}

function isFieldError(body: unknown): boolean {
  const error = apiError(body);
  return Number(error?.code) === 400 && /field|where|expression/i.test(typeof error?.message === 'string' ? error.message : '');
}

function unavailableDetail(source: string, status: number, body: unknown): string {
  const error = apiError(body);
  const code = error?.code === undefined ? '' : ` ${String(error.code)}`;
  const message = typeof error?.message === 'string' ? `: ${error.message.slice(0, 160)}` : '';
  return `${source} unavailable${code || (status ? ` (${status})` : '')}${message}`;
}

function statsFeatures(body: unknown): Array<{ geometry?: Record<string, unknown>; properties?: Record<string, unknown> }> {
  const data = body as { features?: unknown; vectorQuery?: { layers?: unknown } };
  if (Array.isArray(data?.features)) return data.features as Array<{ geometry?: Record<string, unknown>; properties?: Record<string, unknown> }>;
  const layers = data?.vectorQuery?.layers;
  if (Array.isArray(layers)) return layers.flatMap((layer) => Array.isArray((layer as { features?: unknown })?.features) ? (layer as { features: Array<{ geometry?: Record<string, unknown>; properties?: Record<string, unknown> }> }).features : []);
  if (layers && typeof layers === 'object') return Object.values(layers).flatMap((layer) => Array.isArray((layer as { features?: unknown })?.features) ? (layer as { features: Array<{ geometry?: Record<string, unknown>; properties?: Record<string, unknown> }> }).features : []);
  return [];
}

function normalizedName(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLocaleLowerCase('en-NZ') : '';
}

async function geocodeTaSeed(name: string): Promise<{ lat: number; lng: number } | null> {
  if (!GOOGLE_API_KEY) return null;
  try {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', `${name}, New Zealand`);
    url.searchParams.set('components', 'country:NZ');
    url.searchParams.set('region', 'nz');
    url.searchParams.set('key', GOOGLE_API_KEY);
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    const body = await responseJson(response) as { status?: unknown; results?: Array<{ geometry?: { location?: { lat?: unknown; lng?: unknown } } }> };
    const location = response.ok && body.status === 'OK' ? body.results?.[0]?.geometry?.location : null;
    const lat = Number(location?.lat);
    const lng = Number(location?.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  } catch {
    return null;
  }
}

async function queryNzta(field: string, name: string): Promise<SourceResult> {
  try {
    const where = `UPPER(${field}) = UPPER('${quotedValue(name)}')`;
    const url = `${NZTA_TA_FEATURESERVER}/query?where=${encodeURIComponent(where)}&outFields=*&returnGeometry=true&outSR=4326&f=geojson`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    const body = await responseJson(response);
    if (!response.ok || apiError(body)) {
      if (isFieldError(body)) return { state: 'field_error', source: 'nzta_featureserver' };
      return { state: 'source_unavailable', source: 'nzta_featureserver', detail: unavailableDetail('NZTA Territorial Authority source', response.status, body) };
    }
    const geometry = ((body as { features?: Array<{ geometry?: Record<string, unknown> }> }).features ?? [])[0]?.geometry;
    return geometry ? { state: 'matched', source: 'nzta_featureserver', geometry } : { state: 'not_found', source: 'nzta_featureserver' };
  } catch (error) {
    return { state: 'source_unavailable', source: 'nzta_featureserver', detail: `NZTA Territorial Authority source unavailable: ${error instanceof Error ? error.name : 'fetch error'}` };
  }
}

async function queryStatsNz(name: string): Promise<SourceResult> {
  if (!STATSNZ_API_KEY) return { state: 'source_unavailable', source: 'statsnz_datafinder', detail: 'Stats NZ Territorial Authority source is not configured' };
  const seed = await geocodeTaSeed(name);
  if (!seed) return { state: 'source_unavailable', source: 'statsnz_datafinder', detail: 'Stats NZ Territorial Authority lookup could not obtain a New Zealand point seed' };
  try {
    const url = new URL(STATSNZ_TA_QUERY_URL);
    url.searchParams.set('key', STATSNZ_API_KEY);
    url.searchParams.set('layer', STATSNZ_TA_LAYER);
    url.searchParams.set('x', String(seed.lng));
    url.searchParams.set('y', String(seed.lat));
    url.searchParams.set('max_results', '5');
    url.searchParams.set('radius', '0');
    url.searchParams.set('geometry', 'true');
    url.searchParams.set('with_field_names', 'true');
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    const body = await responseJson(response);
    if (!response.ok || apiError(body)) return { state: 'source_unavailable', source: 'statsnz_datafinder', detail: unavailableDetail('Stats NZ Territorial Authority source', response.status, body) };
    const candidates = statsFeatures(body);
    const feature = candidates.find((candidate) => normalizedName(candidate.properties?.[STATSNZ_TA_NAME_FIELD]) === normalizedName(name));
    const geometry = feature?.geometry;
    if (geometry) return { state: 'matched', source: 'statsnz_datafinder', geometry };
    const labels = candidates.map((candidate) => candidate.properties?.[STATSNZ_TA_NAME_FIELD]).filter((value): value is string => typeof value === 'string' && value.trim().length > 0).slice(0, 3);
    const propertyKeys = candidates.flatMap((candidate) => Object.keys(candidate.properties ?? {})).filter((key, index, keys) => keys.indexOf(key) === index).slice(0, 6);
    const detail = candidates.length === 0
      ? 'Stats NZ Territorial Authority query returned no features for the resolved point'
      : labels.length > 0
        ? `Stats NZ Territorial Authority query returned different authority names: ${labels.join(', ')}`
        : `Stats NZ Territorial Authority query returned ${candidates.length} feature(s) without ${STATSNZ_TA_NAME_FIELD}; fields: ${propertyKeys.join(', ') || 'none'}`;
    return { state: 'not_found', source: 'statsnz_datafinder', detail };
  } catch (error) {
    return { state: 'source_unavailable', source: 'statsnz_datafinder', detail: `Stats NZ Territorial Authority source unavailable: ${error instanceof Error ? error.name : 'fetch error'}` };
  }
}

export async function resolveTaBoundary(name: string): Promise<TaBoundaryResolution> {
  let nztaAvailable = false;
  let nztaFailure: string | null = null;
  for (const field of TA_NAME_CANDIDATES) {
    const result = await queryNzta(field, name);
    if (result.state === 'matched') return { geometry: result.geometry ?? null, source: result.source, source_status: 'matched', detail: null };
    if (result.state === 'not_found') nztaAvailable = true;
    if (result.state === 'source_unavailable') {
      nztaFailure = result.detail ?? 'NZTA Territorial Authority source unavailable';
      break;
    }
  }
  const stats = await queryStatsNz(name);
  if (stats.state === 'matched') return { geometry: stats.geometry ?? null, source: stats.source, source_status: 'matched', detail: nztaFailure };
  if (stats.state === 'not_found' || nztaAvailable) return { geometry: null, source: stats.state === 'not_found' ? stats.source : null, source_status: 'not_found', detail: stats.detail ?? null };
  return { geometry: null, source: null, source_status: 'source_unavailable', detail: stats.detail ?? nztaFailure ?? 'No Territorial Authority boundary source is available' };
}