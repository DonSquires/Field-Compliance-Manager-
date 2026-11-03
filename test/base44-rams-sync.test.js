const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const load = () => import('../scripts/sync-base44-rams.mjs');
const sections = () => import('../supabase/functions/_shared/report-activity-sections.mjs');
const migration = read('supabase/migrations/20261104160000_base44_rams_sync.sql');

const OFO_COMPANY = '6927aa3bc01e948e087c9878';
const OFO_CLIENT = 'c48c1aaf-236b-417c-bbce-938c151662d6';

const functionBody = (sql, header) => {
  const start = sql.indexOf(header);
  assert.ok(start >= 0, header);
  const open = sql.indexOf('$function$', start) + '$function$'.length;
  return sql.slice(open, sql.indexOf('$function$', open));
};

function response(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: (name) => headers[name.toLowerCase()] ?? null } };
}

test('the sync fails closed without a dedicated Base44 token and never needs the owner login', async () => {
  const { readToken } = await load();
  assert.throws(() => readToken({ env: { LOCALAPPDATA: 'C:\\nowhere' }, readFile: () => { throw new Error('ENOENT'); } }), /token not configured.*nothing was read or written/);
  assert.deepEqual(readToken({ env: { BASE44_RAMS_READ_TOKEN: ' abc ' } }), { token: 'abc', source: 'environment' });
  const seen = [];
  const fromFile = readToken({ env: { LOCALAPPDATA: 'C:\\Local' }, readFile: (file) => { seen.push(file); return 'tok\n'; } });
  assert.deepEqual(fromFile, { token: 'tok', source: 'file' });
  assert.match(seen[0], /FCM[\\/]base44[\\/]rams-read-token$/);
});

test('Base44 listings are read with GET only, paginated, de-duplicated and refused when incomplete', async () => {
  const { fetchAll } = await load();
  const calls = [];
  const page = (n, from) => Array.from({ length: n }, (_, i) => ({ id: `row${String(from + i).padStart(6, '0')}` }));
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return response(200, url.includes('skip=0') ? page(500, 0) : [...page(3, 499)]);
  };
  const rows = await fetchAll('KillReturn', { fetchImpl, base: 'https://base44.app', headers: { Authorization: 'Bearer t' } });
  assert.equal(rows.length, 502);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.body, undefined);
    assert.match(call.url, /^https:\/\/base44\.app\/api\/apps\/68b0e762a4fe8d4f9ba543ca\/entities\/KillReturn\?limit=500&skip=\d+&sort=created_date$/);
  }
  await assert.rejects(fetchAll('User', { fetchImpl: async () => response(403, {}), base: 'b', headers: {} }), (error) => error.status === 403);
});

test('kill returns map to client organisations, normalised animals and booking permits; other companies are held', async () => {
  const { mapKillReturn, partition } = await load();
  const bookingPermits = new Map([['booking0001', 'ON-2026-000001']]);
  const kill = mapKillReturn({
    id: 'kill000001', company_id: OFO_COMPANY, booking_id: 'booking0001', hunting_area: ' Denckers ', hunt_date: '2026-10-12',
    return_type: 'kill', animals: [{ species: 'Pig', count: 3 }, { species: 'Deer', count: '1' }, { species: '', count: 2 }, { species: 'Goat', count: 0 }],
    user_name: 'Hunter Name', user_email: 'hunter@example.test', created_date: '2026-10-12T08:00:00.000000', updated_date: '2026-10-12T09:00:00Z',
  }, { bookingPermits });
  assert.deepEqual(kill.row.animals, [{ species: 'Pig', count: 3 }, { species: 'Deer', count: 1 }]);
  assert.equal(kill.row.client_organization_id, OFO_CLIENT);
  assert.equal(kill.row.permit_number, 'ON-2026-000001');
  assert.equal(kill.row.hunting_area, 'Denckers');
  assert.equal(kill.row.source_created_at, '2026-10-12T08:00:00.000000Z');
  assert.equal(kill.row.source_updated_at, '2026-10-12T09:00:00Z');

  const nil = mapKillReturn({ id: 'kill000002', company_id: OFO_COMPANY, hunting_area: 'Wilsons', hunt_date: '2026-10-13', return_type: 'nil', animals: [{ species: 'Pig', count: 2 }] });
  assert.deepEqual(nil.row.animals, []);
  assert.equal(nil.row.permit_number, null);

  const { mapped, held } = partition([
    { id: 'kill000003', company_id: '6927aa3bc01e948e087c9879', hunting_area: 'X', hunt_date: '2026-10-01', return_type: 'nil' },
    { id: 'kill000004', company_id: OFO_COMPANY, hunting_area: 'X', hunt_date: '2026-10-01', return_type: 'kill', is_sample: true },
    { id: 'kill000005', company_id: OFO_COMPANY, hunting_area: 'X', hunt_date: 'soon', return_type: 'kill' },
  ], mapKillReturn, {});
  assert.equal(mapped.length, 0);
  assert.deepEqual(held, { unmapped_company: 1, sample: 1, invalid: 1 });
});

