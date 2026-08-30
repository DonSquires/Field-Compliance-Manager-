const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  OWNER_MARKER,
  collectAtlasRefresh,
  buildRefreshPlan
} = require('../scripts/atlas-refresh');

function write(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test('Atlas refresh extracts concrete entities and Supabase calls without test noise', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-refresh-'));
  try {
    write(root, 'supabase/schema.sql', `
      CREATE TABLE IF NOT EXISTS "public"."alpha" ("id" uuid);
      CREATE OR REPLACE FUNCTION "public"."get_alpha"() RETURNS jsonb LANGUAGE sql AS $$
        SELECT jsonb_agg(alpha) FROM public.alpha;
      $$;
      CREATE OR REPLACE FUNCTION public.update_alpha() RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE public.alpha SET id = id;
      END;
      $$;
    `);
    write(root, 'supabase/functions/ping/index.ts', 'Deno.serve(() => new Response("ok"));');
    write(root, 'apps/web/src/pages/TestPage.tsx', `
      supabase.from('alpha').select('id');
      supabase.from('alpha').update({ active: true }).eq('id', id);
      supabase.rpc('get_alpha');
      supabase.functions.invoke('ping');
      if (ready) return null;
    `);
    write(root, 'apps/web/src/pages/TestPage.test.tsx', `supabase.from('test_noise').select('*');`);

    const manifest = collectAtlasRefresh(root);

    assert.ok(manifest.capabilities.some(row => row.entity_type === 'table' && row.entity_name === 'alpha'));
    assert.ok(manifest.capabilities.some(row => row.entity_type === 'rpc' && row.entity_name === 'get_alpha'));
    assert.ok(manifest.capabilities.some(row => row.entity_type === 'edge_function' && row.entity_name === 'ping'));
    assert.ok(manifest.edges.some(row => row.source_name === 'pages/TestPage' && row.target_name === 'alpha' && row.edge_kind === 'reads'));
    assert.ok(manifest.edges.some(row => row.source_name === 'pages/TestPage' && row.target_name === 'alpha' && row.edge_kind === 'writes'));
    assert.ok(manifest.edges.some(row => row.target_type === 'rpc' && row.target_name === 'get_alpha'));
    assert.ok(manifest.edges.some(row => row.target_type === 'edge_function' && row.target_name === 'ping'));
    assert.ok(manifest.edges.some(row => row.source_type === 'rpc' && row.source_name === 'get_alpha' && row.target_name === 'alpha' && row.edge_kind === 'reads'));
    assert.ok(manifest.edges.some(row => row.source_type === 'rpc' && row.source_name === 'update_alpha' && row.target_name === 'alpha' && row.edge_kind === 'writes'));
    assert.equal(manifest.edges.some(row => row.target_name === 'if'), false);
    assert.equal(manifest.edges.some(row => row.target_name === 'test_noise'), false);
    assert.equal(manifest.capabilities.every(row => row.exercised === null), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Atlas refresh plan preserves manual truth and retires only owned stale rows', () => {
  const manifest = {
    capabilities: [{
      entity_type: 'table', entity_name: 'alpha', present: true, wired: true,
      exercised: null, caller_summary: 'pages/TestPage', notes: OWNER_MARKER,
      refresh_source: 'ci_generator', retirement_status: 'live'
    }],
    edges: [{
      source_type: 'component', source_name: 'pages/TestPage', target_type: 'table',
      target_name: 'alpha', edge_kind: 'reads', evidence_class: 'live-code',
      retirement_status: 'live', source_file: 'apps/web/src/pages/TestPage.tsx',
      caller_context: `${OWNER_MARKER} .from('alpha')`, refresh_source: 'ci_generator'
    }]
  };
  const existingCapabilities = [
    { id: 'manual-cap', entity_type: 'table', entity_name: 'alpha', refresh_source: 'manual_seed', exercised: true },
    { id: 'stale-cap', entity_type: 'rpc', entity_name: 'old_rpc', refresh_source: 'ci_generator', notes: OWNER_MARKER },
    { id: 'retired-cap', entity_type: 'rpc', entity_name: 'retired_rpc', refresh_source: 'ci_generator', notes: OWNER_MARKER, retirement_status: 'legacy' }
  ];
  const existingEdges = [
    { id: 'manual-edge', ...manifest.edges[0], refresh_source: 'manual_seed' },
    {
      id: 'owned-stale', source_type: 'component', source_name: 'pages/Old', target_type: 'table',
      target_name: 'old_table', edge_kind: 'reads', source_file: 'apps/web/src/pages/Old.tsx',
      refresh_source: 'ci_generator', caller_context: `${OWNER_MARKER} stale`
    },
    {
      id: 'legacy-generator', source_type: 'component', source_name: 'pages/Legacy', target_type: 'table',
      target_name: 'if', edge_kind: 'references', source_file: 'apps/web/src/pages/Legacy.tsx',
      refresh_source: 'ci_generator', caller_context: 'raw reference to if'
    },
    {
      id: 'retired-edge', source_type: 'component', source_name: 'pages/Retired', target_type: 'table',
      target_name: 'retired_table', edge_kind: 'reads', source_file: 'apps/web/src/pages/Retired.tsx',
      refresh_source: 'ci_generator', caller_context: `${OWNER_MARKER} retired`, retirement_status: 'legacy'
    }
  ];

  const plan = buildRefreshPlan(manifest, existingCapabilities, existingEdges);

  assert.equal(plan.capabilityUpserts.length, 0);
  assert.deepEqual(plan.capabilityRetireIds, ['stale-cap']);
  assert.equal(plan.edgeUpserts.length, 0);
  assert.deepEqual(plan.edgeRetireIds, ['owned-stale']);
  assert.equal(plan.skippedManualCapabilities, 1);
  assert.equal(plan.skippedManualEdges, 1);
  assert.equal(plan.edgeRetireIds.includes('legacy-generator'), false);
});

test('Atlas refresh plan preserves exercised state on CI-owned capabilities', () => {
  const manifest = {
    capabilities: [{
      entity_type: 'table', entity_name: 'alpha', present: true, wired: true,
      exercised: null, caller_summary: 'pages/TestPage', notes: OWNER_MARKER,
      refresh_source: 'ci_generator', retirement_status: 'live'
    }],
    edges: []
  };
  const existing = [{
    id: 'cap-1', entity_type: 'table', entity_name: 'alpha', refresh_source: 'ci_generator',
    exercised: true, notes: OWNER_MARKER, wired: false
  }];

  const plan = buildRefreshPlan(manifest, existing, []);

  assert.equal(plan.capabilityUpserts.length, 1);
  assert.equal(plan.capabilityUpserts[0].exercised, true);
  assert.equal(plan.capabilityUpserts[0].wired, true);
});

test('Atlas refresh plan is a no-op when owned rows already match', () => {
  const capability = {
    id: 'cap-1', entity_type: 'table', entity_name: 'alpha', present: true, wired: true,
    exercised: null, caller_summary: 'pages/TestPage', notes: `${OWNER_MARKER} source`,
    refresh_source: 'ci_generator', retirement_status: 'live'
  };
  const edge = {
    id: 'edge-1', source_type: 'component', source_name: 'pages/TestPage', target_type: 'table',
    target_name: 'alpha', edge_kind: 'reads', evidence_class: 'live-code',
    retirement_status: 'live', source_file: 'apps/web/src/pages/TestPage.tsx', migration_name: null,
    caller_context: `${OWNER_MARKER} .from('alpha')`, refresh_source: 'ci_generator'
  };
  const manifest = {
    capabilities: [{ ...capability, id: undefined }],
    edges: [{ ...edge, id: undefined }]
  };

  const plan = buildRefreshPlan(manifest, [capability], [edge]);

  assert.equal(plan.capabilityUpserts.length, 0);
  assert.equal(plan.edgeUpserts.length, 0);
  assert.equal(plan.capabilityRetireIds.length, 0);
  assert.equal(plan.edgeRetireIds.length, 0);
});

test('Atlas refresh preserves caller context owned by another generator', () => {
  const edge = {
    id: 'edge-1', source_type: 'component', source_name: 'pages/TestPage', target_type: 'table',
    target_name: 'alpha', edge_kind: 'reads', evidence_class: 'live-code', retirement_status: 'live',
    source_file: 'apps/web/src/pages/TestPage.tsx', migration_name: null,
    caller_context: 'Supabase table query in component', refresh_source: 'ci_generator'
  };
  const manifest = {
    capabilities: [],
    edges: [{ ...edge, id: undefined, caller_context: `${OWNER_MARKER} .from('alpha')` }]
  };

  const plan = buildRefreshPlan(manifest, [], [edge]);

  assert.equal(plan.edgeUpserts.length, 0);
  assert.equal(plan.edgeRetireIds.length, 0);
});

test('Atlas refresh is exposed as a post-test CI command', () => {
  const root = path.resolve(__dirname, '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const workflow = fs.readFileSync(path.join(root, '.gitea/workflows/runner-test.yml'), 'utf8');

  assert.equal(packageJson.scripts['bob:refresh-capability-map'], 'npm run atlas:refresh');
  assert.match(packageJson.scripts['atlas:check'], /atlas:manifest/);
  assert.ok(workflow.indexOf('Run tests') < workflow.indexOf('Refresh live Atlas'));
  assert.match(workflow, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(workflow, /npm run bob:refresh-capability-map/);
  const refreshSource = fs.readFileSync(path.join(root, 'scripts/atlas-refresh.js'), 'utf8');
  assert.match(refreshSource, /source_file,migration_name,caller_context/);
});