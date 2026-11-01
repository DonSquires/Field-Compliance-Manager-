const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  buildTriageEnvelope,
  collectLiveHttpFindings,
  describeEndpoint,
  fileDrBobFindings,
  openDrBobPacketFinder,
  packetKey,
  safePageRoute,
} = require('../builder-dr-bob-triage');

const SHA = 'ad1c7acda9d041f8a2109598557c72822795cab6';
const APP = 'https://app.example.test';
const API = 'https://project.supabase.co';
const RECORD = '1b02ab97-0000-4000-8000-000000000001';

function writeReport(dir, name, report) {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'human-test-report.json'), typeof report === 'string' ? report : JSON.stringify(report));
}

function liveResults() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-bob-triage-'));
  writeReport(dir, 'field-ops-desktop', {
    project: 'desktop-chromium',
    title: 'follows safe Admin controls: Field Operations core',
    httpErrorEvents: [
      { status: 403, method: 'POST', endpoint: `${API}/rest/v1/rpc/search_observations`, page: `${APP}/admin/field-ops?area=debrief-followup&q=someone@example.test`, step: 'button' },
      { status: 400, method: 'POST', endpoint: `${API}/rest/v1/rpc/list_verified_person_projections_for_organization`, page: `${APP}/admin/field-ops?area=debrief-followup`, step: 'button' },
      { status: 200, method: 'GET', endpoint: `${API}/rest/v1/sites`, page: `${APP}/admin/sites`, step: 'ignored success' },
      { status: 500, method: 'not a method', endpoint: `${API}/rest/v1/sites`, page: `${APP}/admin/sites`, step: 'malformed' },
      { status: 502, method: 'GET', endpoint: 'not a url', page: `${APP}/admin/sites`, step: 'malformed' },
    ],
  });
  writeReport(dir, 'field-ops-mobile', {
    project: 'mobile-chromium',
    title: 'follows safe Admin controls: Field Operations core',
    httpErrorEvents: [
      { status: 403, method: 'POST', endpoint: `${API}/rest/v1/rpc/search_observations`, page: `${APP}/admin/field-ops?area=debrief-followup`, step: 'button' },
    ],
  });
  writeReport(dir, 'finance-desktop', {
    project: 'desktop-chromium',
    title: 'follows safe Admin controls: Finance reports and records',
    httpErrorEvents: [
      { status: 503, method: 'POST', endpoint: `${API}/functions/v1/finance-akahu-apply-org`, page: `${APP}/admin/investigations/${RECORD}?token=secret-value`, step: 'button' },
      { status: 404, method: 'GET', endpoint: `${API}/storage/v1/object/sign/evidence/Jane%20Citizen.pdf`, page: `${APP}/admin/files`, step: 'button' },
    ],
  });
  writeReport(dir, 'broken-json', '{not json');
  writeReport(dir, 'no-events', { project: 'desktop-chromium', title: 'passes', httpErrorEvents: [] });
  fs.mkdirSync(path.join(dir, 'no-report'));
  fs.mkdirSync(path.join(dir, 'symlinked'));
  fs.symlinkSync(path.join(dir, 'finance-desktop', 'human-test-report.json'), path.join(dir, 'symlinked', 'human-test-report.json'));
  return dir;
}