test('permits carry holder contact, licence number, address, conditions and vehicles but never birthdays, licence documents or insurance', async () => {
  const { buildIndexes, mapPermit } = await load();
  const indexes = buildIndexes({
    users: [{ id: 'user000001', full_name: 'Holder One', email: 'one@example.test', phone_number: '021 000', home_address: '1 Secret Rd', birthday: '1980-01-01', firearms_license_url: 'https://x/licence.png', firearms_license_number: 'AB123', firearms_license_status: 'active' }],
    bookings: [{ id: 'b1', user_id: 'user000002', user_full_name: 'Holder Two', user_email: 'two@example.test', permit_number: 'ON-2' }],
  });
  const permit = mapPermit({
    id: 'p1', user_id: 'user000001', company_id: OFO_COMPANY, company_name: 'OneFortyOne Limited', permit_name: 'Hunting permit',
    application_type: 'Public', permit_purpose: ['Hunting', ' '], permit_number: 'ON-2026-1', expiry_date: '2027-10-29', status: 'active',
    firearms_permitted: true, special_conditions: 'Gate 8 only', walk_in_only: true, vehicles: [{ registration: 'abc123', make: 'Toyota', model: 'Hilux', color: 'White', insurance_expiry_date: '2027-01-01' }],
  }, indexes);
  assert.deepEqual(permit.row.vehicles, [{ plate: 'abc123', make: 'Toyota', model: 'Hilux', colour: 'White' }]);
  assert.deepEqual(permit.row.activities, ['Hunting']);
  assert.equal(permit.row.firearm_licence_valid, true);
  assert.equal(permit.row.firearm_licence_number, 'AB123');
  assert.equal(permit.row.address, '1 Secret Rd');
  assert.equal(permit.row.conditions, 'Gate 8 only\nWalk-in only.');
  const serialised = JSON.stringify(permit.row);
  for (const secret of ['1980-01-01', 'licence.png', 'insurance']) assert.doesNotMatch(serialised, new RegExp(secret));

  assert.equal(mapPermit({ id: 'p2', user_id: 'user000002', company_id: OFO_COMPANY, permit_number: 'ON-2', status: 'expired' }, indexes).row.holder_name, 'Holder Two');
  assert.deepEqual(mapPermit({ id: 'p3', user_id: 'user000009', company_id: OFO_COMPANY, permit_number: 'ON-3', status: 'active' }, indexes), { held: 'no_holder_name' });
});

test('apply sends batches to the server-only RPCs and skips withdrawal when the listing collapses', async () => {
  const { runSync } = await load();
  const rpcs = [];
  const fetchImpl = async (url, init) => {
    if (url.includes('/entities/KillReturn')) return response(200, [{ id: 'kill000001', company_id: OFO_COMPANY, hunting_area: 'A', hunt_date: '2026-10-01', return_type: 'nil' }]);
    if (url.includes('/entities/')) return response(url.includes('/User') ? 403 : 200, url.includes('/User') ? {} : []);
    if (url.includes('/rest/v1/hunter_kill_returns')) return response(200, [], { 'content-range': '0-0/40' });
    rpcs.push({ name: url.split('/rpc/')[1], body: JSON.parse(init.body) });
    return response(200, { inserted: 1 });
  };
  const env = { BASE44_RAMS_READ_TOKEN: 'b44-secret-value', SUPABASE_URL: 'https://fcm.test', SUPABASE_SERVICE_ROLE_KEY: 'srk-secret-value' };
  const logs = [];
  const report = await runSync({ apply: true, env, fetchImpl, log: (line) => logs.push(line) });
  assert.deepEqual(rpcs.map((call) => call.name), ['ingest_base44_rams_kill_returns']);
  assert.equal(rpcs[0].body.p_seen_source_ids, null);
  assert.equal(report.withdrawalChecked, false);
  assert.equal(report.source.usersReadable, false);
  assert.ok(logs.every((line) => !line.includes('secret-value')));

  const dry = await runSync({ apply: false, env: { BASE44_RAMS_READ_TOKEN: 'tok' }, fetchImpl, log: () => {} });
  assert.equal(dry.killReturns.mapped, 1);
  await assert.rejects(runSync({ apply: true, env: { BASE44_RAMS_READ_TOKEN: 'tok' }, fetchImpl, log: () => {} }), /SUPABASE_SERVICE_ROLE_KEY are required/);
});

