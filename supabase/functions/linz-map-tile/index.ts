import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const LINZ_API_KEY = (Deno.env.get('LINZ_API_KEY') ?? '').trim().replace(/^['"]|['"]$/g, '');
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const LAYERS = new Set(['topographic', 'aerial']);

serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (request.method !== 'GET') return new Response('GET required', { status: 405, headers: CORS });
  if (!LINZ_API_KEY) return new Response('LINZ_API_KEY is not configured', { status: 500, headers: CORS });

  const url = new URL(request.url);
  const layer = url.searchParams.get('layer') ?? 'topographic';
  const z = url.searchParams.get('z');
  const x = url.searchParams.get('x');
  const y = url.searchParams.get('y');
  if (!LAYERS.has(layer) || ![z, x, y].every((value) => value && /^\d+$/.test(value))) {
    return new Response('Invalid tile request', { status: 400, headers: CORS });
  }

  const tileUrl = `https://basemaps.linz.govt.nz/v1/tiles/${layer}/WebMercatorQuad/${z}/${x}/${y}.png?api=${encodeURIComponent(LINZ_API_KEY)}`;
  const tile = await fetch(tileUrl, { headers: { Accept: 'image/png' } });
  if (!tile.ok) return new Response('LINZ tile unavailable', { status: tile.status, headers: CORS });
  return new Response(tile.body, {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
  });
});