test('live findings are de-duplicated, redacted, ordered server errors first, and bounded', () => {
  const dir = liveResults();
  try {
    const collected = collectLiveHttpFindings({ resultsDir: dir });
    assert.equal(collected.reports, 4);
    assert.equal(collected.unreadable, 2, 'malformed JSON and a symlinked report are refused');
    assert.equal(collected.total, 5);
    assert.equal(collected.unique, 4);
    assert.equal(collected.truncated, false);
    assert.equal(collected.findings[0].status, 503);
    assert.equal(collected.findings[0].endpoint, 'functions/finance-akahu-apply-org');
    assert.equal(collected.findings[0].page, '/admin/investigations/:id');

    const forbidden = collected.findings.find((finding) => finding.endpoint === 'rpc/search_observations');
    assert.equal(forbidden.occurrences, 2);
    assert.deepEqual(forbidden.viewports, ['desktop-chromium', 'mobile-chromium']);
    assert.equal(forbidden.page, '/admin/field-ops?area=debrief-followup');

    const storage = collected.findings.find((finding) => finding.endpoint_kind === 'storage');
    assert.equal(storage.endpoint, 'storage/object', 'object paths can name files and are dropped');
    const serialised = JSON.stringify(collected);
    for (const secret of ['someone@example.test', 'secret-value', RECORD, 'Jane']) assert.equal(serialised.includes(secret), false, secret);

    const bounded = collectLiveHttpFindings({ resultsDir: dir, maxFindings: 2 });
    assert.equal(bounded.findings.length, 2);
    assert.equal(bounded.truncated, true);
    assert.deepEqual(collectLiveHttpFindings({ resultsDir: path.join(dir, 'missing') }).findings, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('routes and endpoints keep only navigation context', () => {
  assert.equal(safePageRoute(`${APP}/admin/site-360/${RECORD}?area=live-map&email=a@b.test&tab=history`), '/admin/site-360/:id?area=live-map&tab=history');
  assert.equal(safePageRoute(`${APP}/officer/report/123456?view=a%20b`), '/officer/report/:n');
  assert.equal(safePageRoute('not a url'), 'unknown');
  assert.deepEqual(describeEndpoint(`${API}/rest/v1/rpc/search_observations`), { kind: 'rpc', label: 'rpc/search_observations' });
  assert.deepEqual(describeEndpoint(`${API}/rest/v1/sites`), { kind: 'table', label: 'rest/sites' });
  assert.deepEqual(describeEndpoint(`${API}/auth/v1/token`), { kind: 'auth', label: 'auth/token' });
  assert.deepEqual(describeEndpoint(`${APP}/assets/index-${'a1'.repeat(16)}.js`), { kind: 'http', label: `app.example.test/assets/:token` });
  assert.equal(packetKey('0123456789abcdef', SHA), 'dr-bob:0123456789abcdef:ad1c7acda9d0');
});

// The real triage classifier (TypeScript, loaded with Node's type stripping) decides every envelope.
function classify(envelopes) {
  const script = `
    const logic = await import(${JSON.stringify(path.resolve(__dirname, '../supabase/functions/bob-triage-report/triage-logic.ts'))});
    const input = JSON.parse(process.env.ENVELOPES);
    console.log(JSON.stringify(input.map((raw) => {
      const { envelope, redaction } = logic.validateAndRedactEnvelope(raw);
      const stopLine = logic.screenStopLines(envelope);
      const verdict = stopLine.hit ? { triage: 'unknown', confidence: null } : (logic.classifyByRules(envelope) ?? logic.classifyByModel(envelope));
      const route = logic.deriveRoute(stopLine.hit, verdict.triage, verdict.confidence);
      return { triage: verdict.triage, route, stop_line: stopLine.hit, repair_risk: logic.classifyRepairRisk(envelope, stopLine.hit, verdict.triage, verdict.confidence, route), dropped: redaction.dropped_fields };
    })));
  `;
  const output = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], {
    env: { ...process.env, ENVELOPES: JSON.stringify(envelopes) },
    encoding: 'utf8',
  });
  return JSON.parse(output);
}

function finding(overrides) {
  return { fingerprint: '0123456789abcdef', status: 500, method: 'POST', endpoint: 'rpc/hub_summary', endpoint_kind: 'rpc', page: '/admin/hub', walk: 'follows safe Admin controls: Mission Control', viewports: ['desktop-chromium'], occurrences: 1, ...overrides };
}

test('Dr Bob envelopes pass the real triage contract and keep repair-risk governance', () => {
  const verdicts = classify([
    buildTriageEnvelope(finding({}), { sha: SHA }),
    buildTriageEnvelope(finding({ status: 404, method: 'GET', endpoint: 'app.example.test/assets/chunk.js' }), { sha: SHA }),
    buildTriageEnvelope(finding({ status: 503, endpoint: 'functions/finance-akahu-apply-org', page: '/admin/investigations', walk: 'follows safe Admin controls: Finance reports and records' }), { sha: SHA }),
    buildTriageEnvelope(finding({ status: 403, endpoint: 'rpc/search_observations', page: '/admin/field-ops?area=debrief-followup' }), { sha: SHA }),
    buildTriageEnvelope(finding({ status: 400, endpoint: 'rpc/list_verified_person_projections_for_organization' }), { sha: SHA }),
    buildTriageEnvelope(finding({ page: '/admin/enforcement' }), { sha: SHA }),
  ]);
  for (const verdict of verdicts) assert.equal(verdict.dropped, 0, 'every field is part of the schema-v1 envelope');
  assert.deepEqual(verdicts[0], { triage: 'bug', route: 'dispatch_flow', stop_line: null, repair_risk: 'routine', dropped: 0 });
  assert.equal(verdicts[1].repair_risk, 'routine');
  assert.equal(verdicts[2].repair_risk, 'protected', 'finance never self-heals unattended');
  assert.deepEqual([verdicts[3].triage, verdicts[3].repair_risk], ['data_problem', 'unknown']);
  assert.deepEqual([verdicts[4].route, verdicts[4].repair_risk], ['self_heal_apparatus', 'unknown']);
  assert.deepEqual([verdicts[5].stop_line, verdicts[5].route, verdicts[5].repair_risk], ['stop_line:unknown_with_consequence', 'grand_master_bell', 'protected']);
});

function fakeSupabaseFetch({ signIn = { status: 200, body: { access_token: 'access-token-value', user: { id: RECORD } } }, triage } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, headers: init.headers, body });
    const respond = (status, payload) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) });
    if (url.includes('/auth/v1/token')) return respond(signIn.status, signIn.body);
    if (url.includes('/auth/v1/logout')) return respond(204, {});
    if (url.endsWith('/functions/v1/bob-triage-report')) {
      if (triage) return triage(body);
      return respond(200, { packet_id: `packet-${calls.length}`, triage: 'bug', route: 'dispatch_flow', repair_risk: 'routine', automation_status: 'queued' });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { calls, fetchImpl };
}

