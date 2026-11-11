import { pathToFileURL } from 'node:url';
import path from 'node:path';

const orgA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const orgB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const userId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
let profileRole = 'master';
let profileDeactivatedAt = null;
const jobs = [
  { id: '11111111-1111-4111-8111-111111111111', organization_id: orgA, title: 'Old incident % report',
    human_reference: 'BB-9007199254740992', status: 'failed', created_at: '2026-01-02T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z', autopilot_requested_by: userId, autopilot_state: 'driving',
    internal_secret: 'not-for-clients' },
  { id: '22222222-2222-4222-8222-222222222222', organization_id: orgB, title: 'Other tenant job',
    human_reference: 'BB-2', status: 'failed', created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z', internal_secret: 'not-for-clients' },
];

Deno.env.set('SUPABASE_URL', 'http://example.invalid');
Deno.env.set('SUPABASE_ANON_KEY', 'fixture-anon');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'fixture-service');
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname !== 'example.invalid') throw new Error(`Unexpected outbound request: ${url.hostname}`);
  const respond = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/auth/v1/user') return respond({ id: userId, email: 'fixture@example.invalid' });
  if (url.pathname === '/rest/v1/user_profiles') return respond({
    role: profileRole, deactivated_at: profileDeactivatedAt,
    organization_id: orgA, authorized_organization_ids: [], email: 'fixture@example.invalid',
  });
  if (url.pathname === '/rest/v1/audit_log') return new Response(null, { status: 201 });
  if (url.pathname === '/rest/v1/builder_projects') return respond([]);
  if (url.pathname === '/rest/v1/rpc/builder_rename_job') {
    const args = await request.json();
    const job = jobs.find(row => row.id === args.p_job_id && row.organization_id === args.p_organization_id);
    if (!job || args.p_actor_user_id !== userId) throw new Error('Invalid rename RPC identity or organization');
    if (args.p_title === 'Audit fails') {
      return new Response(JSON.stringify({ code: '23514', message: 'fixture_deny_rename private details' }), {
        status: 400, headers: { 'content-type': 'application/json' },
      });
    }
    if (job.title !== args.p_expected_title && job.title !== args.p_title) {
      return new Response(JSON.stringify({ code: 'PT409', message: 'Builder job title changed; refresh before saving' }), {
        status: 409, headers: { 'content-type': 'application/json' },
      });
    }
    job.title = args.p_title;
    return respond(job);
  }
  if (url.pathname === '/rest/v1/builder_jobs') {
    let rows = [...jobs];
    const orgFilter = url.searchParams.get('organization_id');
    if (orgFilter) {
      const allowed = orgFilter.match(/[0-9a-f]{8}-[0-9a-f-]{27}/gi) ?? [];
      rows = rows.filter(row => allowed.includes(row.organization_id));
    }
    const idFilter = url.searchParams.get('id');
    if (idFilter?.startsWith('eq.')) rows = rows.filter(row => row.id === idFilter.slice(3));
    const referenceFilter = url.searchParams.get('human_reference');
    if (referenceFilter?.startsWith('eq.')) rows = rows.filter(row => row.human_reference === referenceFilter.slice(3));
    const titleFilter = url.searchParams.get('title');
    if (titleFilter?.startsWith('imatch.')) {
      const expression = new RegExp(titleFilter.slice('imatch.'.length), 'i');
      rows = rows.filter(row => expression.test(row.title));
    }
    const cursor = url.searchParams.get('or');
    if (cursor) {
      const match = cursor.match(/^\(created_at\.lt\.([^,]+),and\(created_at\.eq\.\1,id\.lt\.([0-9a-f-]+)\)\)$/i);
      if (!match) throw new Error('Unsupported or invalid fixture cursor');
      rows = rows.filter(row => row.created_at < match[1] || (row.created_at === match[1] && row.id < match[2]));
    }
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    const limit = url.searchParams.get('limit');
    if (limit) rows = rows.slice(0, Number(limit));
    const select = url.searchParams.get('select') ?? '*';
    const fields = select.split(',');
    const projected = rows.map(row => select === '*' ? row : Object.fromEntries(
      fields.filter(field => Object.hasOwn(row, field)).map(field => [field, row[field]]),
    ));
    const single = request.headers.get('accept')?.includes('application/vnd.pgrst.object+json');
    if (single && projected.length !== 1) return new Response(JSON.stringify({ message: 'Not found' }), { status: 406 });
    return respond(single ? projected[0] : projected);
  }
  if (url.pathname.startsWith('/rest/v1/builder_')) return respond([]);
  throw new Error(`Unexpected fixture request: ${url.pathname}`);
};

