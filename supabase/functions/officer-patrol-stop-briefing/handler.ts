import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
type Row = Record<string, unknown>;
const row = (value: unknown): Row => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid source');
  return value as Row;
};
const oneStop = (value: unknown, stopId: string): Row => {
  if (!Array.isArray(value)) throw new Error('Invalid stops');
  const matches = value.map(row).filter((stop) => stop.id === stopId);
  if (matches.length !== 1) throw new Error('Stop not confirmed');
  return matches[0];
};
const narrative = (value: unknown): string => {
  if (value === null) return '';
  if (typeof value !== 'string') throw new Error('Invalid narrative');
  return value;
};

function plannedStop(journey: unknown, shiftId: string, stopId: string): Row {
  const plan = row(journey);
  if (plan.shift_id !== shiftId) throw new Error('Shift mismatch');
  const planned = oneStop(plan.stops, stopId), plannedPlace = row(planned.place);
  if (planned.client_attribution_complete !== true || !['site', 'zone'].includes(String(plannedPlace.kind))
    || (plannedPlace.kind === 'site' && (!uuid(plannedPlace.site_id) || plannedPlace.zone_id !== null))
    || (plannedPlace.kind === 'zone' && (!uuid(plannedPlace.zone_id) || plannedPlace.site_id !== null))
    || typeof plannedPlace.name !== 'string' || (plannedPlace.address !== null && typeof plannedPlace.address !== 'string')
    || (plannedPlace.kind === 'zone' && plannedPlace.address !== null)) throw new Error('Invalid assignment');
  return planned;
}

function sourceFields(journey: unknown, raw: unknown, shiftId: string, stopId: string): Record<string, string> {
  const plannedPlace = row(plannedStop(journey, shiftId, stopId).place), stop = row(raw);
  const isSite = plannedPlace.kind === 'site';
  const place = row(isSite ? stop.site : stop.zone);
  if (stop.id !== stopId || stop.shift_id !== shiftId
    || stop.site_id !== plannedPlace.site_id || stop.zone_id !== plannedPlace.zone_id
    || (isSite ? stop.zone !== null : stop.site !== null)
    || place.id !== (isSite ? plannedPlace.site_id : plannedPlace.zone_id)
    || place.name !== plannedPlace.name || (isSite ? place.address : null) !== plannedPlace.address) {
    throw new Error('Stop source mismatch');
  }
  return {
    officer_instructions: narrative(stop.officer_instructions),
    access_instructions: narrative(place.access_instructions),
    hs_notes: narrative(place.hs_notes),
  };
}

const unavailable = { status: 'unavailable', message: 'Private review is unavailable. Stop briefing is withheld; contact operations.' };
const withheld = (shiftId: string, stopId: string) => ({
  shift_id: shiftId, stop_id: stopId, officer_instructions: null, access_instructions: null, hs_notes: null, privacy: unavailable,
});