test('people carry every RAMS detail and vehicle, and companions aggregate per holder across bookings', async () => {
  const { mapPerson, mapCompanions, userSourceUrl } = await load();
  const person = mapPerson({
    id: 'user000001', full_name: ' Holder  One ', legal_name: 'Holder Q One', nickname: 'H1', email: 'one@example.test', phone_number: '021 000',
    home_address: '1 Rd', birthday: '1980-01-01', firearms_license_number: 'AB123', firearms_license_expiry: '2030-02-03',
    firearms_license_status: 'active', firearms_license_url: 'https://files.example/licence.png', role: 'user', admin_level: 'none',
    is_verified: true, assigned_companies: [OFO_COMPANY, 'unknown'], created_date: '2026-01-01T00:00:00', updated_date: '2026-02-01T00:00:00Z',
    vehicles: [
      { registration: 'abc123', make: 'Toyota', model: 'Hilux', color: 'White', insurance_expiry_date: '2027-01-01', company_insurance: 'Yes',
        company_insurance_comments: 'Fleet', insurance_urls: ['https://files.example/ins.pdf', 'javascript:alert(1)'], status: 'approved', archived: false },
      { registration: ' ', make: 'None' },
    ],
  });
  assert.equal(person.row.full_name, 'Holder One');
  assert.equal(person.row.source_url, userSourceUrl());
  assert.equal(person.row.date_of_birth, '1980-01-01');
  assert.equal(person.row.firearms_licence_document_url, 'https://files.example/licence.png');
  assert.deepEqual(person.row.client_organization_ids, [OFO_CLIENT]);
  assert.equal(person.row.source_created_at, '2026-01-01T00:00:00Z');
  assert.deepEqual(person.row.vehicles, [{
    plate: 'abc123', make: 'Toyota', model: 'Hilux', colour: 'White', insurance_expiry: '2027-01-01', company_insurance: true,
    company_insurance_comments: 'Fleet', insurance_document_urls: ['https://files.example/ins.pdf'], status: 'approved', archived: false,
  }]);
  assert.deepEqual(mapPerson({ id: 'svc0000001', full_name: 'Bot', is_service: true }), { held: 'service_account' });
  assert.deepEqual(mapPerson({ id: 'user000009' }), { held: 'no_name' });

  const { mapped } = mapCompanions([
    { id: 'b1', user_id: 'user000001', company_id: OFO_COMPANY, booking_date: '2026-03-01', hunting_area: 'Denckers',
      companions: [{ full_name: 'Mate Two', email: 'Two@Example.test', phone: '022', permitted_status: 'permitted' }, { full_name: 'No Email' }] },
    { id: 'b2', user_id: 'user000001', company_id: OFO_COMPANY, booking_date: '2026-05-01', hunting_area: 'Wilsons',
      companions: [{ full_name: 'Mate Two', email: 'two@example.test' }] },
    { id: 'b3', user_id: 'user000001', booking_date: '2026-04-01', companions: [{ full_name: 'Mate Two', email: 'two@example.test', phone: '099' }] },
    { id: 'b4', user_id: 'user000002', is_sample: true, companions: [{ full_name: 'Sample' }] },
  ]);
  const mate = mapped.find((row) => row.email === 'two@example.test');
  assert.equal(mapped.length, 2);
  assert.equal(mate.booking_count, 3);
  assert.equal(mate.first_booking_date, '2026-03-01');
  assert.equal(mate.last_booking_date, '2026-05-01');
  assert.equal(mate.last_hunting_area, 'Wilsons');
  assert.equal(mate.client_organization_id, OFO_CLIENT);
  assert.equal(mate.phone, '022');
  assert.equal(mate.permitted_status, 'permitted');
});