const credentials = { supabaseUrl: `${API}/`, anonKey: 'anon-key', email: 'drbob@example.test', password: 'test-password-value' };

test('findings are filed as the test identity through the user triage path, once per open defect', async () => {
  const { calls, fetchImpl } = fakeSupabaseFetch();
  const lookups = [];
  const outcome = await fileDrBobFindings({
    ...credentials,
    sha: SHA,
    fetchImpl,
    findings: [finding({ fingerprint: 'aaaaaaaaaaaaaaaa' }), finding({ fingerprint: 'bbbbbbbbbbbbbbbb' })],
    findOpenPacket: async (query) => { lookups.push(query); return query.fingerprint === 'bbbbbbbbbbbbbbbb' ? { id: 'open-packet' } : null; },
  });
  assert.equal(outcome.status, 'filed');
  assert.equal(outcome.filed.length, 1);
  assert.equal(outcome.filed[0].repair_risk, 'routine');
  assert.deepEqual(outcome.skipped, [{ fingerprint: 'bbbbbbbbbbbbbbbb', reason: 'open_packet_exists', packet_id: 'open-packet' }]);
  assert.deepEqual(lookups.map((lookup) => lookup.observerId), [RECORD, RECORD]);

  const [signIn, filed, logout] = calls;
  assert.equal(signIn.url, `${API}/auth/v1/token?grant_type=password`);
  assert.equal(signIn.headers.apikey, 'anon-key');
  assert.equal(filed.url, `${API}/functions/v1/bob-triage-report`);
  assert.equal(filed.headers.Authorization, 'Bearer access-token-value');
  assert.equal(filed.body.client_packet_key, `dr-bob:aaaaaaaaaaaaaaaa:${SHA.slice(0, 12)}`);
  assert.equal(filed.body.envelope.schema_version, '1');
  assert.equal(logout.url, `${API}/auth/v1/logout?scope=local`);
  assert.equal(calls.length, 3);
  const serialised = JSON.stringify(outcome);
  assert.equal(serialised.includes('access-token-value') || serialised.includes('test-password-value'), false);
});

