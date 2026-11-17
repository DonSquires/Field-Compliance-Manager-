import { handleOfficerPatrolStopBriefing } from './handler.ts';

const shiftId = '00000000-0000-4000-8000-000000000001';
const stopId = '00000000-0000-4000-8000-000000000002';
const otherId = '00000000-0000-4000-8000-000000000003';
const siteId = '00000000-0000-4000-8000-000000000004';
const userId = '00000000-0000-4000-8000-000000000005';
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

type Options = {
  missingAuth?: boolean; invalidUser?: boolean; inactive?: boolean; unassigned?: boolean;
  journeyOutage?: boolean; wrongJourneyShift?: boolean; wrongJourneyStop?: boolean; incomplete?: boolean;
  wrongRawShift?: boolean; wrongRawStop?: boolean; wrongPlace?: boolean; rawOutage?: boolean;
  wrongPlaceId?: boolean; wrongJoinedId?: boolean; missingPlace?: boolean; extraJoin?: boolean;
  zone?: boolean; invalidNarrative?: boolean;
  outage?: boolean; wrongHash?: boolean; provider?: string; badModel?: boolean;
  missingField?: boolean; extraField?: boolean; nullChecked?: boolean; partial?: boolean;
  changedSource?: boolean; changedAssignment?: boolean; changedSourcePlace?: boolean; changedJoinedPlace?: boolean;
  revoked?: boolean; requestedStop?: string;
};

async function exercise(options: Options = {}) {
  const keys = {
    SUPABASE_URL: 'https://synthetic.supabase.invalid', SUPABASE_ANON_KEY: 'synthetic-public',
    SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', BOB_CONTROL_PLANE_URL: 'https://private-control.invalid',
    BOB_ADMIN_TOKEN: 'synthetic-control',
  };
  const previous = Object.fromEntries(Object.keys(keys).map((key) => [key, Deno.env.get(key)]));
  for (const [key, value] of Object.entries(keys)) Deno.env.set(key, value);
  const originalFetch = globalThis.fetch;
  const calls: Array<{ path: string; auth: string | null; body: Record<string, unknown> | null; query: string }> = [];
  let journeys = 0, sources = 0, profiles = 0;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init), url = new URL(request.url);
    const body = request.method === 'POST' ? await request.json() : null;
    calls.push({ path: url.pathname, auth: request.headers.get('Authorization'), body, query: url.search });
    if (url.pathname === '/auth/v1/user') return options.invalidUser ? json({ message: 'invalid' }, 401) : json({ id: userId, aud: 'authenticated', app_metadata: {}, user_metadata: {} });
    if (url.pathname.endsWith('/user_profiles')) {
      profiles++;
      return json({ deactivated_at: options.inactive || (options.revoked && profiles > 1) ? '2026-01-01' : null });
    }
    if (url.pathname.endsWith('/rpc/get_officer_patrol_journey')) {
      journeys++;
      if (options.journeyOutage) return json({ message: 'offline' }, 503);
      if (options.unassigned) return json(null);
      return json({
        shift_id: options.wrongJourneyShift ? otherId : shiftId,
        stops: [{
          id: options.wrongJourneyStop ? otherId : stopId,
          client_attribution_complete: !options.incomplete,
          place: options.zone
            ? { kind: 'zone', site_id: null, zone_id: siteId, name: 'Test area', address: null }
            : { kind: 'site', site_id: options.changedAssignment && journeys > 1 ? otherId : siteId, zone_id: null, name: 'Test site', address: 'Test address' },
        }],
      });
    }
    if (url.pathname.endsWith('/shift_stops')) {
      sources++;
      if (options.rawOutage) return json({ message: 'offline' }, 503);
      const place = {
        id: options.wrongJoinedId || (options.changedJoinedPlace && sources > 1) ? otherId : siteId,
        name: options.wrongPlace ? 'Other site' : options.zone ? 'Test area' : 'Test site',
        ...(options.zone ? {} : { address: 'Test address' }),
        access_instructions: 'Use gate.', hs_notes: 'Slippery path.', extra: 'secret extra',
      };
      return json({
        id: options.wrongRawStop ? otherId : stopId,
        shift_id: options.wrongRawShift ? otherId : shiftId,
        site_id: options.zone ? null : options.wrongPlaceId || (options.changedSourcePlace && sources > 1) ? otherId : siteId,
        zone_id: options.zone ? options.wrongPlaceId || (options.changedSourcePlace && sources > 1) ? otherId : siteId : null,
        officer_instructions: options.invalidNarrative ? { secret: 'invalid' } : options.changedSource && sources > 1 ? 'Changed instruction' : 'Ask Alex Example to check the gate.',
        officer_notes: 'secret officer note', checks: [{ notes: 'secret check note' }],
        site: options.zone ? options.extraJoin ? place : null : options.missingPlace ? null : place,
        zone: options.zone ? options.missingPlace ? null : place : options.extraJoin ? place : null,
      });
    }
    if (url.pathname === '/api/bob/officer/privacy') {
      assert(init?.redirect === 'error', 'Review must not follow redirects');
      if (options.outage) return json({ message: 'offline' }, 503);
      const fields = body!.fields as Record<string, string>;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(Object.entries(fields))));
      const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      const reviewed: Record<string, string | null> = { ...fields, officer_instructions: 'Ask [name withheld] to check the gate.' };
      if (options.missingField) delete reviewed.hs_notes;
      if (options.extraField) reviewed.extra = 'secret extra';
      if (options.nullChecked || options.partial) reviewed.hs_notes = null;
      return json({ fields: reviewed, privacy: {
        status: options.partial ? 'partly_withheld' : 'checked', provider: options.provider ?? 'gpu_workstation',
        model: options.badModel ? '' : 'synthetic-private', source_hash: options.wrongHash ? 'wrong' : hash, extra: 'secret receipt',
      } });
    }
    throw new Error(`Unexpected synthetic endpoint: ${url.pathname}`);
  };
  try {
    const response = await handleOfficerPatrolStopBriefing(new Request('https://edge.invalid/officer-patrol-stop-briefing', {
      method: 'POST', headers: options.missingAuth ? {} : { Authorization: 'Bearer synthetic-user' },
      body: JSON.stringify({ shift_id: shiftId, stop_id: options.requestedStop ?? stopId }),
    }));
    return { response, data: await response.json(), calls };
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value); }
  }
}