let port;
const realListen = Deno.listen;
Deno.listen = options => {
  const listener = realListen({ ...options, hostname: '127.0.0.1', port: 0 });
  port = listener.addr.port;
  return listener;
};
await import(pathToFileURL(path.resolve('supabase', 'functions', 'bob-builder-control-room', 'index.ts')).href);
if (!port) throw new Error('Builder fixture listener did not start');
const call = async body => {
  const response = await realFetch(`http://127.0.0.1:${port}`, {
    method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};
const result = {
  list: await call({ action: 'list' }),
  get: await call({ action: 'get', job_id: jobs[0].id }),
  denied: await call({ action: 'get', job_id: jobs[1].id }),
};
for (let i = 0; i < 105; i++) jobs.push({
  id: `30000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
  organization_id: orgA, human_reference: `BB-${i + 10}`, title: `Fixture job ${i}`, status: 'failed',
  created_at: '2026-01-03T00:00:00.123456+00:00', updated_at: '2026-01-03T00:00:00Z',
});
result.firstPage = await call({ action: 'list' });
result.secondPage = await call({ action: 'list', cursor: result.firstPage.body.next_cursor });
result.lookupOld = await call({ action: 'lookup_reference', reference: 'bb-9007199254740992' });
result.lookupOtherTenant = await call({ action: 'lookup_reference', reference: 'BB-2' });
result.nameSearch = await call({ action: 'search_names', query: 'INCIDENT %' });
result.namePage1 = await call({ action: 'search_names', query: 'Fixture job' });
result.namePage2 = await call({ action: 'search_names', query: 'Fixture job', cursor: result.namePage1.body.next_cursor });
result.regexLiteral = await call({ action: 'search_names', query: '.*' });
result.badName = await call({ action: 'search_names', query: ' ' });
result.badCursor = await call({ action: 'list', cursor: {
  created_at: '2026-01-03T00:00:00Z),id.not.is.null,or(', id: jobs[0].id,
} });
result.rename = await call({ action: 'rename', job_id: jobs[0].id, organization_id: orgB,
  expected_title: 'Old incident % report', title: '  Clearer work  ' });
result.renameStale = await call({ action: 'rename', job_id: jobs[0].id,
  expected_title: 'Old incident % report', title: 'Stale edit' });
result.renameOtherTenant = await call({ action: 'rename', job_id: jobs[1].id,
  expected_title: jobs[1].title, title: 'Unauthorized' });
result.renameBlank = await call({ action: 'rename', job_id: jobs[0].id,
  expected_title: 'Clearer work', title: '  ' });
result.renameMissingExpected = await call({ action: 'rename', job_id: jobs[0].id, title: 'No expected title' });
result.renameAuditFailure = await call({ action: 'rename', job_id: jobs[0].id,
  expected_title: 'Clearer work', title: 'Audit fails' });
profileDeactivatedAt = '2026-01-01T00:00:00Z';
result.renameInactive = await call({ action: 'rename', job_id: jobs[0].id,
  expected_title: 'Clearer work', title: 'Inactive change' });
profileDeactivatedAt = null;
profileRole = 'officer';
result.renameOfficer = await call({ action: 'rename', job_id: jobs[0].id,
  expected_title: 'Clearer work', title: 'Officer change' });
profileRole = 'master';
result.renameReadback = await call({ action: 'get', job_id: jobs[0].id });
console.log(`BUILDER_FIXTURE_RESULT ${JSON.stringify(result)}`);
Deno.exit(0);