test('apply ingests people before permits, companions and returns so they share one canonical person', async () => {
  const { runSync } = await load();
  const rpcs = [];
  const entities = {
    User: [{ id: 'user000001', full_name: 'Holder One', email: 'one@example.test' }],
    Permit: [{ id: 'p1', user_id: 'user000001', company_id: OFO_COMPANY, permit_number: 'ON-1', status: 'active' }],
    Booking: [{ id: 'b1', user_id: 'user000001', company_id: OFO_COMPANY, booking_date: '2026-03-01', companions: [{ full_name: 'Mate Two' }] }],
    KillReturn: [{ id: 'kill000001', company_id: OFO_COMPANY, hunting_area: 'A', hunt_date: '2026-10-01', return_type: 'nil' }],
  };
  const fetchImpl = async (url, init) => {
    const entity = url.match(/\/entities\/(\w+)\?/)?.[1];
    if (entity) return response(200, url.includes('skip=0') ? entities[entity] : []);
    if (url.includes('/rest/v1/hunter_kill_returns')) return response(200, [], { 'content-range': '0-0/1' });
    rpcs.push(url.split('/rpc/')[1]);
    return response(200, {});
  };
  const env = { BASE44_RAMS_READ_TOKEN: 'b44-secret-value', SUPABASE_URL: 'https://fcm.test', SUPABASE_SERVICE_ROLE_KEY: 'srk-secret-value' };
  const report = await runSync({ apply: true, env, fetchImpl, log: () => {} });
  assert.deepEqual(rpcs, ['ingest_base44_rams_people', 'ingest_base44_rams_permits', 'ingest_base44_rams_companions',
    'ingest_base44_rams_kill_returns', 'ingest_base44_rams_kill_returns']);
  assert.equal(report.people.mapped, 1);
  assert.equal(report.companions.mapped, 1);
});

test('the scheduled runner fetches the service key at runtime and only runs the read-only sync', () => {
  const runner = read('scripts/run-base44-rams-sync.ps1');
  assert.match(runner, /projects api-keys --project-ref dotczcyyzgabmtmnglqj/);
  assert.match(runner, /node scripts\\sync-base44-rams\.mjs --apply --report/);
  assert.doesNotMatch(runner, /BASE44_RAMS_READ_TOKEN\s*=/, 'the Base44 token is never embedded in the runner');
});

