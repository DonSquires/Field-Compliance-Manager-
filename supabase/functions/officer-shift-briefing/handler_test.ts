import { handleOfficerShiftBriefing } from './handler.ts';

const shiftId = '00000000-0000-4000-8000-000000000001';
const stopId = '00000000-0000-4000-8000-000000000003';
const otherStopId = '00000000-0000-4000-8000-000000000004';
const assert = (condition: unknown, label: string) => { if (!condition) throw new Error(label); };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

async function exercise(options: { inactive?: boolean; unassigned?: boolean; unavailable?: boolean; wrongHash?: boolean; externalProvider?: boolean; vpsProvider?: boolean; missingAuth?: boolean; requestedStop?: string; wrongSafetyStop?: boolean; mismatchedContract?: boolean; missingRoster?: boolean; wrongRosterOfficer?: boolean; matchingStaffIdDifferentUser?: boolean; legacyStaff?: boolean; noContact?: boolean; contactNameOnly?: boolean; contactPhoneOnly?: boolean; withheldRequirement?: boolean; warning?: boolean; zonePost?: boolean; zoneVerification?: string } = {}) {
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
      stop: { id: stopId, status: 'pending', sla_arrive_by: '2026-11-06T00:00:00Z', actual_arrived_at: null, actual_departed_at: null, officer_notes: null },
      module: { id: 'module', status: 'pending', started_at: null, completed_at: null },
      place: options.zonePost
        ? { id: 'zone', name: 'Mudflat track', address: null, risk_level: 'high', site_brief: 'Gate at north end.', access_instructions: 'Use the north gate.', hs_notes: 'Tidal flats.' }
        : { id: 'site', name: 'Synthetic Hospital', address: '1 Test Street', risk_level: 'high', site_brief: 'Ask Alex Example to check the exit.', access_instructions: 'Use reception.', hs_notes: null },
      attendance_evidence: { arrival: { reference: 'SG-12345678', action: 'arrive', occurred_at: '2026-11-06T00:00:00Z', unexpected_private_field: 'Never disclose' }, departure: null }, unexpected_private_field: 'Never disclose',
    });
    if (url.pathname.endsWith('/rpc/get_shift_safety_briefing')) return json({
      shift_id: shiftId, stop_id: options.wrongSafetyStop ? otherStopId : body?.p_stop_id ?? null, shift_status: 'accepted', places: [{ kind: 'site', id: 'site', location_id: 'location', name: 'Synthetic Hospital', unexpected_private_field: 'Never disclose' }], hazards: [],
      warnings: options.warning ? [{ id: 'warning', hazard_class: 'other', alert_level: 'high', raised_at: '2026-11-06T00:00:00Z', organization_name: 'Synthetic Organisation', contact_phone: '0800000000', reason: 'Ask Alex Example to check the exit.' }] : [], item_count: options.warning ? 1 : 0,
      briefing_hash: 'briefing-version', acknowledgement_required: false, acknowledged: false, acknowledged_at: null, changed_since_acknowledgement: false, is_assigned_officer: true,
    });
    if (url.pathname.endsWith('/shift_stop_modules')) return json({ service_agreement_location_id: 'agreement-location', service_agreement_module_id: 'agreement-module' });
    if (url.pathname.endsWith('/service_agreement_locations')) return json(options.zonePost ? { service_agreement_id: 'agreement', site_id: null, zone_id: 'zone' } : { service_agreement_id: 'agreement', site_id: 'site', zone_id: null });
    if (url.pathname.endsWith('/service_agreement_modules')) return json({ service_agreement_id: options.mismatchedContract ? 'other-agreement' : 'agreement' });
    if (url.pathname.endsWith('/location_zones')) return json({ center_point: { type: 'Point', coordinates: [174.78, -41.29] }, boundary_verification: options.zoneVerification ?? 'verified' });
    if (url.pathname.endsWith('/client_sites')) return options.zonePost ? json({ code: 'PGRST116', message: 'No site row' }, 406) : json({ gps_lat: -41, gps_lng: 173, client_organization_id: 'different-place-owner', boundary_verification: 'unverified' });
    if (url.pathname.endsWith('/roster_slots')) return json(options.missingRoster ? null : { id: 'slot', work_unit_id: 'unit', staff_id: options.matchingStaffIdDifferentUser || options.legacyStaff ? '00000000-0000-4000-8000-000000000002' : 'staff', status: 'accepted', notes: 'Ask Alex Example to check reception.' });
    if (url.pathname.endsWith('/staff_profiles')) return json({ id: options.matchingStaffIdDifferentUser || options.legacyStaff ? '00000000-0000-4000-8000-000000000002' : 'staff', user_id: options.legacyStaff ? null : options.wrongRosterOfficer || options.matchingStaffIdDifferentUser ? 'different-officer' : '00000000-0000-4000-8000-000000000002' });
    if (url.pathname.endsWith('/roster_slot_contacts')) return json(options.noContact ? null : { contact_name: options.contactPhoneOnly ? null : 'Authorised Contact', contact_phone: options.contactNameOnly ? null : '+64000000000' });
    if (url.pathname.endsWith('/roster_work_units')) return json({ name: 'Hospital post', organization_id: 'provider', required_skill_names: ['Induction', 'Ask Alex Example to help'], required_skill_ids: [], service_agreement_location_id: 'agreement-location', service_agreement_module_id: 'agreement-module' });
    if (url.pathname === '/api/bob/officer/privacy') {
      if (options.unavailable) return json({ error: 'Unavailable' }, 503);
      const fields = body.fields as Record<string, string>;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(Object.entries(fields))));
      const source_hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      assert(init?.redirect === 'error', 'Sensitive control-plane requests must not follow redirects');
      const reviewed: Record<string, string | null> = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.replaceAll('Alex Example', '[name withheld]')]));
      if (options.withheldRequirement) reviewed.requirement_0 = null;
      return json({ fields: reviewed, privacy: { status: options.withheldRequirement ? 'partly_withheld' : 'checked', provider: options.externalProvider ? 'ollama_cloud' : options.vpsProvider ? 'ollama' : 'gpu_workstation', model: 'synthetic-private', source_hash: options.wrongHash ? 'wrong-source' : source_hash } });
    }
    throw new Error(`Unexpected synthetic endpoint: ${url.pathname}`);
  };
  try {
    const request = new Request('https://edge.invalid/officer-shift-briefing', {
      method: 'POST', headers: options.missingAuth ? {} : { Authorization: 'Bearer synthetic-user' }, body: JSON.stringify({ shift_id: shiftId }),
    });
    const response = await handleOfficerShiftBriefing(new Request(request, {
      body: JSON.stringify({ shift_id: shiftId, ...(options.requestedStop ? { stop_id: options.requestedStop } : {}) }),
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
  const contacts = result.calls.find((call) => call.path.endsWith('/roster_slot_contacts'));
  assert(contacts?.query.includes('roster_slot_id=eq.slot'), 'Only the explicitly designated contact for this roster slot may be read');
  assert(!result.calls.some((call) => call.path.endsWith('/crm_contacts')), 'General account contacts are not inferred as shift contacts');
  assert(result.data.post.place.site_brief === 'Ask [name withheld] to check the exit.', 'Only reviewed narrative can leave');
  assert(result.data.roster_notes === 'Ask [name withheld] to check reception.', 'Roster instructions must also be privately reviewed');
  assert(result.data.requirements[0] === 'Induction' && result.data.requirements[1] === 'Ask [name withheld] to help', 'Skill requirements must also be privately reviewed');
  assert(result.data.contacts[0].name === 'Authorised Contact', 'Legitimate structured operational contact remains visible');
  assert(!JSON.stringify(result.data).includes('Never disclose'), 'Unknown source fields cannot leak through spreads');
  assert(result.data.post.place.boundary_verified === false, 'Mapped but unverified boundaries are not called verified');
  assert(result.response.headers.get('Cache-Control') === 'no-store', 'Briefing cannot be cached');
});

Deno.test('mismatched assignment or roster records reveal no shift contact', async () => {
  for (const options of [{ mismatchedContract: true }, { wrongRosterOfficer: true }]) {
    const result = await exercise(options);
    assert([403, 502].includes(result.response.status), 'Disagreeing assignment records must fail closed');
    assert(!result.calls.some((call) => call.path.endsWith('/roster_slot_contacts')), 'No contact read may follow a mismatched assignment');
  }
});

Deno.test('a linked staff user takes precedence over a matching legacy staff ID', async () => {
  const mismatch = await exercise({ matchingStaffIdDifferentUser: true });
  assert(mismatch.response.status === 403, 'A staff ID cannot override a different linked user');
  assert(!mismatch.calls.some((call) => call.path.endsWith('/roster_slot_contacts')), 'Mismatched identities must not trigger contact reads');
  const legacy = await exercise({ legacyStaff: true });
  assert(legacy.response.status === 200 && legacy.data.contacts.length === 1, 'An unlinked legacy staff ID may identify the assigned officer');
});

Deno.test('a shift contact can contain only a name or only a phone', async () => {
  const nameOnly = await exercise({ contactNameOnly: true });
  assert(nameOnly.data.contacts[0].name === 'Authorised Contact' && nameOnly.data.contacts[0].phone === null, 'Name-only designation stays intact');
  const phoneOnly = await exercise({ contactPhoneOnly: true });
  assert(phoneOnly.data.contacts[0].name === 'Shift contact' && phoneOnly.data.contacts[0].phone === '+64000000000', 'Phone-only designation has no invented person');
});

Deno.test('missing roster requirements are unavailable, not an empty confirmed list', async () => {
  const result = await exercise({ missingRoster: true });
  assert(result.response.status === 200 && result.data.requirements === null, 'Absent work unit must not imply no requirements');
  assert(result.data.contacts.length === 0, 'No contact may be invented without a roster designation');
  const noContact = await exercise({ noContact: true });
  assert(noContact.data.contacts.length === 0, 'An undesignated shift must not inherit unrelated account contacts');
});

Deno.test('unauthenticated, inactive and unassigned callers receive no site or contact disclosure', async () => {
  for (const options of [{ missingAuth: true }, { inactive: true }, { unassigned: true }]) {
    const result = await exercise(options);
    assert(!result.calls.some((call) => /\/(?:client_sites|roster_slot_contacts)$/.test(call.path)), 'No privileged place/contact read without assignment authority');
    assert(!JSON.stringify(result.data).includes('Synthetic Hospital'), 'No assignment data should leave');
    if (options.missingAuth) assert(result.response.status === 401, 'Missing authentication must be refused');
    if (options.inactive) assert(result.response.status === 403, 'Inactive identity must be refused');
  }
});

Deno.test('private outages and external or mismatched receipts withhold narrative and safety, not legitimate contact names', async () => {
  for (const options of [{ unavailable: true }, { wrongHash: true }, { externalProvider: true }]) {
    const result = await exercise(options);
    assert(result.data.privacy.status === 'unavailable', 'Private review failure cannot look clean');
    assert(result.data.post.place.site_brief === null && result.data.post.shift.notes === null && result.data.roster_notes === null && result.data.safety === null && result.data.requirements === null, 'Narrative, requirements and safety stay withheld');
    assert(result.data.contacts[0].name === 'Authorised Contact', 'Separately authorised operational contacts remain visible');
    assert(!JSON.stringify(result.data).includes('Alex Example'), 'Private source text cannot escape');
  }
});

Deno.test('the qualified VPS Ollama receipt can disclose only the reviewed briefing projection', async () => {
  const result = await exercise({ vpsProvider: true });
  assert(result.response.status === 200, 'A checked private VPS receipt is accepted');
  assert(result.data.privacy.provider === 'ollama', 'The receipt identifies the private fallback');
  assert(result.data.post.place.site_brief === 'Ask [name withheld] to check the exit.', 'Only reviewed narrative leaves the edge function');
  assert(!JSON.stringify(result.data).includes('Never disclose'), 'Unknown source fields remain excluded');
});

Deno.test('a partially withheld requirement cannot be presented as complete', async () => {
  const result = await exercise({ withheldRequirement: true });
  assert(result.data.privacy.status === 'partly_withheld', 'Partial private review remains visible');
  assert(result.data.requirements === null && result.data.safety === null, 'Incomplete requirements and safety remain unavailable');
  assert(result.data.contacts[0].name === 'Authorised Contact', 'The designated contact remains available');
});

Deno.test('safety warning contacts are not inferred as the designated shift contact', async () => {
  const result = await exercise({ warning: true });
  assert(result.data.safety.warnings[0].reason === 'Ask [name withheld] to check the exit.', 'Warning narrative must be privately reviewed');
  assert(result.data.safety.warnings[0].contact_phone === null, 'Undesignated warning phone numbers must not be disclosed');
  assert(!JSON.stringify(result.data).includes('0800000000'), 'The original warning contact cannot leak');
  assert(result.data.contacts[0].name === 'Authorised Contact', 'The designated shift contact stays visible');
});

Deno.test('stop safety is scoped to the selected assignment and reviewed privately', async () => {
  const result = await exercise({ requestedStop: stopId });
  assert(result.response.status === 200 && result.data.safety.stop_id === stopId, 'Own stop briefing should load');
  const safety = result.calls.find((call) => call.path.endsWith('/rpc/get_shift_safety_briefing'));
  assert(safety?.body?.p_stop_id === stopId, 'Safety RPC must use the exact stop');
  assert(!JSON.stringify(result.data).includes('Never disclose'), 'Nested receipt and place fields must be allowlisted');
  const wrongStop = await exercise({ requestedStop: otherStopId });
  assert(wrongStop.response.status === 403, 'A different stop must be refused');
  assert(!wrongStop.calls.some((call) => call.path.endsWith('/rpc/get_shift_safety_briefing') || call.path.endsWith('/client_sites')), 'No safety or privileged site read for a different stop');
  const wrongContext = await exercise({ requestedStop: stopId, wrongSafetyStop: true });
  assert(wrongContext.response.status === 502, 'A mismatched safety context must be refused');
  assert(!wrongContext.calls.some((call) => call.path.endsWith('/client_sites')), 'No privileged site read after a mismatched briefing');
});

Deno.test('zone post returns briefing without a site', async () => {
  const result = await exercise({ zonePost: true });
  assert(result.response.status === 200, 'A zone post must load without a Site');
  assert(result.data.post.place.hs_notes === 'Tidal flats.', 'The zone health and safety notes reach the officer');
  assert(result.data.post.place.access_instructions === 'Use the north gate.', 'The zone access instructions reach the officer');
  assert(!result.calls.some((call) => call.path.endsWith('/client_sites')), 'No Site is read for a zone post');
  const zoneRead = result.calls.find((call) => call.path.endsWith('/location_zones'));
  assert(zoneRead?.query.includes('id=eq.zone'), 'The zone itself supplies position and verification');
  assert(result.data.post.place.gps_lat === -41.29 && result.data.post.place.gps_lng === 174.78, 'A zone post carries the zone centre point');
  assert(result.data.post.place.boundary_verified === true, 'A verified zone boundary is reported as verified');
});

Deno.test('an unverified zone boundary is not called verified', async () => {
  const result = await exercise({ zonePost: true, zoneVerification: 'unverified' });
  assert(result.response.status === 200, 'An unverified zone post still loads');
  assert(result.data.post.place.gps_lat === -41.29 && result.data.post.place.boundary_verified === false, 'Mapped but unverified zone boundaries are not called verified');
});