test('intake failures are reported without secrets and the observer session always ends', async () => {
  const thrown = fakeSupabaseFetch({ triage: () => { throw new Error('network down'); } });
  const partial = await fileDrBobFindings({ ...credentials, sha: SHA, fetchImpl: thrown.fetchImpl, findings: [finding({})], findOpenPacket: async () => null });
  assert.equal(partial.status, 'failed');
  assert.deepEqual(partial.errors, [{ fingerprint: '0123456789abcdef', error: 'network down' }]);
  assert.ok(thrown.calls.at(-1).url.endsWith('/auth/v1/logout?scope=local'));

  let triageCalls = 0;
  const mixed = fakeSupabaseFetch({ triage: () => {
    triageCalls += 1;
    return triageCalls === 1
      ? { ok: true, status: 200, text: async () => JSON.stringify({ packet_id: 'p1', repair_risk: 'protected', automation_status: 'awaiting_grandmaster' }) }
      : { ok: false, status: 403, text: async () => JSON.stringify({ error: 'Role not permitted' }) };
  } });
  const mixedOutcome = await fileDrBobFindings({ ...credentials, sha: SHA, fetchImpl: mixed.fetchImpl, findings: [finding({ fingerprint: 'aaaaaaaaaaaaaaaa' }), finding({ fingerprint: 'bbbbbbbbbbbbbbbb' })], findOpenPacket: async () => null });
  assert.equal(mixedOutcome.status, 'partial');
  assert.equal(mixedOutcome.errors[0].error, 'Role not permitted');

  const refused = fakeSupabaseFetch({ signIn: { status: 400, body: { error: 'invalid_grant', error_description: 'test-password-value rejected' } } });
  const signInFailed = await fileDrBobFindings({ ...credentials, sha: SHA, fetchImpl: refused.fetchImpl, findings: [finding({})], findOpenPacket: async () => null });
  assert.equal(signInFailed.status, 'failed');
  assert.equal(JSON.stringify(signInFailed).includes('test-password-value'), false);
  assert.equal(refused.calls.length, 1, 'no triage call without an observer session');

  const none = fakeSupabaseFetch();
  assert.equal((await fileDrBobFindings({ ...credentials, sha: SHA, fetchImpl: none.fetchImpl, findings: [], findOpenPacket: async () => null })).status, 'none');
  assert.equal((await fileDrBobFindings({ ...credentials, password: '', sha: SHA, fetchImpl: none.fetchImpl, findings: [finding({})], findOpenPacket: async () => null })).status, 'unconfigured');
  assert.equal(none.calls.length, 0);
});

test('the open-packet guard matches only this defect, this observer, and open dispositions', async () => {
  const filters = [];
  const builder = {
    select(columns) { filters.push(['select', columns]); return builder; },
    eq(column, value) { filters.push(['eq', column, value]); return builder; },
    like(column, value) { filters.push(['like', column, value]); return builder; },
    in(column, value) { filters.push(['in', column, value]); return builder; },
    limit(value) { filters.push(['limit', value]); return builder; },
    maybeSingle: async () => ({ data: { id: 'packet-1' }, error: null }),
  };
  const supabase = { from(table) { filters.push(['from', table]); return builder; } };
  const found = await openDrBobPacketFinder(supabase)({ observerId: RECORD, fingerprint: 'aaaaaaaaaaaaaaaa' });
  assert.deepEqual(found, { id: 'packet-1' });
  assert.deepEqual(filters, [
    ['from', 'bob_friction_packets'],
    ['select', 'id'],
    ['eq', 'user_id', RECORD],
    ['like', 'client_packet_key', 'dr-bob:aaaaaaaaaaaaaaaa:%'],
    ['in', 'disposition', ['open', 'reviewing']],
    ['limit', 1],
  ]);
  await assert.rejects(() => openDrBobPacketFinder(supabase)({ observerId: RECORD, fingerprint: "x%' or 1=1" }), /invalid finding fingerprint/);
});