Deno.test('exact assigned stop only is reviewed after caller-scoped authorization', async () => {
  const { response, data, calls } = await exercise();
  assert(response.status === 200 && data.privacy.status === 'checked', 'Reviewed stop loads');
  assert(data.officer_instructions === 'Ask [name withheld] to check the gate.' && data.access_instructions === 'Use gate.' && data.hs_notes === 'Slippery path.', 'Only reviewed fields are returned');
  assert(!JSON.stringify(data).includes('secret') && !JSON.stringify(data).includes('Alex Example'), 'Extra and unreviewed fields never leave');
  assert(response.headers.get('Cache-Control') === 'no-store', 'Briefing cannot be cached');
  const journey = calls.filter((call) => call.path.endsWith('/rpc/get_officer_patrol_journey'));
  const source = calls.filter((call) => call.path.endsWith('/shift_stops'));
  assert(journey.length === 2 && source.length === 2, 'Assignment and source are rechecked after review');
  assert(journey.every((call) => call.auth === 'Bearer synthetic-user' && call.body?.p_shift_id === shiftId), 'Journey uses exact shift and caller JWT');
  assert(calls.findIndex((call) => call.path.endsWith('/rpc/get_officer_patrol_journey')) < calls.findIndex((call) => call.path.endsWith('/shift_stops')), 'Assignment precedes the privileged read');
  assert(!calls.some((call) => call.path.endsWith('/rpc/get_officer_patrol_stops')), 'Legacy raw RPC is never called');
  assert(source.every((call) => {
    const query = new URLSearchParams(call.query), select = query.get('select') ?? '';
    return call.auth === 'Bearer synthetic-service' && query.get('id') === `eq.${stopId}`
      && query.get('shift_id') === `eq.${shiftId}` && query.get('site_id') === `eq.${siteId}`
      && query.get('zone_id') === 'is.null'
      && select === 'id,shift_id,site_id,zone_id,officer_instructions,site:client_sites!shift_stops_site_id_fkey(id,name,address,access_instructions,hs_notes),zone:location_zones!shift_stops_zone_id_fkey(id,name,access_instructions,hs_notes)';
  }), 'Service read is restricted to the exact stop, shift, place and selected fields');
  const review = calls.find((call) => call.path === '/api/bob/officer/privacy');
  assert(JSON.stringify(review?.body).includes('Alex Example') && !JSON.stringify(review?.body).includes('secret'), 'Private review receives only selected narrative fields');
});