export async function handleOfficerPatrolStopBriefing(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'POST required', privacy: unavailable }, 405);
  try {
    const auth = req.headers.get('Authorization');
    if (!auth) return reply({ error: 'Authentication required', privacy: unavailable }, 401);
    const body = await req.json();
    const shiftId = body?.shift_id, stopId = body?.stop_id;
    if (!uuid(shiftId) || !uuid(stopId)) return reply({ error: 'Exact shift and stop IDs are required', privacy: unavailable }, 400);

    const url = Deno.env.get('SUPABASE_URL') ?? '';
    const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY') ?? '', { global: { headers: { Authorization: auth } } });
    const { data: identity, error: authError } = await caller.auth.getUser();
    if (authError || !identity.user) return reply({ error: 'Authentication required', privacy: unavailable }, 401);
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
    const active = async () => {
      const { data, error } = await admin.from('user_profiles').select('deactivated_at').eq('id', identity.user!.id).single();
      return !error && data && data.deactivated_at === null;
    };
    if (!await active()) return reply({ error: 'Active officer identity required', privacy: unavailable }, 403);

    const getJourney = async () => {
      const { data, error } = await caller.rpc('get_officer_patrol_journey', { p_shift_id: shiftId });
      if (error || !data) throw new Error('Assignment unavailable');
      const plan = row(data);
      plannedStop(plan, shiftId, stopId);
      return plan;
    };
    const getSource = async (journey: Row) => {
      const place = row(plannedStop(journey, shiftId, stopId).place);
      let query = admin.from('shift_stops')
        .select('id,shift_id,site_id,zone_id,officer_instructions,site:client_sites!shift_stops_site_id_fkey(id,name,address,access_instructions,hs_notes),zone:location_zones!shift_stops_zone_id_fkey(id,name,access_instructions,hs_notes)')
        .eq('id', stopId).eq('shift_id', shiftId);
      query = place.kind === 'site'
        ? query.eq('site_id', place.site_id).is('zone_id', null)
        : query.eq('zone_id', place.zone_id).is('site_id', null);
      const { data, error } = await query.maybeSingle();
      if (error || !data) throw new Error('Source unavailable');
      return sourceFields(journey, data, shiftId, stopId);
    };

    let journey: Row, fields: Record<string, string>;
    try {
      journey = await getJourney();
      fields = await getSource(journey);
    } catch {
      return reply({ error: 'Selected patrol assignment and stop could not be confirmed', privacy: unavailable }, 403);
    }

    const controlBase = (Deno.env.get('BOB_CONTROL_PLANE_URL') ?? Deno.env.get('FCM_API_URL') ?? '')
      .replace(/\/+$/, '').replace(/\/api(?:\/bob)?(?:\/builder)?$/, '');
    const controlToken = Deno.env.get('BOB_ADMIN_TOKEN') ?? Deno.env.get('FCM_API_TOKEN');
    if (!controlBase || !controlToken) return reply(withheld(shiftId, stopId));
    try {
      const response = await fetch(`${controlBase}/api/bob/officer/privacy`, {
        method: 'POST', headers: { Authorization: `Bearer ${controlToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }), redirect: 'error', signal: AbortSignal.timeout(140_000),
      });
      if (!response.ok) throw new Error('Review unavailable');
      const result = row(await response.json()), reviewed = row(result.fields), receipt = row(result.privacy);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(Object.entries(fields))));
      const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      if (!['checked', 'partly_withheld'].includes(String(receipt.status))
        || !['gpu_workstation', 'ollama'].includes(String(receipt.provider))
        || typeof receipt.model !== 'string' || !receipt.model || receipt.source_hash !== hash
        || Object.keys(reviewed).length !== Object.keys(fields).length
        || Object.keys(fields).some((key) => !Object.hasOwn(reviewed, key)
          || (reviewed[key] !== null && typeof reviewed[key] !== 'string')
          || (receipt.status === 'checked' && reviewed[key] === null))) throw new Error('Invalid review receipt');

      // Recheck the assignment and exact source after the potentially long private review.
      if (!await active()) throw new Error('Identity no longer active');
      const currentJourney = await getJourney();
      const currentFields = await getSource(currentJourney);
      if (JSON.stringify(oneStop(journey.stops, stopId)) !== JSON.stringify(oneStop(currentJourney.stops, stopId))
        || JSON.stringify(fields) !== JSON.stringify(currentFields)) throw new Error('Source changed');

      return reply({
        shift_id: shiftId, stop_id: stopId,
        officer_instructions: reviewed.officer_instructions || null,
        access_instructions: reviewed.access_instructions || null,
        hs_notes: reviewed.hs_notes || null,
        privacy: { status: receipt.status },
      });
    } catch {
      console.error('[officer-patrol-stop-briefing] review or source confirmation unavailable; no narrative disclosed');
      return reply(withheld(shiftId, stopId));
    }
  } catch {
    console.error('[officer-patrol-stop-briefing] request failed; no narrative disclosed');
    return reply({ error: 'Stop briefing could not be loaded. Retry or contact operations.', privacy: unavailable }, 500);
  }
}
