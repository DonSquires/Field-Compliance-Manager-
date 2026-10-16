/**
 * bob-propose-place-hazards — governed producer for the place hazard register
 * (place_hazards): the short, place-specific risks an officer is briefed on at
 * shift start and on patrol arrival, each linked back to its source section.
 *
 * POST /functions/v1/bob-propose-place-hazards
 * Body: {
 *   organization_id,          // EXPLICIT keeping organisation (resolve with query_records)
 *   hazards: [{               // 1..20 hazards; one pending action each
 *     client_site_id? | zone_id? | location_id?,   // the place (facet or whole house)
 *     title, hazard_class, risk_level,              // residual risk after controls
 *     controls?: string[], details?, likelihood?, consequence?,
 *     source_name, source_as_of, source_locator?,   // e.g. "Section 4.2" or "p. 7"
 *     source_document_id?, source_attachment_id?, review_due?
 *   }],
 *   reasoning?, conversation_id?, context_summary?
 * }
 *
 * Bob is the PROPOSER only. A human approves each action; the service-only
 * apply_bob_place_hazard_proposal RPC writes it. A live hazard with the same
 * title at the same place is replaced (version bump, officers re-acknowledge).
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const BOB_USER_ID = '00000000-0000-0000-0000-00000000b0b0';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const CAN_PROPOSE = new Set(['grand_master', 'master', 'admin']);
const HAZARD_CLASSES = new Set([
  'violence_or_aggression', 'weapons', 'dangerous_dog', 'hazardous_substances',
  'biological_or_infection', 'sharps', 'slips_trips_falls', 'traffic_and_vehicles',
  'working_at_height', 'electrical', 'fire_or_explosion', 'confined_space',
  'lone_working', 'weather_or_environment', 'security_threat', 'manual_handling',
  'medical_or_welfare', 'unsafe_structure_or_ground', 'other'
]);
const RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_HAZARDS = 20;

type HazardInput = Record<string, unknown>;
type CleanHazard = {
  client_site_id: string | null;
  zone_id: string | null;
  location_id: string | null;
  title: string;
  hazard_class: string;
  risk_level: string;
  likelihood: number | null;
  consequence: number | null;
  controls: string[];
  details: string | null;
  source_name: string;
  source_as_of: string;
  source_locator: string | null;
  source_document_id: string | null;
  source_attachment_id: string | null;
  review_due: string | null;
};

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, 'Content-Type': 'application/json' }
});

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function isoDate(value: unknown): string | null {
  const v = text(value, 32);
  if (!v) return null;
  const day = v.slice(0, 10);
  if (!DATE_RE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) throw new Error(`Invalid date '${v}' (use YYYY-MM-DD)`);
  return day;
}

function optionalUuid(value: unknown, field: string): string | null {
  const v = text(value, 64);
  if (!v) return null;
  if (!UUID_RE.test(v)) throw new Error(`${field} must be a UUID`);
  return v;
}

function score(value: unknown, field: string, title: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new Error(`'${title}' ${field} must be an integer 1-5`);
  return n;
}

function cleanPlaceHazard(input: HazardInput): CleanHazard {
  const title = text(input.title, 160);
  if (!title || title.length < 3) throw new Error('Each hazard needs a short title (3-160 characters)');
  const hazardClass = String(input.hazard_class ?? '').trim();
  if (!HAZARD_CLASSES.has(hazardClass)) throw new Error(`'${title}' hazard_class must be one of ${[...HAZARD_CLASSES].join(', ')}`);
  const riskLevel = String(input.risk_level ?? '').trim().toLowerCase();
  if (!RISK_LEVELS.has(riskLevel)) throw new Error(`'${title}' risk_level must be low, medium, high or critical`);
  const site = optionalUuid(input.client_site_id, 'client_site_id');
  const zone = optionalUuid(input.zone_id, 'zone_id');
  const location = optionalUuid(input.location_id, 'location_id');
  if (site && zone) throw new Error(`'${title}' names both a site and a zone; choose one facet or use location_id for the whole place`);
  if (!site && !zone && !location) throw new Error(`'${title}' needs a place: client_site_id, zone_id, or location_id (resolve it with query_records)`);
  const sourceName = text(input.source_name, 500);
  if (!sourceName || sourceName.length < 2) throw new Error(`'${title}' needs source_name (the document it came from)`);
  const sourceAsOf = isoDate(input.source_as_of);
  if (!sourceAsOf) throw new Error(`'${title}' needs source_as_of (the date of the source document, YYYY-MM-DD)`);
  const controls = (Array.isArray(input.controls) ? input.controls : typeof input.controls === 'string' ? [input.controls] : [])
    .map((c) => text(c, 300))
    .filter((c): c is string => Boolean(c))
    .slice(0, 12);
  return {
    client_site_id: site,
    zone_id: zone,
    location_id: location,
    title,
    hazard_class: hazardClass,
    risk_level: riskLevel,
    likelihood: score(input.likelihood, 'likelihood', title),
    consequence: score(input.consequence, 'consequence', title),
    controls,
    details: text(input.details, 4000),
    source_name: sourceName,
    source_as_of: sourceAsOf,
    source_locator: text(input.source_locator, 200),
    source_document_id: optionalUuid(input.source_document_id, 'source_document_id'),
    source_attachment_id: optionalUuid(input.source_attachment_id, 'source_attachment_id'),
    review_due: isoDate(input.review_due)
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'POST required' }, 405);
  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader) return reply({ error: 'Unauthorized' }, 401);
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user: caller } } = await callerClient.auth.getUser();
    if (!caller) return reply({ error: 'Unauthorized' }, 401);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: profile } = await admin.from('user_profiles').select('role, organization_id, deactivated_at').eq('id', caller.id).single();
    if (!profile || profile.deactivated_at || !CAN_PROPOSE.has(String(profile.role))) {
      return reply({ error: 'Forbidden: an admin, master, or grand master is required' }, 403);
    }

    const body = await req.json();
    const orgId = String(body.organization_id ?? '').trim();
    if (!UUID_RE.test(orgId)) return reply({ error: 'organization_id must be an explicit organization UUID (the organisation keeping the register; resolve it with query_records first)' }, 400);
    const { data: inScope } = await callerClient.rpc('is_admin_for_org', { target_org_id: orgId });
    if (inScope !== true) return reply({ error: 'Not authorised for the specified organization_id' }, 403);
    const { data: org } = await admin.from('organizations').select('id, name').eq('id', orgId).maybeSingle();
    if (!org) return reply({ error: `organization_id ${orgId} does not exist` }, 422);

    const rawHazards: HazardInput[] = Array.isArray(body.hazards) ? body.hazards : body.title ? [body] : [];
    if (!rawHazards.length) return reply({ error: 'Provide at least one hazard in hazards[]' }, 400);
    if (rawHazards.length > MAX_HAZARDS) return reply({ error: `At most ${MAX_HAZARDS} hazards per proposal batch` }, 400);
    let hazards: CleanHazard[];
    try {
      hazards = rawHazards.map((h) => cleanPlaceHazard(h ?? {}));
    } catch (e) {
      return reply({ error: e instanceof Error ? e.message : 'Invalid hazard' }, 400);
    }

    const conversationId = text(body.conversation_id, 64);
    const reasoningBase = text(body.reasoning, 2000);
    const results: Array<Record<string, unknown>> = [];
    for (const hazard of hazards) {
      // Resolve the house and the facet's display name; the facet must belong to the house.
      let locationId = hazard.location_id;
      let placeName: string | null = null;
      if (hazard.client_site_id) {
        const { data: site } = await admin.from('client_sites').select('id, name, location_id').eq('id', hazard.client_site_id).maybeSingle();
        if (!site) { results.push({ title: hazard.title, outcome: 'rejected', error: 'client_site_id does not exist' }); continue; }
        if (locationId && locationId !== site.location_id) { results.push({ title: hazard.title, outcome: 'rejected', error: 'client_site_id is not part of location_id' }); continue; }
        locationId = site.location_id;
        placeName = site.name;
      } else if (hazard.zone_id) {
        const { data: zone } = await admin.from('location_zones').select('id, name, location_id').eq('id', hazard.zone_id).maybeSingle();
        if (!zone) { results.push({ title: hazard.title, outcome: 'rejected', error: 'zone_id does not exist' }); continue; }
        if (locationId && locationId !== zone.location_id) { results.push({ title: hazard.title, outcome: 'rejected', error: 'zone_id is not part of location_id' }); continue; }
        locationId = zone.location_id;
        placeName = zone.name;
      }
      const { data: location } = await admin.from('locations').select('id, name').eq('id', locationId).maybeSingle();
      if (!location) { results.push({ title: hazard.title, outcome: 'rejected', error: 'The place does not exist' }); continue; }
      placeName = placeName ?? location.name;
      const { data: canManage } = await callerClient.rpc('can_manage_place_hazards', { p_organization_id: orgId, p_location_id: location.id });
      if (canManage !== true) { results.push({ title: hazard.title, place: placeName, outcome: 'rejected', error: `${org.name} does not own or work at ${placeName}` }); continue; }

      // Mirrors apply_bob_place_hazard_proposal: same title at the same place and facet is replaced.
      let liveQuery = admin
        .from('place_hazards')
        .select('id, title')
        .eq('organization_id', orgId)
        .eq('location_id', location.id)
        .neq('status', 'retired');
      liveQuery = hazard.client_site_id ? liveQuery.eq('client_site_id', hazard.client_site_id) : liveQuery.is('client_site_id', null);
      liveQuery = hazard.zone_id ? liveQuery.eq('zone_id', hazard.zone_id) : liveQuery.is('zone_id', null);
      const { data: live } = await liveQuery;
      const replaces = (Array.isArray(live) ? live : []).find((row) => String(row.title).trim().toLowerCase() === hazard.title.toLowerCase())?.id ?? null;

      const payload = { organization_id: orgId, ...hazard, location_id: location.id, triggered_by: caller.id };
      const idempotencyKey = `place_hazard:${await sha256Hex(JSON.stringify([orgId, { ...hazard, location_id: location.id, title: hazard.title.toLowerCase() }]))}`;
      const reasoning = [
        reasoningBase ?? `Bob proposes the ${hazard.risk_level} hazard '${hazard.title}' at ${placeName} from ${hazard.source_name}${hazard.source_locator ? ` (${hazard.source_locator})` : ''}, ${hazard.source_as_of}.`,
        replaces ? 'Approving replaces the live hazard with the same title, so officers re-acknowledge the briefing.' : '',
        'Once approved it appears in the safety briefing officers acknowledge at shift start and on arrival.'
      ].filter(Boolean).join(' ');
      const { data: action, error } = await admin.from('bob_agentic_actions').insert({
        organization_id: profile.organization_id,
        user_id: BOB_USER_ID,
        triggered_by: caller.id,
        action_type: 'create_place_hazard',
        context_page: 'place-hazard-register',
        context_table: 'place_hazards',
        context_record_id: location.id,
        proposed_payload: payload,
        status: 'pending',
        bob_reasoning: reasoning,
        conversation_id: conversationId,
        context_summary: text(body.context_summary, 300) ?? `Hazard at ${placeName}: ${hazard.title} (${hazard.risk_level})`,
        idempotency_key: idempotencyKey
      }).select('id').single();
      if (error || !action) {
        if (error?.code === '23505') {
          const { data: pending } = await admin.from('bob_agentic_actions').select('id').eq('idempotency_key', idempotencyKey).eq('status', 'pending').maybeSingle();
          results.push(pending?.id
            ? { title: hazard.title, place: placeName, outcome: 'already_pending', action_id: pending.id }
            : { title: hazard.title, place: placeName, outcome: 'failed', error: 'The concurrent proposal could not be confirmed. Retry.' });
          continue;
        }
        results.push({ title: hazard.title, place: placeName, outcome: 'failed', error: error?.message ?? 'Could not create proposal' });
        continue;
      }
      results.push({ title: hazard.title, place: placeName, risk_level: hazard.risk_level, outcome: 'pending', action_id: action.id, replaces });
    }

    const filed = results.filter((r) => r.outcome === 'pending' || r.outcome === 'already_pending');
    return reply({
      success: filed.length > 0,
      organization_id: orgId,
      organization_name: org.name,
      results,
      action_ids: filed.map((r) => r.action_id).filter(Boolean),
      note: filed.length
        ? `Filed ${filed.length} place-hazard proposal${filed.length === 1 ? '' : 's'} for ${org.name}'s register. Nothing reaches officers until each is approved in the bell; then officers see it in their safety briefing and must acknowledge it.`
        : `No place-hazard proposals were filed for ${org.name}.`
    }, filed.length ? 200 : 422);
  } catch (err) {
    return reply({ error: 'Server error', details: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});
