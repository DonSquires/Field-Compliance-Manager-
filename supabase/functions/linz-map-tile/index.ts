/**
 * Base-map tiles for every Leaflet surface, proxied so the provider keys never reach the browser.
 *
 *   street       Google roadmap (Map Tiles API) — named roads, driveways, building footprints: the map people navigate by.
 *   satellite    Google satellite imagery — the highest-resolution photo for drawing a boundary around what is actually there.
 *   aerial       LINZ aerial basemap (official NZ imagery).
 *   topographic  LINZ Topo50 (contours and land cover; not a property map).
 *
 * When a provider refuses, the reason is returned as text so the failure is visible instead of a silently blank map.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const LINZ_API_KEY = (Deno.env.get('LINZ_API_KEY') ?? '').trim().replace(/^['"]|['"]$/g, '');
const GOOGLE_API_TOKEN = (Deno.env.get('GOOGLE_API_TOKEN') ?? '').trim().replace(/^['"]|['"]$/g, '');
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type Layer = 'street' | 'satellite' | 'aerial' | 'topographic';
const LAYERS = new Set<string>(['street', 'satellite', 'aerial', 'topographic']);
const GOOGLE_MAP_TYPE: Partial<Record<Layer, string>> = { street: 'roadmap', satellite: 'satellite' };

const fail = (status: number, reason: string) => new Response(reason, { status, headers: { ...CORS, 'Content-Type': 'text/plain' } });

/** Google 2D tiles need a session token per map type; it lasts hours, so hold it until it expires rather than minting one per tile. */
const sessions = new Map<string, { token: string; expiresAt: number }>();
async function googleSession(mapType: string): Promise<string> {
  const held = sessions.get(mapType);
  if (held && held.expiresAt > Date.now() + 60_000) return held.token;
  const response = await fetch(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(GOOGLE_API_TOKEN)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mapType, language: 'en-NZ', region: 'NZ' }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.session) throw new Error(`Google tile session refused (${response.status}): ${String(body?.error?.message ?? 'no session returned').slice(0, 200)}`);
  sessions.set(mapType, { token: body.session as string, expiresAt: Number(body.expiry ?? 0) * 1000 || Date.now() + 3_600_000 });
  return body.session as string;
}

serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (request.method !== 'GET') return fail(405, 'GET required');

  const url = new URL(request.url);
  const layer = (url.searchParams.get('layer') ?? 'street') as Layer;
  const z = url.searchParams.get('z');
  const x = url.searchParams.get('x');
  const y = url.searchParams.get('y');
  if (!LAYERS.has(layer) || ![z, x, y].every((value) => value && /^\d+$/.test(value))) {
    return fail(400, 'Invalid tile request');
  }

  const mapType = GOOGLE_MAP_TYPE[layer];
  let upstream: Response;
  if (mapType) {
    if (!GOOGLE_API_TOKEN) return fail(500, 'GOOGLE_API_TOKEN is not configured');
    let session: string;
    try { session = await googleSession(mapType); } catch (error) { return fail(502, error instanceof Error ? error.message : 'Google tile session refused'); }
    upstream = await fetch(`https://tile.googleapis.com/v1/2dtiles/${z}/${x}/${y}?session=${encodeURIComponent(session)}&key=${encodeURIComponent(GOOGLE_API_TOKEN)}`);
    if (upstream.status === 401 || upstream.status === 403) sessions.delete(mapType);
  } else {
    if (!LINZ_API_KEY) return fail(500, 'LINZ_API_KEY is not configured');
    upstream = layer === 'topographic'
      ? await fetch(`https://tiles-cdn.koordinates.com/services;key=${encodeURIComponent(LINZ_API_KEY)}/tiles/v4/layer=50767/EPSG:3857/${z}/${x}/${y}.png`)
      : await fetch(`https://basemaps.linz.govt.nz/v1/tiles/aerial/WebMercatorQuad/${z}/${x}/${y}.webp?api=${encodeURIComponent(LINZ_API_KEY)}`);
  }

  if (!upstream.ok) return fail(upstream.status === 404 ? 404 : 502, `${layer} tile unavailable (${upstream.status}): ${(await upstream.text()).slice(0, 200)}`);
  return new Response(upstream.body, {
    status: 200,
    headers: { ...CORS, 'Content-Type': upstream.headers.get('content-type') ?? 'image/png', 'Cache-Control': 'public, max-age=86400' },
  });
});