test('the mirror is RLS-protected, ingest is service-role only and the report wrapper copies no hunter identity', () => {
  assert.match(migration, /alter table public\.hunter_kill_returns enable row level security;/);
  assert.match(migration, /revoke all on table public\.hunter_kill_returns from public, anon, authenticated;/);
  assert.match(migration, /for select to authenticated\n\tusing \(public\.is_admin_for_org\(organization_id\)\);/);
  for (const table of ['rams_person_profiles', 'rams_person_vehicles', 'rams_person_associations']) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security;`));
    assert.match(migration, new RegExp(`create policy ${table}_provider_admin_read on public\\.${table}\\n\\tfor select to authenticated using \\(public\\.is_admin_for_org\\(organization_id\\)\\);`));
  }
  assert.match(migration, /revoke all on table public\.rams_person_profiles, public\.rams_person_vehicles, public\.rams_person_associations from public, anon, authenticated;/);
  assert.match(migration, /revoke all on function public\.base44_rams_resolve_person\(uuid, text, text, text\) from public, anon, authenticated;/);
  assert.doesNotMatch(migration, /grant execute on function public\.base44_rams_resolve_person/);
  for (const signature of ['ingest_base44_rams_kill_returns(uuid, jsonb, text[])', 'ingest_base44_rams_permits(uuid, jsonb)', 'ingest_base44_rams_people(uuid, jsonb)', 'ingest_base44_rams_companions(uuid, jsonb)']) {
    const escaped = signature.replace(/[()[\]]/g, '\\$&');
    assert.match(migration, new RegExp(`revoke all on function public\\.${escaped} from public, anon, authenticated;\\ngrant execute on function public\\.${escaped} to service_role;`));
  }
  for (const name of ['build_agreement_activity_report', 'build_agreement_activity_report_core']) {
    const signature = `${name}(uuid, timestamptz, timestamptz, integer)`.replace(/[()]/g, '\\$&');
    assert.match(migration, new RegExp(`revoke all on function public\\.${signature} from public, anon, authenticated, service_role;\\ngrant execute on function public\\.${signature} to postgres;`));
  }
  const wrapper = functionBody(migration, 'create or replace function public.build_agreement_activity_report(');
  assert.match(wrapper, /public\.build_agreement_activity_report_core\(p_service_agreement_id, p_from, p_to, p_max_lines\)/);
  assert.match(wrapper, /h\.withdrawn_at is null/);
  assert.match(wrapper, /at time zone 'Pacific\/Auckland'/);
  for (const forbidden of ['hunter_name', 'hunter_email', 'comments', 'permit_number', 'person_permit_id', 'source_booking_id']) {
    assert.doesNotMatch(wrapper, new RegExp(forbidden), `the client report must not read ${forbidden}`);
  }
});

test('the newest builder definition is still the hunter-return wrapper', () => {
  const dir = path.join(root, 'supabase', 'migrations');
  const latest = fs.readdirSync(dir).filter((file) => file.endsWith('.sql')).sort()
    .filter((file) => fs.readFileSync(path.join(dir, file), 'utf8').includes('create or replace function public.build_agreement_activity_report('))
    .pop();
  const body = functionBody(fs.readFileSync(path.join(dir, latest), 'utf8'), 'create or replace function public.build_agreement_activity_report(');
  assert.match(body, /hunterReturns/, `${latest} replaced the wrapper; change build_agreement_activity_report_core instead`);
});

test('client PDF and email show hunter returns by species and area only when the client has them', async () => {
  const { monthlyActivityBlocks, activityEmailSummary } = await sections();
  const base = {
    version: 2, totals: { entries: 1, places: 1 }, categories: [], byPlace: [], pestControl: { entries: 0 },
    incidents: { total: 0 }, observations: { total: 0 }, maintenance: {}, manufacture: {}, labels: {}, accountedFor: { reconciled: true },
  };
  const hunterReturns = {
    source: 'Hunter-submitted returns (RAMS)', returns: 3, killReturns: 2, nilReturns: 1, animals: 5,
    bySpecies: [{ species: 'Pig', animals: 4, returns: 2 }, { species: 'Deer', animals: 1, returns: 1 }],
    byArea: [{ area: 'Denckers', returns: 3, kill: 2, nil: 1, animals: 5 }],
  };
  const without = monthlyActivityBlocks({ activityReport: base });
  assert.doesNotMatch(JSON.stringify(without), /Hunter/);
  assert.doesNotMatch(activityEmailSummary({ activityReport: base }).headline, /hunter/);

  const blocks = monthlyActivityBlocks({ activityReport: { ...base, hunterReturns } });
  const metrics = blocks.find((block) => block.kind === 'metrics');
  assert.deepEqual(metrics.items.at(-1), { label: 'Hunter-reported kills', value: '5' });
  const titles = blocks.filter((block) => block.kind === 'section').map((block) => block.title ?? block.text);
  assert.ok(titles.indexOf('Hunter Kill Returns') === titles.indexOf('Pest Control') + 1, 'hunter returns follow pest control');
  const tables = blocks.filter((block) => block.kind === 'table').map((block) => JSON.stringify(block));
  assert.ok(tables.some((table) => /Animals reported/.test(table) && /Pig/.test(table)));
  assert.ok(tables.some((table) => /Hunting area/.test(table) && /Denckers/.test(table)));
  assert.match(activityEmailSummary({ activityReport: { ...base, hunterReturns } }).headline, /Permit holders submitted 3 hunter returns reporting 5 animals\./);

  const empty = monthlyActivityBlocks({ activityReport: { ...base, hunterReturns: { ...hunterReturns, returns: 0, killReturns: 0, nilReturns: 0, animals: 0, bySpecies: [], byArea: [] } } });
  assert.match(JSON.stringify(empty), /No hunter kill or nil returns were submitted/);
});
