import { handleOfficerShiftBriefing } from './handler.ts';

const shiftId = '00000000-0000-4000-8000-000000000001';
const assert = (condition: unknown, label: string) => { if (!condition) throw new Error(label); };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

async function exercise(options: { inactive?: boolean; unassigned?: boolean; unavailable?: boolean; wrongHash?: boolean; missingAuth?: boolean } = {}) {
  const keys = { SUPABASE_URL: 'https://synthetic.supabase.invalid', SUPABASE_ANON_KEY: 'synthetic-public', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', BOB_CONTROL_PLANE_URL: 'https://private-control.invalid', BOB_ADMIN_TOKEN: 'synthetic-control' };
  const previous = Object.fromEntries(Object.keys(keys).map((key) => [key, Deno.env.get(key)]));
  for (const [key, value] of Object.entries(keys)) Deno.env.set(key, value);
  const originalFetch = globalThis.fetch;
  const calls: Array<{ path: string; auth: string | null; body: Record<string, unknown> | null; query: string }> = [];
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init), url = new URL(request.url);
    const body = request.method === 'POST' ? await request.json() : null;
    calls.push({ path: url.pathname, auth: request.headers.get('Authorization'), body, query: url.search });
    if (url.pathname === '/auth/v1/user') return json({ id: '00000000-0000-4000-8000-000000000002', app_metadata: {}, user_metadata: {}, aud: 'authenticated' });
    if (url.pathname.endsWith('/user_profiles')) return json({ deactivated_at: options.inactive ? '2026-01-01' : null });
    if (url.pathname.endsWith('/rpc/get_officer_static_post')) return json(options.unassigned ? null : {
      shift: { id: shiftId, status: 'accepted', scheduled_start: '2026-11-06T00:00:00Z', scheduled_end: '2026-11-06T12:00:00Z', notes: 'Inspect the exit.', unexpected_private_field: 'Never disclose' },
      stop: { id: 'stop', status: 'pending', sla_arrive_by: '2026-11-06T00:00:00Z', actual_arrived_at: null, actual_departed_at: null, officer_notes: null },
      module: { id: 'module', status: 'pending', started_at: null, completed_at: null },
      place: { id: 'site', name: 'Synthetic Hospital', address: '1 Test Street', risk_level: 'high', site_brief: 'Ask Alex Example to check the exit.', access_instructions: 'Use reception.', hs_notes: null },
      attendance_evidence: { arrival: null, departure: null }, unexpected_private_field: 'Never disclose',
    });
    if (url.pathname.endsWith('/rpc/get_shift_safety_briefing')) return json({
      shift_id: shiftId, stop_id: null, shift_status: 'accepted', places: [], hazards: [], warnings: [], item_count: 0,
      briefing_hash: 'briefing-version', acknowledgement_required: false, acknowledged: false, acknowledged_at: null, changed_since_acknowledgement: false, is_assigned_officer: true,
    });
    if (url.pathname.endsWith('/client_sites')) return json({ gps_lat: -41, gps_lng: 173, client_organization_id: 'client', boundary_verification: 'unverified' });
    if (url.pathname.endsWith('/crm_contacts')) return json([{ id: 'contact', first_name: 'Authorised', last_name: 'Contact', role_title: 'Duty manager', phone: '+64000000000', mobile: null, is_primary: true, is_emergency: false }]);
    if (url.pathname.endsWith('/roster_slots')) return json({ work_unit_id: 'unit' });
    if (url.pathname.endsWith('/roster_work_units')) return json({ name: 'Hospital post', organization_id: 'provider', required_skill_names: ['Induction'], required_skill_ids: [] });
    if (url.pathname === '/api/bob/officer/privacy') {
      if (options.unavailable) return json({ error: 'Unavailable' }, 503);
      const fields = body.fields as Record<string, string>;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(Object.entries(fields))));
      const source_hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      assert(init?.redirect === 'error', 'Sensitive control-plane requests must not follow redirects');
      return json({ fields: { ...fields, site_brief: 'Ask [name withheld] to check the exit.' }, privacy: { status: 'checked', provider: 'gpu_workstation', model: 'synthetic-private', source_hash: options.wrongHash ? 'wrong-source' : source_hash } });
    }
    throw new Error(`Unexpected synthetic endpoint: ${url.pathname}`);
  };
  try {
    const response = await handleOfficerShiftBriefing(new Request('https://edge.invalid/officer-shift-briefing', {
      method: 'POST', headers: options.missingAuth ? {} : { Authorization: 'Bearer synthetic-user' }, body: JSON.stringify({ shift_id: shiftId }),
    }));
    return { response, data: await response.json(), calls };
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value); }
  }
}

Deno.test('officer briefing verifies caller and exact own assignment before privileged site/contact reads', async () => {
  const result = await exercise();
  assert(result.response.status === 200, 'Own assignment should load');
  const assignment = result.calls.find((call) => call.path.endsWith('/rpc/get_officer_static_post'));
  assert(assignment?.auth === 'Bearer synthetic-user' && assignment.body?.p_shift_id === shiftId, 'Assignment RPC must use the caller JWT and selected shift');
  const contacts = result.calls.find((call) => call.path.endsWith('/crm_contacts'));
  assert(contacts?.query.includes('organization_id=eq.client'), 'Contact read must be scoped to the assigned client');
  assert(result.data.post.place.site_brief === 'Ask [name withheld] to check the exit.', 'Only reviewed narrative can leave');
  assert(result.data.contacts[0].name === 'Authorised Contact', 'Legitimate structured operational contact remains visible');
  assert(!JSON.stringify(result.data).includes('Never disclose'), 'Unknown source fields cannot leak through spreads');
  assert(result.data.post.place.boundary_verified === false, 'Mapped but unverified boundaries are not called verified');
  assert(result.response.headers.get('Cache-Control') === 'no-store', 'Briefing cannot be cached');
});

Deno.test('unauthenticated, inactive and unassigned callers receive no site or contact disclosure', async () => {
  for (const options of [{ missingAuth: true }, { inactive: true }, { unassigned: true }]) {
    const result = await exercise(options);
    assert(!result.calls.some((call) => /\/(?:client_sites|crm_contacts)$/.test(call.path)), 'No privileged place/contact read without assignment authority');
    assert(!JSON.stringify(result.data).includes('Synthetic Hospital'), 'No assignment data should leave');
    if (options.missingAuth) assert(result.response.status === 401, 'Missing authentication must be refused');
    if (options.inactive) assert(result.response.status === 403, 'Inactive identity must be refused');
  }
});

Deno.test('private outages and mismatched source receipts withhold narrative and safety, not legitimate contact names', async () => {
  for (const options of [{ unavailable: true }, { wrongHash: true }]) {
    const result = await exercise(options);
    assert(result.data.privacy.status === 'unavailable', 'Private review failure cannot look clean');
    assert(result.data.post.place.site_brief === null && result.data.post.shift.notes === null && result.data.safety === null, 'Narrative and safety stay withheld');
    assert(result.data.contacts[0].name === 'Authorised Contact', 'Separately authorised operational contacts remain visible');
    assert(!JSON.stringify(result.data).includes('Alex Example'), 'Private source text cannot escape');
  }
});