Deno.test('missing, inactive, unassigned, wrong shift and wrong stop fail before source or review', async () => {
  for (const options of [
    { missingAuth: true }, { invalidUser: true }, { inactive: true }, { unassigned: true }, { journeyOutage: true },
    { wrongJourneyShift: true }, { wrongJourneyStop: true }, { incomplete: true }, { requestedStop: otherId },
  ]) {
    const { response, data, calls } = await exercise(options);
    assert(response.status !== 200 && data.privacy.status === 'unavailable', 'Assignment must fail closed');
    assert(!calls.some((call) => call.path.endsWith('/shift_stops') || call.path.endsWith('/rpc/get_officer_patrol_stops') || call.path === '/api/bob/officer/privacy'), 'No raw or Oracle read without exact assignment');
    assert(!JSON.stringify(data).includes('secret'), 'No source disclosure');
  }
});

Deno.test('invalid or mismatched raw sources never reach the Oracle', async () => {
  for (const options of [{ wrongRawShift: true }, { wrongRawStop: true }, { wrongPlace: true }, { wrongPlaceId: true },
    { wrongJoinedId: true }, { missingPlace: true }, { extraJoin: true }, { rawOutage: true }, { invalidNarrative: true }]) {
    const { response, data, calls } = await exercise(options);
    assert(response.status !== 200 && data.privacy.status === 'unavailable', 'Mismatched or unavailable source fails closed');
    assert(!calls.some((call) => call.path === '/api/bob/officer/privacy'), 'No review of a mismatched source');
  }
});

Deno.test('a zone stop uses its own reviewed narrative', async () => {
  const { data, calls } = await exercise({ zone: true });
  assert(data.privacy.status === 'checked' && data.hs_notes === 'Slippery path.', 'A correctly scoped zone can be reviewed');
  assert(calls.filter((call) => call.path.endsWith('/shift_stops')).every((call) => {
    const query = new URLSearchParams(call.query);
    return query.get('zone_id') === `eq.${siteId}` && query.get('site_id') === 'is.null';
  }), 'The privileged read is limited to the assigned zone');
});

Deno.test('outage, forged receipts, missing fields and unqualified providers withhold all text', async () => {
  for (const options of [
    { outage: true }, { wrongHash: true }, { provider: 'ollama_cloud' }, { badModel: true },
    { missingField: true }, { extraField: true }, { nullChecked: true },
  ]) {
    const { data } = await exercise(options);
    assert(data.privacy.status === 'unavailable', 'Unqualified receipt is not a successful review');
    assert(data.officer_instructions === null && data.access_instructions === null && data.hs_notes === null, 'All narrative is withheld');
    assert(!JSON.stringify(data).includes('Alex Example'), 'Original text must not escape');
  }
});

Deno.test('partial review exposes only reviewed fields and marks withholding', async () => {
  const { data } = await exercise({ partial: true, provider: 'ollama' });
  assert(data.privacy.status === 'partly_withheld' && data.hs_notes === null, 'Withheld safety stays unavailable');
  assert(data.officer_instructions === 'Ask [name withheld] to check the gate.', 'Reviewed fields remain available');
});

Deno.test('assignment revocation and changed source during review withhold the result', async () => {
  for (const options of [{ changedSource: true }, { changedAssignment: true }, { changedSourcePlace: true }, { changedJoinedPlace: true }, { revoked: true }]) {
    const { data } = await exercise(options);
    assert(data.privacy.status === 'unavailable' && data.officer_instructions === null && data.hs_notes === null, 'Stale review is never disclosed');
  }
});

Deno.test('malformed or missing exact IDs are rejected', async () => {
  const response = await handleOfficerPatrolStopBriefing(new Request('https://edge.invalid', {
    method: 'POST', headers: { Authorization: 'Bearer synthetic-user' }, body: JSON.stringify({ shift_id: shiftId, stop_id: {} }),
  }));
  assert(response.status === 400, 'IDs must be exact UUID strings');
});
