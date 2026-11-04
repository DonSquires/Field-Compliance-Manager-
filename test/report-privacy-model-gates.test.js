const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const root = path.resolve(__dirname, '..');

async function fixture() {
  const privacy = await import('../supabase/functions/_shared/report-privacy-oracle.mjs');
  const triage = await import('../supabase/functions/_shared/report-incident-triage.mjs');
  const summary = await import('../supabase/functions/_shared/report-executive-summary.mjs');
  const sections = await import('../supabase/functions/_shared/report-activity-sections.mjs');
  const first = { d: '2026-10-01', p: 'Fixture Forest', k: 'event', c: 'maintenance', n: 'Alice Example bypassed the gate.' };
  const second = { d: '2026-10-02', p: 'Fixture Forest', k: 'event', c: 'maintenance', n: 'A lock was cut.' };
  const editorial = { title: 'October report', executive_summary: '', client_notes: '', follow_up: '' };
  const original = {
    id: 'pack-1', organization_id: 'org-1', service_agreement_id: 'agreement-1',
    period_start: '2026-10-01', period_end: '2026-10-31', status: 'draft', report_kind: 'monthly',
    data: { activityReport: { version: 2, totals: { entries: 2 }, labels: {} } },
    activity_lines: { version: 2, lines: [first, second] }, editorial, updated_at: '2026-11-01T00:00:00Z',
    agreement: { name: 'Fixture agreement', client: { name: 'Fixture client' } },
  };
  const checked = privacy.applyPrivacyFindings(original.activity_lines, [
    { indexes: [0], findings: { names: ['Alice Example'], details: [] } },
    { indexes: [1], findings: null },
  ], []).activityLines;
  const cleared = { ...original, activity_lines: { ...checked, privacy: { editorial_digest: privacy.editorialDigest(editorial) } } };
  const decisions = [{
    line_key: sections.activityLineKey(first), decision: 'incident', incident_type: 'trespass',
    decided_at: '2026-10-03T00:00:00Z', bob_assessed_at: '2026-10-02T00:00:00Z',
    excerpt: 'Alice Example bypassed the gate.',
  }];
  const state = { pack: original, decisions, prompts: [], briefs: [], updates: [], audits: [], triageWrites: [] };

  const caller = {
    auth: { getUser: async () => ({ data: { user: { id: 'provider-user' } }, error: null }) },
    rpc: async () => ({ data: true, error: null }),
  };
  const query = (result) => ({
    select() { return this; },
    eq() { return this; },
    or() { return this; },
    single: async () => result(),
    order: async () => result(),
  });
  const admin = {
    from(table) {
      if (table === 'user_profiles') return query(() => ({ data: { role: 'admin', deactivated_at: null }, error: null }));
      if (table === 'monthly_report_packs') {
        return {
          ...query(() => ({ data: state.pack, error: null })),
          update(values) {
            state.updates.push(values);
            return { eq() { return this; }, select: async () => ({ data: [{ id: state.pack.id }], error: null }) };
          },
        };
      }
      if (table === 'bob_knowledge_cards') return query(() => ({ data: [{ title: 'Fixture card', content: 'Consider perimeter failures.' }], error: null }));
      if (table === 'report_incident_triage') return { upsert: async (rows) => { state.triageWrites.push(rows); return { error: null }; } };
      if (table === 'audit_log') return { insert: async (row) => { state.audits.push(row); return { error: null }; } };
      throw new Error(`Unexpected table ${table}`);
    },
    rpc: async (name) => {
      assert.equal(name, 'report_pack_trend_context');
      return { data: { months: [] }, error: null };
    },
  };
  const dependencies = {
    createClient: (_url, key) => (key === 'anon-key' ? caller : admin),
    Deno: { env: { get: (name) => ({ SUPABASE_URL: 'https://fixture.invalid', SUPABASE_ANON_KEY: 'anon-key', SUPABASE_SERVICE_ROLE_KEY: 'service-key' })[name] } },
    Request,
    Response,
    readPackTriage: async () => ({ data: state.decisions, error: null }),
    ...privacy,
    ...triage,
    readActivityLines: sections.readActivityLines,
    executiveSummaryBrief: summary.executiveSummaryBrief,
    draftExecutiveSummary: async ({ brief }) => {
      state.briefs.push(brief);
      return { summary: 'A synthetic summary.', provider: 'fixture', model: 'fixture' };
    },
    completeWithProviders: async ({ messages }) => {
      state.prompts.push(messages);
      return { value: new Map(), provider: 'fixture', model: 'fixture' };
    },
  };
  const loadHandler = (name) => {
    const source = fs.readFileSync(path.join(root, 'supabase', 'functions', name, 'index.ts'), 'utf8');
    const withoutImports = source.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];\s*/gm, '');
    let handler;
    vm.runInNewContext(stripTypeScriptTypes(withoutImports), { ...dependencies, serve: (fn) => { handler = fn; } }, { filename: name });
    assert.equal(typeof handler, 'function');
    return handler;
  };
  const request = (body = {}) => new Request('https://fixture.invalid', {
    method: 'POST', headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
    body: JSON.stringify({ pack_id: 'pack-1', ...body }),
  });
  return { state, cleared, loadHandler, request };
}

test('summary draft endpoint blocks unchecked lines before calling the model', async () => {
  const { state, cleared, loadHandler, request } = await fixture();
  const handle = loadHandler('draft-report-executive-summary');
  const blocked = await handle(request());
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /Generate preview to run the privacy check/);
  assert.equal(state.briefs.length, 0);

  state.pack = cleared;
  const drafted = await handle(request());
  assert.equal(drafted.status, 200);
  assert.equal(state.briefs.length, 1);
  assert.match(JSON.stringify(state.briefs[0]), /\[name withheld\]/);
  assert.doesNotMatch(JSON.stringify(state.briefs[0]), /Alice Example/);
  assert.equal(state.updates.length, 0, 'manual draft remains unsaved');

  const saved = await handle(request({ save_if_empty: true }));
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).saved, true);
  assert.equal(state.updates[0].editorial.executive_summary, 'A synthetic summary.');
});

test('incident endpoint blocks unchecked lines and never uses an old raw excerpt as an example', async () => {
  const { state, cleared, loadHandler, request } = await fixture();
  const handle = loadHandler('flag-report-potential-incidents');
  const blocked = await handle(request());
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /Generate preview to run the privacy check/);
  assert.equal(state.prompts.length, 0);
  assert.equal(state.triageWrites.length, 0);

  state.pack = cleared;
  const scanned = await handle(request());
  assert.equal(scanned.status, 200);
  assert.equal(state.prompts.length, 1);
  assert.match(JSON.stringify(state.prompts[0]), /\[name withheld\] bypassed the gate/);
  assert.doesNotMatch(JSON.stringify(state.prompts[0]), /Alice Example/);
  assert.equal(state.triageWrites.length, 1);
});
