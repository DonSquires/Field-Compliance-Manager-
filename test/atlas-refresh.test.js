const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  OWNER_MARKER,
  collectComponentEdges,
  collectManagedAtlas,
  collectSchemaViewEdges,
  collectSchemaForeignKeyEdges,
  collectCronSchedulerEdges,
  staleGeneratedEdgeIds,
  collectAtlasRefresh,
  buildRefreshPlan,
  scopeRefreshPlan
} = require('../scripts/atlas-refresh');
const { extractCronOperations, extractScheduledRpcName } = require('../scripts/lib/atlas-cron.cjs');

test('pg_cron declarations expose the current scheduled RPC caller', () => {
  const operations = extractCronOperations(`
    SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'field-sweep' LIMIT 1;
    IF v_job_id IS NOT NULL THEN PERFORM cron.unschedule(v_job_id); END IF;
    PERFORM cron.schedule_in_database(
      'field-sweep',
      '*/5 * * * *',
      'select public.sweep_field_work();',
      'postgres',
      NULL,
      TRUE
    );
  `);

  assert.deepEqual(operations.map(({ kind, jobName }) => ({ kind, jobName })), [
    { kind: 'unschedule', jobName: 'field-sweep' },
    { kind: 'schedule', jobName: 'field-sweep' },
  ]);
  assert.equal(extractScheduledRpcName(operations[1].command), 'sweep_field_work');
});

test('Atlas refresh treats the latest live pg_cron declaration as a real caller', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-cron-'));
  try {
    write(root, 'supabase/schema.sql', `
      CREATE OR REPLACE FUNCTION public.sweep_field_work() RETURNS jsonb
      LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
      CREATE OR REPLACE FUNCTION public.retired_sweep() RETURNS jsonb
      LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
    `);
    write(root, 'supabase/migrations/20260101000000_schedule.sql', `
      SELECT cron.schedule_in_database(
        'field-sweep',
        '*/5 * * * *',
        'select public.sweep_field_work();',
        'postgres',
        NULL,
        TRUE
      );
      SELECT cron.schedule_in_database(
        'retired-sweep',
        '0 * * * *',
        'select public.retired_sweep();',
        'postgres',
        NULL,
        TRUE
      );
    `);
    write(root, 'supabase/migrations/20260102000000_retire.sql', `
      SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'retired-sweep' LIMIT 1;
      PERFORM cron.unschedule(v_job_id);
    `);

    const edges = collectCronSchedulerEdges(root, {
      tables: new Set(),
      rpcs: new Set(['sweep_field_work', 'retired_sweep']),
    });

    assert.deepEqual(edges.map((edge) => ({
      source_name: edge.source_name,
      target_name: edge.target_name,
      edge_kind: edge.edge_kind,
    })), [{
      source_name: 'scheduler/field-sweep',
      target_name: 'sweep_field_work',
      edge_kind: 'calls',
    }]);

    const manifest = collectAtlasRefresh(root);
    assert.deepEqual(
      manifest.capabilities
        .filter((capability) => capability.entity_type === 'feature')
        .map(({ entity_name, wired, exercised, caller_summary }) => ({
          entity_name,
          wired,
          exercised,
          caller_summary,
        })),
      [{
        entity_name: 'scheduler/field-sweep',
        wired: true,
        exercised: null,
        caller_summary: 'active pg_cron schedule',
      }],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Atlas refresh can place its local manifest outside a read-only source checkout', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../scripts/atlas-refresh.js'), 'utf8');
  assert.match(source, /ATLAS_REFRESH_OUTPUT_DIR \|\| path\.join\(rootDir, '\.bob'\)/);
  assert.match(source, /retireStale: !args\.has\('--upsert-only'\)/);
  assert.match(source, /if \(retireStale\) \{[\s\S]*retireRows\(baseUrl, serviceKey, 'bob_capability_map'/);
  assert.match(source, /skippedRetirements\s*=\s*retirementCount/);
  assert.match(source, /status', '--porcelain', '--untracked-files=no'/);
  assert.match(source, /dirty \? null : read\(\['rev-parse', 'HEAD'\]\)/);
});

test('scoped Atlas refresh preserves unrelated concurrent terrain', () => {
  const existingCapabilities = [
    { id: 'cap-diagnostic', entity_name: 'bob-email-view' },
    { id: 'cap-builder', entity_name: 'builder_jobs' }
  ];
  const existingEdges = [
    { id: 'edge-diagnostic', source_name: 'onspace-ai-chat', target_name: 'bob-email-view' },
    { id: 'edge-builder', source_name: 'bob-control-plane-server', target_name: 'builder_jobs' }
  ];
  const scoped = scopeRefreshPlan({
    capabilityUpserts: [
      { entity_name: 'bob-email-view' },
      { entity_name: 'builder_jobs' }
    ],
    edgeUpserts: [
      { source_name: 'onspace-ai-chat', target_name: 'bob-email-view' },
      { source_name: 'bob-control-plane-server', target_name: 'builder_jobs' }
    ],
    capabilityRetireIds: ['cap-diagnostic', 'cap-builder'],
    edgeRetireIds: ['edge-diagnostic', 'edge-builder']
  }, existingCapabilities, existingEdges, ['bob-email-view']);

  assert.deepEqual(scoped.capabilityUpserts.map(row => row.entity_name), ['bob-email-view']);
  assert.deepEqual(scoped.edgeUpserts.map(row => row.target_name), ['bob-email-view']);
  assert.deepEqual(scoped.capabilityRetireIds, ['cap-diagnostic']);
  assert.deepEqual(scoped.edgeRetireIds, ['edge-diagnostic']);
});

function write(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test('Atlas refresh derives current SQL view reads without treating CTEs or literals as tables', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-view-'));
  try {
    write(root, 'supabase/schema.sql', `
      CREATE TABLE public.person_permits (id uuid);
      CREATE TABLE public.person_permit_vehicles (permit_id uuid, canonical_vehicle_id uuid);
      CREATE TABLE public.canonical_vehicles (id uuid);
      CREATE TABLE public.audit_log (id uuid);

      CREATE OR REPLACE VIEW public.person_permits_fieldwork WITH (security_invoker=true) AS
      WITH current_permits AS (
        SELECT permit.id
        FROM public.person_permits permit
      ),
      linked_vehicles AS MATERIALIZED (
        SELECT link.permit_id, vehicle.id
        FROM public.person_permit_vehicles link
        JOIN "public"."canonical_vehicles" vehicle ON vehicle.id = link.canonical_vehicle_id
      )
      SELECT permit.id
      FROM current_permits permit
      LEFT JOIN linked_vehicles vehicle ON vehicle.permit_id = permit.id;

      CREATE OR REPLACE FUNCTION public.example_text() RETURNS text
      LANGUAGE sql AS $$
        SELECT 'CREATE VIEW public.phantom AS SELECT * FROM public.audit_log';
      $$;
    `);

    const edges = collectSchemaViewEdges(root);
    assert.deepEqual(
      edges.map((edge) => [edge.source_name, edge.target_name, edge.edge_kind]).sort(),
      [
        ['person_permits_fieldwork', 'canonical_vehicles', 'reads'],
        ['person_permits_fieldwork', 'person_permit_vehicles', 'reads'],
        ['person_permits_fieldwork', 'person_permits', 'reads'],
      ],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('view-backed RPCs are calls, even when a table shares the function name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-view-rpc-'));
  try {
    write(root, 'supabase/schema.sql', `
      CREATE TABLE public.permits(id uuid);
      CREATE TABLE public.read_permits(id uuid);
      CREATE OR REPLACE FUNCTION public.read_permits() RETURNS SETOF public.permits
        LANGUAGE sql AS $$ SELECT * FROM public.permits $$;
      CREATE VIEW public.permit_view AS SELECT * FROM public.read_permits();
    `);
    assert.deepEqual(collectSchemaViewEdges(root).map((edge) => [
      edge.source_name, edge.target_type, edge.target_name, edge.edge_kind,
    ]), [['permit_view', 'rpc', 'read_permits', 'calls']]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('current permit fieldwork and policy views expose their actual dependencies', () => {
  const edges = collectSchemaViewEdges(path.resolve(__dirname, '..'));
  const hasEdge = (source, target) => edges.some((edge) => (
    edge.source_name === source &&
    edge.target_name === target &&
    edge.edge_kind === 'reads'
  ));

  assert.equal(edges.some((edge) => edge.source_name === 'person_permits_fieldwork'
    && edge.target_name === 'read_person_permits_fieldwork' && edge.target_type === 'rpc' && edge.edge_kind === 'calls'), true);
  assert.equal(hasEdge('person_permits_fieldwork', 'person_permit_vehicles'), false);
  assert.equal(hasEdge('module_place_policy_summary', 'module_event_place_matrix'), true);
  assert.equal(hasEdge('house_event_anchor_reconciliation', 'house_event_anchor_projection'), true);
});

test('current RLS policies expose unqualified helper dependencies', () => {
  const manifest = collectAtlasRefresh(path.resolve(__dirname, '..'));
  const hasSecuredByEdge = (source, target) => manifest.edges.some((edge) => (
    edge.source_type === 'table' &&
    edge.source_name === source &&
    edge.target_type === 'rpc' &&
    edge.target_name === target &&
    edge.edge_kind === 'secured_by'
  ));

  assert.equal(hasSecuredByEdge('access_presets', 'is_master_or_above'), true);
  assert.equal(hasSecuredByEdge('biosecurity_assessments', 'user_has_task_entitlement'), true);
  assert.equal(hasSecuredByEdge('infringement_notices', 'is_enforcement_operator_for_org'), true);
  assert.equal(hasSecuredByEdge('noise_assessments', 'user_has_task_entitlement'), true);
  assert.equal(hasSecuredByEdge('observations', 'user_has_task_entitlement'), true);
  assert.equal(hasSecuredByEdge('smoke_assessments', 'user_has_task_entitlement'), true);
});

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
      CREATE OR REPLACE FUNCTION public.wrap_alpha() RETURNS jsonb LANGUAGE sql AS $$
        SELECT * FROM public.get_alpha();
      $$;
      CREATE OR REPLACE FUNCTION public.guard_alpha() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RETURN NEW;
      END;
      $$;
      CREATE OR REPLACE FUNCTION public.wrap_alpha_unqualified() RETURNS jsonb LANGUAGE sql AS $$
        SELECT get_alpha();
      $$;
      CREATE OR REPLACE FUNCTION public.can_read_alpha() RETURNS boolean LANGUAGE sql AS $$
        SELECT true;
      $$;
      CREATE OR REPLACE FUNCTION public.can_read_storage_file(p_name text) RETURNS boolean LANGUAGE sql AS $$
        SELECT true;
      $$;
      CREATE OR REPLACE FUNCTION public.can_read_stale_file(p_name text) RETURNS boolean LANGUAGE sql AS $$
        SELECT true;
      $$;
      CREATE OR REPLACE FUNCTION "public"."touch_alpha"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER "guard_alpha_trigger" BEFORE UPDATE ON public."alpha"
        FOR EACH ROW EXECUTE FUNCTION public."guard_alpha"();
      CREATE TRIGGER "alpha_touch" BEFORE UPDATE ON "public"."alpha"
        FOR EACH ROW EXECUTE FUNCTION "public"."touch_alpha"();
      CREATE POLICY "alpha_read" ON "public"."alpha" FOR SELECT
        USING (can_read_alpha());
      CREATE OR REPLACE FUNCTION private.internal_only() RETURNS void LANGUAGE sql AS $$
        SELECT NULL;
      $$;
    `);
    write(root, 'supabase/migrations/20260101000000_old_storage_policy.sql', `
      CREATE POLICY bob_uploads_select ON storage.objects
        FOR SELECT USING (public.can_read_stale_file(storage.objects.name));
    `);
    write(root, 'supabase/migrations/20260102000000_current_storage_policy.sql', `
      DO $storage_policy$
      BEGIN
        EXECUTE 'drop policy if exists bob_uploads_select on storage.objects';
        EXECUTE $select_policy$
          CREATE POLICY bob_uploads_select ON storage.objects
            FOR SELECT USING (public.can_read_storage_file(storage.objects.name))
        $select_policy$;
      END
      $storage_policy$;
    `);
    write(root, 'supabase/functions/ping/index.ts', `
      fetch(\`${'${SUPABASE_URL}'}/functions/v1/echo\`);
      const url = new URL(\`${'${SUPABASE_URL}'}/functions/v1/diagnostic-view/health\`);
      fetch(url);
    `);
    write(root, 'supabase/functions/echo/index.ts', 'Deno.serve(() => new Response("ok"));');
    write(root, 'supabase/functions/diagnostic-view/index.ts', 'Deno.serve(() => new Response("ok"));');
    write(root, 'supabase/functions/scheduled-sync/index.ts', 'Deno.serve(() => new Response("ok"));');
    write(root, 'supabase/functions/external-callback/index.ts', `
      // ATLAS EXTERNAL CALLER: upstream-provider
      Deno.serve(() => new Response("ok"));
    `);
    write(root, 'supabase/schemas/ops/functions/enqueue_scheduled_sync.sql', `
      CREATE OR REPLACE FUNCTION ops.enqueue_scheduled_sync() RETURNS bigint
      LANGUAGE plpgsql AS $function$
      BEGIN
        PERFORM net.http_post(url := 'https://example.test/functions/v1/scheduled-sync');
        RETURN 1;
      END;
      $function$;
    `);
    write(root, 'apps/web/src/pages/TestPage.tsx', `
      supabase.from('alpha').select('id');
      supabase.from('alpha').update({ active: true }).eq('id', id);
      supabase.rpc('get_alpha');
      supabase.rpc(
        'update_alpha',
        { id },
      );
      supabase.functions.invoke('ping');
      supabase.functions.invoke<{ id: string }>('echo');
      if (ready) return null;
    `);
    write(root, 'apps/mobile/src/components/TestPanel.tsx', `
      supabase.from('alpha').select('id');
      supabase.functions.invoke('ping');
    `);
    write(root, 'apps/sd-card-bridge-v2/src/main.tsx', `
      supabase.rpc('get_alpha');
    `);
    write(root, 'scripts/seed-rm-forestry-roster-history.mjs', '// ATLAS CALLS: get_alpha');
    write(root, 'bob-control-plane-server.js', `
      supabase.rpc('update_alpha');
      supabase.from('alpha').select('id');
    `);
    write(root, 'apps/web/src/pages/TestPage.test.tsx', `supabase.from('test_noise').select('*');`);

    const manifest = collectAtlasRefresh(root);

    assert.ok(manifest.capabilities.some(row => row.entity_type === 'table' && row.entity_name === 'alpha'));
    assert.ok(manifest.capabilities.some(row => row.entity_type === 'rpc' && row.entity_name === 'get_alpha'));
    assert.equal(manifest.capabilities.some(row => row.entity_type === 'rpc' && row.entity_name === 'private'), false);
    assert.equal(manifest.capabilities.some(row => row.entity_type === 'rpc' && row.entity_name === 'internal_only'), false);
    assert.equal(manifest.capabilities.some(row => row.entity_type === 'rpc' && row.entity_name === 'ops'), false);
    assert.ok(manifest.capabilities.some(row => row.entity_type === 'edge_function' && row.entity_name === 'ping'));
    assert.ok(manifest.capabilities.some(row => row.entity_type === 'edge_function' && row.entity_name === 'echo'));
    assert.ok(manifest.capabilities.some(row => row.entity_type === 'edge_function' && row.entity_name === 'diagnostic-view' && row.wired));
    assert.ok(manifest.capabilities.some(row => row.entity_type === 'edge_function' && row.entity_name === 'scheduled-sync' && row.wired));
    assert.ok(manifest.capabilities.some(row => row.entity_type === 'edge_function' && row.entity_name === 'external-callback' && row.wired));
    assert.ok(manifest.capabilities.some(row => row.entity_type === 'feature' && row.entity_name === 'upstream-provider' && row.wired));
    assert.ok(manifest.edges.some(row => row.source_name === 'pages/TestPage' && row.target_name === 'alpha' && row.edge_kind === 'reads'));
    assert.ok(manifest.edges.some(row => row.source_name === 'pages/TestPage' && row.target_name === 'alpha' && row.edge_kind === 'writes'));
    assert.ok(manifest.edges.some(row => row.target_type === 'rpc' && row.target_name === 'get_alpha'));
    assert.ok(manifest.edges.some(row => row.target_type === 'rpc' && row.target_name === 'update_alpha'));
    assert.ok(manifest.edges.some(row => row.target_type === 'edge_function' && row.target_name === 'ping'));
    assert.ok(manifest.edges.some(row => row.target_type === 'edge_function' && row.target_name === 'echo'));
    assert.ok(manifest.edges.some(row => row.target_type === 'edge_function' && row.target_name === 'diagnostic-view' && row.edge_kind === 'calls'));
    assert.ok(manifest.edges.some(row => row.source_name === 'ping' && row.target_type === 'edge_function' && row.target_name === 'echo'));
    assert.ok(manifest.edges.some(row => row.source_name === 'enqueue_scheduled_sync' && row.target_type === 'edge_function' && row.target_name === 'scheduled-sync' && row.source_file === 'supabase/schemas/ops/functions/enqueue_scheduled_sync.sql'));
    assert.ok(manifest.edges.some(row => row.source_type === 'feature' && row.source_name === 'upstream-provider' && row.target_type === 'edge_function' && row.target_name === 'external-callback' && row.edge_kind === 'invokes' && row.evidence_class === 'declared-external-contract'));
    assert.ok(manifest.edges.some(row => row.source_name === 'mobile/components/TestPanel' && row.target_name === 'alpha' && row.edge_kind === 'reads'));
    assert.ok(manifest.edges.some(row => row.source_name === 'mobile/components/TestPanel' && row.target_type === 'edge_function' && row.target_name === 'ping'));
    assert.ok(manifest.edges.some(row => row.source_name === 'apps/sd-card-bridge-v2/src/main' && row.target_type === 'rpc' && row.target_name === 'get_alpha'));
    assert.ok(manifest.edges.some(row => row.source_name === 'scripts/seed-rm-forestry-roster-history' && row.target_type === 'rpc' && row.target_name === 'get_alpha'));
    assert.ok(manifest.edges.some(row => row.source_name === 'bob-control-plane-server' && row.target_type === 'rpc' && row.target_name === 'update_alpha'));
    assert.ok(manifest.edges.some(row => row.source_name === 'bob-control-plane-server' && row.target_type === 'table' && row.target_name === 'alpha'));
    assert.ok(manifest.edges.some(row => row.source_type === 'rpc' && row.source_name === 'get_alpha' && row.target_name === 'alpha' && row.edge_kind === 'reads'));
    assert.ok(manifest.edges.some(row => row.source_type === 'rpc' && row.source_name === 'update_alpha' && row.target_name === 'alpha' && row.edge_kind === 'writes'));
    assert.ok(manifest.edges.some(row => row.source_type === 'rpc' && row.source_name === 'wrap_alpha' && row.target_type === 'rpc' && row.target_name === 'get_alpha' && row.edge_kind === 'calls'));
    assert.ok(manifest.edges.some(row => row.source_type === 'table' && row.source_name === 'alpha' && row.target_type === 'rpc' && row.target_name === 'guard_alpha' && row.edge_kind === 'triggers'));
    assert.equal(manifest.capabilities.find(row => row.entity_name === 'guard_alpha').wired, true);
    assert.ok(manifest.edges.some(row => row.source_type === 'rpc' && row.source_name === 'wrap_alpha_unqualified' && row.target_type === 'rpc' && row.target_name === 'get_alpha' && row.edge_kind === 'calls'));
    assert.ok(manifest.edges.some(row => row.source_type === 'table' && row.source_name === 'alpha' && row.target_type === 'rpc' && row.target_name === 'can_read_alpha' && row.edge_kind === 'secured_by'));
    assert.ok(manifest.capabilities.some(row => row.entity_type === 'rpc' && row.entity_name === 'can_read_alpha' && row.wired));
    assert.ok(manifest.edges.some(row => row.source_type === 'table' && row.source_name === 'storage.objects' && row.target_type === 'rpc' && row.target_name === 'can_read_storage_file' && row.edge_kind === 'secured_by' && row.source_file === 'supabase/migrations/20260102000000_current_storage_policy.sql'));
    assert.ok(manifest.capabilities.some(row => row.entity_type === 'rpc' && row.entity_name === 'can_read_storage_file' && row.wired));
    assert.equal(manifest.edges.some(row => row.target_type === 'rpc' && row.target_name === 'can_read_stale_file'), false);
    assert.equal(manifest.capabilities.find(row => row.entity_name === 'can_read_stale_file').wired, false);
    assert.ok(manifest.edges.some(row => row.source_type === 'table' && row.source_name === 'alpha' && row.target_type === 'rpc' && row.target_name === 'touch_alpha' && row.edge_kind === 'triggers'));
    assert.ok(manifest.capabilities.some(row => row.entity_type === 'rpc' && row.entity_name === 'touch_alpha' && row.wired));
    assert.equal(manifest.edges.some(row => row.source_name === 'wrap_alpha' && row.target_type === 'table' && row.target_name === 'get_alpha'), false);
    assert.equal(manifest.edges.some(row => row.target_name === 'if'), false);
    assert.equal(manifest.edges.some(row => row.target_name === 'test_noise'), false);
    assert.equal(manifest.capabilities.every(row => row.exercised === null), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Atlas refresh keeps schema foreign keys separate from proven flow edges', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-refresh-fk-'));
  try {
    write(root, 'supabase/schema.sql', `
      CREATE TABLE public.parent_records (id uuid primary key);
      CREATE TABLE public.inline_children (
        id uuid primary key,
        parent_id uuid REFERENCES public.parent_records(id)
      );
      CREATE TABLE public.alter_children (id uuid primary key, parent_id uuid);
      ALTER TABLE ONLY public.alter_children
        ADD CONSTRAINT alter_children_parent_id_fkey
        FOREIGN KEY (parent_id) REFERENCES public.parent_records(id) ON DELETE CASCADE;
    `);

    const edges = collectSchemaForeignKeyEdges(root);
    assert.ok(edges.some((edge) => edge.source_name === 'inline_children'
      && edge.target_name === 'parent_records'
      && edge.edge_kind === 'fk_references'));
    assert.ok(edges.some((edge) => edge.source_name === 'alter_children'
      && edge.target_name === 'parent_records'
      && edge.edge_kind === 'fk_references'));
    assert.equal(edges.every((edge) => edge.evidence_class === 'live-schema'), true);

    const manifest = collectAtlasRefresh(root);
    assert.ok(manifest.edges.some((edge) => edge.source_name === 'alter_children'
      && edge.target_name === 'parent_records'
      && edge.edge_kind === 'fk_references'));
    assert.equal(manifest.edges.some((edge) => edge.source_name === 'alter_children'
      && edge.target_name === 'parent_records'
      && ['reads', 'writes'].includes(edge.edge_kind)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Atlas DDL inventory ignores CREATE statements inside SQL string literals', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-refresh-ddl-'));
  try {
    write(root, 'supabase/schema.sql', `
      CREATE TABLE public.real_table (id uuid);
      CREATE OR REPLACE FUNCTION public.rls_auto_enable() RETURNS event_trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        EXECUTE 'CREATE TABLE AS';
      END;
      $$;
    `);
    write(root, 'supabase/migrations/20260101000000_historical_only.sql', `
      CREATE TABLE public.retired_table (id uuid);
      CREATE FUNCTION public.retired_rpc() RETURNS void LANGUAGE sql AS $$ SELECT NULL; $$;
    `);
    write(root, 'supabase/schemas/public/tables/planned_table.sql', `
      CREATE TABLE public.planned_table (id uuid);
    `);

    const manifest = collectAtlasRefresh(root);

    assert.equal(manifest.capabilities.some(row => row.entity_type === 'table' && row.entity_name === 'real_table'), true);
    assert.equal(manifest.capabilities.some(row => row.entity_type === 'table' && row.entity_name === 'AS'), false);
    assert.equal(manifest.capabilities.some(row => row.entity_type === 'table' && row.entity_name === 'retired_table'), false);
    assert.equal(manifest.capabilities.some(row => row.entity_type === 'rpc' && row.entity_name === 'retired_rpc'), false);
    assert.equal(manifest.capabilities.some(row => row.entity_type === 'table' && row.entity_name === 'planned_table'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('managed organization spine routes human actions through governed RPCs', () => {
  const atlas = collectManagedAtlas(path.resolve(__dirname, '..'));
  const hasEdge = (source, target, kind) => atlas.edges.some((edge) => edge.source_name === source && edge.target_name === target && edge.edge_kind === kind);

  assert.equal(hasEdge('components/CrmOrganizationDialog', 'find_crm_organization_candidates', 'calls'), true);
  assert.equal(hasEdge('components/CrmOrganizationDialog', 'manage_crm_organization', 'calls'), true);
  assert.equal(hasEdge('components/CrmSiteDialog', 'find_crm_site_candidates', 'calls'), true);
  assert.equal(hasEdge('components/CrmSiteDialog', 'create_crm_site', 'calls'), true);
  assert.equal(hasEdge('components/LocationHouseMap', 'propose_boundary', 'calls'), true);
  assert.equal(hasEdge('components/LocationHouseMap', 'accept_boundary_proposal', 'calls'), true);
  assert.equal(hasEdge('components/LocationHouseMap', 'verify_boundary', 'calls'), true);
  assert.equal(hasEdge('components/OperationalPlaceManager', 'get_location_patrol_checkpoints', 'calls'), true);
  assert.equal(hasEdge('components/OperationalPlaceManager', 'manage_location_patrol_checkpoint', 'calls'), true);
  // Location House uses the governed proposal path; there is no separate workbench or direct geometry writer.
  assert.equal(atlas.edges.some((edge) => edge.source_name === 'pages/SiteBoundaryReviewPage'), false);
  assert.equal(hasEdge('components/LocationHouseMap', 'manage_crm_site_boundary', 'calls'), false);
  assert.equal(hasEdge('components/LocationHouseMap', 'save_site_boundary', 'calls'), false);
  assert.equal(hasEdge('components/CrmAgreementSetupDialog', 'get_crm_agreement_setup', 'calls'), true);
  assert.equal(hasEdge('components/CrmAgreementSetupDialog', 'manage_crm_agreement_setup', 'calls'), true);
  assert.equal(hasEdge('components/CrmOperationalReadinessDialog', 'get_crm_enterprise_readiness', 'calls'), true);
  assert.equal(hasEdge('pages/AccountOnboardingPage', 'get_crm_onboarding_workspace', 'calls'), true);
  assert.equal(hasEdge('pages/AccountOnboardingPage', 'get_crm_onboarding_assignees', 'calls'), true);
  assert.equal(hasEdge('pages/AccountOnboardingPage', 'get_crm_onboarding_history', 'calls'), true);
  assert.equal(hasEdge('pages/AccountOnboardingPage', 'manage_crm_onboarding_workflow', 'calls'), true);
  assert.equal(hasEdge('pages/AccountOnboardingPage', 'activate_crm_account', 'calls'), true);
  assert.equal(hasEdge('pages/ActivationHandoffsPage', 'get_crm_activation_handoffs', 'calls'), true);
  assert.equal(hasEdge('pages/ActivationHandoffsPage', 'manage_crm_activation_handoff_task', 'calls'), true);
  assert.equal(hasEdge('components/LocationHouseMap', 'resolve_operational_context_authorized', 'calls'), true);
  assert.equal(hasEdge('components/LocationHouseMap', 'is_zone_closed', 'calls'), true);
  assert.equal(hasEdge('pages/LocationsPage', 'get_crm_operational_geography', 'calls'), true);
  assert.equal(hasEdge('pages/ZoneDetailPage', 'get_crm_operational_geography', 'calls'), true);
  assert.equal(hasEdge('components/OperationalPlaceManager', 'get_crm_operational_place_editor', 'calls'), true);
  assert.equal(hasEdge('components/OperationalPlaceManager', 'manage_crm_site_profile', 'calls'), true);
  assert.equal(hasEdge('components/OperationalPlaceManager', 'manage_crm_zone', 'calls'), true);
  assert.equal(hasEdge('components/OperationalPlaceManager', 'manage_crm_place_boundary', 'calls'), false);
  assert.equal(hasEdge('components/OperationalPlaceManager', 'manage_crm_zone_closure', 'calls'), true);
  assert.equal(hasEdge('get_crm_operational_geography', 'locations', 'reads'), true);
  assert.equal(hasEdge('get_crm_operational_geography', 'client_sites', 'reads'), true);
  assert.equal(hasEdge('get_crm_operational_geography', 'location_zones', 'reads'), true);
  assert.equal(hasEdge('get_crm_operational_geography', 'service_agreement_locations', 'reads'), true);
  assert.equal(hasEdge('components/OperationalPlaceManager', 'get_crm_operational_place_editor', 'calls'), true);
  assert.equal(hasEdge('components/OperationalPlaceManager', 'manage_crm_site_profile', 'calls'), true);
  assert.equal(hasEdge('components/OperationalPlaceManager', 'manage_crm_zone', 'calls'), true);
  assert.equal(hasEdge('components/OperationalPlaceManager', 'manage_crm_place_boundary', 'calls'), false);
  assert.equal(hasEdge('components/OperationalPlaceManager', 'manage_crm_zone_closure', 'calls'), true);
  assert.equal(hasEdge('manage_crm_site_profile', 'client_sites', 'writes'), true);
  assert.equal(hasEdge('manage_crm_zone', 'location_zones', 'writes'), true);
  assert.equal(hasEdge('manage_crm_place_boundary', 'geofence_boundary_history', 'writes'), true);
  assert.equal(hasEdge('manage_crm_zone_closure', 'zone_closures', 'writes'), true);
  assert.equal(hasEdge('manage_crm_site_profile', 'client_sites', 'writes'), true);
  assert.equal(hasEdge('manage_crm_zone', 'location_zones', 'writes'), true);
  assert.equal(hasEdge('manage_crm_place_boundary', 'client_sites', 'writes'), true);
  assert.equal(hasEdge('manage_crm_place_boundary', 'location_zones', 'writes'), true);
  assert.equal(hasEdge('manage_crm_zone_closure', 'zone_closures', 'writes'), true);
  assert.equal(hasEdge('pages/SiteDetailPage', 'get_crm_operational_geography', 'calls'), true);
  assert.equal(hasEdge('pages/ZoneDetailPage', 'zone_closures', 'reads'), true);
  assert.equal(hasEdge('pages/ZoneDetailPage', 'get_boundary_history', 'calls'), true);
  assert.equal(hasEdge('pages/CRMPage', 'get_crm_organization_readiness', 'calls'), true);
  assert.equal(hasEdge('manage_crm_organization', 'organizations', 'reads'), true);
  assert.equal(hasEdge('manage_crm_organization', 'organizations', 'writes'), true);
  assert.equal(hasEdge('manage_crm_organization', 'audit_log', 'writes'), true);
  assert.equal(hasEdge('get_crm_organization_readiness', 'crm_contacts', 'reads'), true);
  assert.equal(hasEdge('pages/OrganizationSetupPage', 'update_operating_branch_profile', 'calls'), true);
  assert.equal(hasEdge('update_operating_branch_profile', 'organizations', 'writes'), true);
  assert.equal(hasEdge('update_operating_branch_profile', 'audit_log', 'writes'), true);
  assert.equal(hasEdge('find_crm_site_candidates', 'client_sites', 'reads'), true);
  assert.equal(hasEdge('create_crm_site', 'client_sites', 'writes'), true);
  assert.equal(hasEdge('create_crm_site', 'audit_log', 'writes'), true);
  assert.equal(hasEdge('get_crm_site_boundary_queue', 'client_sites', 'reads'), true);
  assert.equal(hasEdge('get_crm_site_boundary_queue', 'organizations', 'reads'), true);
  assert.equal(hasEdge('get_boundary_history', 'client_sites', 'reads'), true);
  assert.equal(hasEdge('get_boundary_history', 'location_zones', 'reads'), true);
  assert.equal(hasEdge('get_boundary_history', 'geofence_boundary_history', 'reads'), true);
  assert.equal(hasEdge('manage_crm_site_boundary', 'client_sites', 'writes'), true);
  assert.equal(hasEdge('manage_crm_site_boundary', 'audit_log', 'writes'), true);
  assert.equal(hasEdge('get_crm_agreement_setup', 'service_agreement_locations', 'reads'), true);
  assert.equal(hasEdge('get_crm_agreement_setup', 'service_agreement_modules', 'reads'), true);
  assert.equal(hasEdge('manage_crm_agreement_setup', 'service_agreement_locations', 'writes'), true);
  assert.equal(hasEdge('manage_crm_agreement_setup', 'service_agreement_modules', 'writes'), true);
  assert.equal(hasEdge('manage_crm_agreement_setup', 'service_agreements', 'writes'), true);
  assert.equal(hasEdge('manage_crm_agreement_setup', 'audit_log', 'writes'), true);
  assert.equal(hasEdge('get_crm_operational_readiness', 'service_agreement_locations', 'reads'), true);
  assert.equal(hasEdge('get_crm_operational_readiness', 'crm_commercial_settings', 'reads'), true);
  assert.equal(hasEdge('get_crm_operational_readiness', 'site_financial_config', 'reads'), true);
  assert.equal(hasEdge('get_crm_operational_readiness', 'roster_work_units', 'reads'), true);
  assert.equal(hasEdge('get_crm_operational_readiness', 'report_templates', 'reads'), true);
  assert.equal(hasEdge('get_crm_onboarding_workspace', 'crm_onboarding_ledgers', 'reads'), true);
  assert.equal(hasEdge('get_crm_onboarding_assignees', 'user_profiles', 'reads'), true);
  assert.equal(hasEdge('get_crm_onboarding_history', 'crm_onboarding_events', 'reads'), true);
  assert.equal(hasEdge('manage_crm_onboarding_workflow', 'crm_onboarding_ledgers', 'writes'), true);
  assert.equal(hasEdge('manage_crm_onboarding_workflow', 'crm_onboarding_events', 'writes'), true);
  assert.equal(hasEdge('crm_onboarding_ledgers', 'seed_crm_activation_handoff', 'triggers'), true);
  assert.equal(hasEdge('seed_crm_activation_handoff', 'crm_activation_handoffs', 'writes'), true);
  assert.equal(hasEdge('seed_crm_activation_handoff', 'crm_activation_handoff_tasks', 'writes'), true);
  assert.equal(hasEdge('get_crm_activation_handoffs', 'client_sites', 'reads'), true);
  assert.equal(hasEdge('get_crm_activation_handoffs', 'roster_work_units', 'reads'), true);
  assert.equal(hasEdge('get_crm_activation_handoffs', 'roster_slots', 'reads'), true);
  assert.equal(hasEdge('manage_crm_activation_handoff_task', 'crm_activation_handoff_tasks', 'writes'), true);
  assert.equal(hasEdge('manage_crm_activation_handoff_task', 'crm_activation_handoffs', 'writes'), true);
  assert.equal(hasEdge('seed_aam_e2e_dataset', 'organizations', 'writes'), true);
  assert.equal(hasEdge('seed_aam_e2e_dataset', 'service_agreement_modules', 'writes'), true);
  assert.equal(hasEdge('seed_aam_e2e_dataset', 'location_zones', 'writes'), true);
  assert.equal(hasEdge('seed_aam_e2e_dataset', 'shift_templates', 'writes'), true);
  assert.equal(hasEdge('purge_aam_e2e_dataset', 'organizations', 'writes'), true);
  assert.equal(hasEdge('activate_crm_account', 'organizations', 'writes'), true);
  assert.equal(hasEdge('activate_crm_account', 'crm_onboarding_ledgers', 'writes'), true);
  assert.equal(hasEdge('activate_crm_account', 'audit_log', 'writes'), true);
  assert.equal(hasEdge('resolve_context', 'organizations', 'reads'), true);
  assert.equal(hasEdge('resolve_context', 'location_zones', 'reads'), true);
  assert.equal(hasEdge('resolve_context', 'client_sites', 'reads'), true);
  assert.equal(hasEdge('resolve_context', 'locations', 'reads'), true);
  assert.equal(hasEdge('process-officer-scan', 'resolve_operational_context_authorized', 'calls'), true);
  assert.equal(hasEdge('process-officer-scan', 'has_location_access', 'calls'), true);
  assert.equal(hasEdge('resolve_operational_context', 'resolve_context', 'calls'), true);
  assert.equal(hasEdge('process-officer-scan', 'is_zone_closed', 'calls'), true);
  assert.equal(hasEdge('process-officer-scan', '_geofence_active_at', 'calls'), true);
  assert.equal(hasEdge('process-officer-scan', 'parking_chalk_records', 'writes'), true);
  assert.equal(hasEdge('process-officer-scan', 'observations', 'writes'), true);
  assert.equal(hasEdge('resolve-point-context', 'user_profiles', 'reads'), true);
  assert.equal(hasEdge('resolve-point-context', 'resolve_context', 'calls'), true);
  assert.equal(hasEdge('resolve-point-context', 'resolve_verified_site_context', 'calls'), true);
  assert.equal(hasEdge('resolve-point-context', 'service_agreements', 'reads'), true);
  assert.equal(hasEdge('resolve-point-context', 'client_sites', 'reads'), true);
  assert.equal(hasEdge('resolve-point-context', 'location_zones', 'reads'), true);
  assert.equal(hasEdge('resolve_verified_site_context', 'client_sites', 'reads'), true);
  assert.equal(hasEdge('resolve_context_authorized', 'resolve_context', 'calls'), true);
  assert.equal(hasEdge('observations', 'preserve_scan_geofence_context', 'triggers'), true);
  assert.equal(hasEdge('parking_chalk_records', 'preserve_scan_geofence_context', 'triggers'), true);
  assert.equal(hasEdge('is_zone_closed', 'zone_closures', 'reads'), true);
  assert.equal(atlas.edges.some((edge) => edge.source_name === 'components/CrmOrganizationDialog' && edge.edge_kind === 'writes'), false);
});

test('managed Atlas includes governed document classification review writes', () => {
  const atlas = collectManagedAtlas(path.resolve(__dirname, '..'));
  const hasEdge = (source, target, kind) => atlas.edges.some((edge) => edge.source_name === source && edge.target_name === target && edge.edge_kind === kind);
  assert.equal(hasEdge('review_document_classification', 'document_classifications', 'writes'), true);
  assert.equal(hasEdge('review_document_classification', 'audit_log', 'writes'), true);
});

test('managed Atlas includes domain document promotion proposals', () => {
  const atlas = collectManagedAtlas(path.resolve(__dirname, '..'));
  const hasEdge = (source, target, kind) => atlas.edges.some((edge) => edge.source_name === source && edge.target_name === target && edge.edge_kind === kind);
  assert.equal(hasEdge('propose_document_promotion', 'document_promotion_proposals', 'writes'), true);
  assert.equal(hasEdge('propose_document_promotion', 'audit_log', 'writes'), true);
});

test('managed Atlas includes domain promotion proposal review writes', () => {
  const atlas = collectManagedAtlas(path.resolve(__dirname, '..'));
  const hasEdge = (source, target, kind) => atlas.edges.some((edge) => edge.source_name === source && edge.target_name === target && edge.edge_kind === kind);
  assert.equal(hasEdge('review_document_promotion_proposal', 'document_promotion_proposals', 'writes'), true);
  assert.equal(hasEdge('review_document_promotion_proposal', 'audit_log', 'writes'), true);
});

test('managed Atlas includes explicit CRM agreement proposal application writes', () => {
  const atlas = collectManagedAtlas(path.resolve(__dirname, '..'));
  const hasEdge = (source, target, kind) => atlas.edges.some((edge) => edge.source_name === source && edge.target_name === target && edge.edge_kind === kind);
  assert.equal(hasEdge('apply_crm_agreement_promotion_proposal', 'service_agreements', 'writes'), true);
  assert.equal(hasEdge('apply_crm_agreement_promotion_proposal', 'document_promotion_proposals', 'writes'), true);
  assert.equal(hasEdge('apply_crm_agreement_promotion_proposal', 'audit_log', 'writes'), true);
});

test('managed Atlas includes explicit credential proposal application writes', () => {
  const atlas = collectManagedAtlas(path.resolve(__dirname, '..'));
  const hasEdge = (source, target, kind) => atlas.edges.some((edge) => edge.source_name === source && edge.target_name === target && edge.edge_kind === kind);
  assert.equal(hasEdge('apply_credential_promotion_proposal', 'staff_credentials', 'writes'), true);
  assert.equal(hasEdge('apply_credential_promotion_proposal', 'document_promotion_proposals', 'writes'), true);
  assert.equal(hasEdge('apply_credential_promotion_proposal', 'audit_log', 'writes'), true);
});

test('managed Atlas includes explicit finance proposal application writes', () => {
  const atlas = collectManagedAtlas(path.resolve(__dirname, '..'));
  const hasEdge = (source, target, kind) => atlas.edges.some((edge) => edge.source_name === source && edge.target_name === target && edge.edge_kind === kind);
  assert.equal(hasEdge('apply_finance_reconciliation_proposal', 'invoices', 'writes'), true);
  assert.equal(hasEdge('apply_finance_reconciliation_proposal', 'document_promotion_proposals', 'writes'), true);
  assert.equal(hasEdge('apply_finance_reconciliation_proposal', 'audit_log', 'writes'), true);
});

test('managed Atlas includes explicit HR document proposal application writes', () => {
  const atlas = collectManagedAtlas(path.resolve(__dirname, '..'));
  const hasEdge = (source, target, kind) => atlas.edges.some((edge) => edge.source_name === source && edge.target_name === target && edge.edge_kind === kind);
  assert.equal(hasEdge('apply_hr_document_promotion_proposal', 'staff_documents', 'writes'), true);
  assert.equal(hasEdge('apply_hr_document_promotion_proposal', 'document_promotion_proposals', 'writes'), true);
  assert.equal(hasEdge('apply_hr_document_promotion_proposal', 'audit_log', 'writes'), true);
});

test('managed Atlas includes explicit site brief proposal application writes', () => {
  const atlas = collectManagedAtlas(path.resolve(__dirname, '..'));
  const hasEdge = (source, target, kind) => atlas.edges.some((edge) => edge.source_name === source && edge.target_name === target && edge.edge_kind === kind);
  assert.equal(hasEdge('apply_site_brief_promotion_proposal', 'create_roster_work_unit', 'calls'), true);
  assert.equal(hasEdge('apply_site_brief_promotion_proposal', 'document_promotion_proposals', 'writes'), true);
  assert.equal(hasEdge('apply_site_brief_promotion_proposal', 'audit_log', 'writes'), true);
});

test('managed Atlas includes explicit investigation link proposal application writes', () => {
  const atlas = collectManagedAtlas(path.resolve(__dirname, '..'));
  const hasEdge = (source, target, kind) => atlas.edges.some((edge) => edge.source_name === source && edge.target_name === target && edge.edge_kind === kind);
  assert.equal(hasEdge('apply_investigation_link_promotion_proposal', 'link_investigation_entity', 'calls'), true);
  assert.equal(hasEdge('apply_investigation_link_promotion_proposal', 'document_promotion_proposals', 'writes'), true);
  assert.equal(hasEdge('apply_investigation_link_promotion_proposal', 'audit_log', 'writes'), true);
});

test('managed user spine routes identity and access through governed RPCs', () => {
  const atlas = collectManagedAtlas(path.resolve(__dirname, '..'));
  const hasEdge = (source, target, kind) => atlas.edges.some((edge) => edge.source_name === source && edge.target_name === target && edge.edge_kind === kind);

  assert.equal(hasEdge('pages/UserManagementPage', 'get_user_spine_readiness', 'calls'), true);
  assert.equal(hasEdge('components/UserIdentityWorkspace', 'manage_user_identity_access', 'calls'), true);
  assert.equal(hasEdge('pages/AccessControlPage', 'grant_branch_area_access', 'calls'), true);
  assert.equal(hasEdge('manage_user_identity_access', 'user_profiles', 'writes'), true);
  assert.equal(hasEdge('manage_user_identity_access', 'preset_assignments', 'writes'), true);
  assert.equal(hasEdge('manage_user_identity_access', 'staff_area_grants', 'writes'), true);
  assert.equal(hasEdge('log_user_management_action', 'user_management_audit', 'writes'), true);
  assert.equal(hasEdge('get_user_spine_readiness', 'staff_profiles', 'reads'), true);
  assert.equal(hasEdge('get_user_spine_readiness', 'staff_credentials', 'reads'), true);
  assert.equal(atlas.edges.some((edge) => ['components/UserIdentityWorkspace', 'pages/UserManagementPage', 'pages/AccessControlPage'].includes(edge.source_name) && ['user_profiles', 'preset_assignments', 'staff_area_grants'].includes(edge.target_name) && edge.edge_kind === 'writes'), false);
});

test('managed Atlas maps the staff profile to its private HR records and governed writes', () => {
  const atlas = collectManagedAtlas(path.resolve(__dirname, '..'));
  const hasEdge = (source, target, kind) => atlas.edges.some((edge) => edge.source_name === source && edge.target_name === target && edge.edge_kind === kind);

  assert.equal(hasEdge('pages/StaffProfilePage', 'staff_profiles', 'reads'), true);
  assert.equal(hasEdge('pages/StaffProfilePage', 'staff_documents', 'reads'), true);
  assert.equal(hasEdge('pages/StaffProfilePage', 'manage_user_identity_access', 'calls'), true);
  assert.equal(hasEdge('pages/StaffProfilePage', 'set_staff_employment_setup', 'calls'), true);
  assert.equal(hasEdge('pages/StaffProfilePage', 'record_staff_document_upload', 'calls'), true);
});

test('Atlas refresh preserves manual and unmarked generator rows', () => {
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
      id: 'managed-pre-marker', source_type: 'component', source_name: 'pages/UserManagementPage', target_type: 'table',
      target_name: 'user_profiles', edge_kind: 'writes', source_file: 'apps/web/src/pages/UserManagementPage.tsx',
      refresh_source: 'ci_generator', caller_context: ".from('user_profiles').insert/update/upsert/delete"
    },
    {
      id: 'unmanaged-pre-marker', source_type: 'component', source_name: 'pages/Unmanaged', target_type: 'table',
      target_name: 'user_profiles', edge_kind: 'writes', source_file: 'apps/web/src/pages/Unmanaged.tsx',
      refresh_source: 'ci_generator', caller_context: ".from('user_profiles').insert/update/upsert/delete"
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
  assert.equal(plan.edgeRetireIds.includes('legacy-generator'), false);
  assert.equal(plan.edgeRetireIds.includes('managed-pre-marker'), false);
  assert.equal(plan.edgeRetireIds.includes('unmanaged-pre-marker'), false);
});

test('Atlas refresh retains generated column inventory until column derivation is available', () => {
  const plan = buildRefreshPlan({ capabilities: [], edges: [] }, [{
    id: 'generated-column', entity_type: 'column', entity_name: 'observations.locked_at',
    refresh_source: 'ci_generator', retirement_status: 'live'
  }], []);

  assert.deepEqual(plan.capabilityRetireIds, []);
});

test('Atlas retirement applies to plan-selected manual records', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../scripts/atlas-refresh.js'), 'utf8');
  assert.doesNotMatch(source, /id=in\.\(\$\{filter\}\)&refresh_source=eq\.ci_generator/);
});

test('Atlas refresh retires owned edges when their source is deleted', () => {
  const manifest = {
    repository_files: ['apps/web/src/pages/CurrentPage.tsx'],
    capabilities: [],
    edges: []
  };
  const existingEdges = [
    {
      id: 'deleted-source', source_type: 'component', source_name: 'pages/DeletedPage',
      target_type: 'table', target_name: 'incidents', edge_kind: 'writes',
      source_file: 'apps/web/src/pages/DeletedPage.tsx', refresh_source: 'ci_generator',
      caller_context: `${OWNER_MARKER} .from('incidents').insert({})`, retirement_status: 'live'
    },
    {
      id: 'current-source', source_type: 'component', source_name: 'pages/CurrentPage',
      target_type: 'table', target_name: 'incidents', edge_kind: 'reads',
      source_file: 'apps/web/src/pages/CurrentPage.tsx', refresh_source: 'ci_generator',
      caller_context: ".from('incidents')", retirement_status: 'live'
    },
    {
      id: 'manual-deleted-source', source_type: 'component', source_name: 'pages/DeletedPage',
      target_type: 'table', target_name: 'incidents', edge_kind: 'reads',
      source_file: 'apps/web/src/pages/DeletedPage.tsx', refresh_source: 'manual_seed',
      caller_context: 'manually verified', retirement_status: 'live'
    }
  ];

  const plan = buildRefreshPlan(manifest, [], existingEdges);

  assert.deepEqual(plan.edgeRetireIds, ['deleted-source']);
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

test('Atlas refresh replaces stale caller context with the current derived context', () => {
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

  assert.equal(plan.edgeUpserts.length, 1);
  assert.equal(plan.edgeRetireIds.length, 0);
});

test('Atlas refresh is exposed as a post-test CI command', () => {
  const root = path.resolve(__dirname, '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  // Gitea CI: the host-side bridge refreshes Atlas only after Gitea main's verification passes, so the
  // service-role key never enters a workflow that a mirrored branch could rewrite.
  const bridge = fs.readFileSync(path.join(root, 'deploy/gitea-ci/fcm-gitea-ci-bridge.mjs'), 'utf8');
  const giteaWorkflow = fs.readFileSync(path.join(root, '.gitea/workflows/verify.yml'), 'utf8');

  assert.equal(packageJson.scripts['bob:refresh-capability-map'], 'npm run atlas:refresh');
  assert.match(packageJson.scripts['atlas:check'], /atlas:manifest/);
  assert.match(bridge, /mainPassed\(jobStates\(statuses\)\)/);
  assert.match(bridge, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(bridge, /node scripts\/atlas-refresh\.js --apply/);
  assert.doesNotMatch(giteaWorkflow, /SUPABASE_SERVICE_ROLE_KEY/);
  const refreshSource = fs.readFileSync(path.join(root, 'scripts/atlas-refresh.js'), 'utf8');
  assert.match(refreshSource, /source_file,migration_name,caller_context/);
  assert.match(refreshSource, /args\.has\('--upsert-only'\)/);
});

test('managed Atlas refresh derives governed component and RPC flow edges', () => {
  const atlas = collectManagedAtlas(path.resolve(__dirname, '..'));
  const hasEdge = (source, target, kind) => atlas.edges.some(edge => (
    edge.source_name === source && edge.target_name === target && edge.edge_kind === kind
  ));
  assert.equal(atlas.scope, 'managed_app');
  assert.equal(hasEdge('pages/RosterOperationsPage', 'roster_slots', 'reads'), true);
  assert.equal(hasEdge('pages/RosterOperationsPage', 'reassign_roster_slot', 'calls'), true);
  assert.equal(hasEdge('reassign_roster_slot', 'roster_slots', 'writes'), true);
  assert.equal(hasEdge('manage_roster_slot', 'materialize_roster_slot', 'calls'), true);
  assert.equal(hasEdge('pages/CRMPage', 'create_crm_draft_quote_for_provider', 'calls'), true);
  assert.equal(hasEdge('manage_welfare_alert', 'welfare_alerts', 'writes'), true);
  assert.equal(hasEdge('submit_officer_field_report', 'officer_field_reports', 'writes'), true);
  assert.equal(hasEdge('submit_officer_field_report', 'audit_log', 'writes'), true);
  assert.equal(atlas.edges.some((edge) => edge.source_name === 'pages/OfficerFieldReportPage' && edge.target_name === 'officer_field_reports' && edge.edge_kind === 'writes'), false);
  assert.equal(hasEdge('pages/CRMPage', 'invoices', 'reads'), true);
  assert.equal(hasEdge('pages/CRMPage', 'manage_crm_invoice', 'calls'), true);
  assert.equal(hasEdge('components/CrmAccountWorkspace', 'crm_contacts', 'reads'), true);
  assert.equal(hasEdge('components/CrmAccountWorkspace', 'crm_account_activities', 'reads'), true);
  assert.equal(hasEdge('components/CrmAccountWorkspace', 'manage_crm_contact', 'calls'), true);
  assert.equal(hasEdge('components/CrmAccountWorkspace', 'create_crm_account_activity', 'calls'), true);
  assert.equal(hasEdge('manage_crm_contact', 'crm_contacts', 'writes'), true);
  assert.equal(hasEdge('create_crm_account_activity', 'crm_account_activities', 'writes'), true);
  assert.equal(hasEdge('manage_crm_invoice', 'invoices', 'writes'), true);
  assert.equal(hasEdge('manage_crm_invoice', 'audit_log', 'writes'), true);
  assert.equal(hasEdge('scripts/seed-rm-forestry-roster-history', 'apply_historical_roster_assignment_import', 'calls'), true);
  assert.equal(hasEdge('apply_historical_roster_assignment_import', 'roster_assignments', 'writes'), true);
});

test('managed Atlas refresh includes capability nodes without inferring exercise', () => {
  const atlas = collectManagedAtlas(path.resolve(__dirname, '..'));
  assert.ok(atlas.nodes.some(node => node.entity_type === 'table' && node.entity_name === 'roster_slots'));
  assert.ok(atlas.nodes.some(node => node.entity_type === 'rpc' && node.entity_name === 'reassign_roster_slot'));
  assert.equal(atlas.nodes.some(node => Object.hasOwn(node, 'exercised')), false);
});

test('component extraction tolerates formatted multiline Supabase chains', () => {
  const edges = collectComponentEdges('apps/web/src/pages/ExamplePage.tsx', `
    const rows = supabase
      .from('crm_contacts')
      .select('*');
    await supabase
      .rpc('create_crm_draft_quote', { p_title: 'Example' });
    await supabase
      .from('welfare_alerts')
      .insert({ status: 'pending' });
  `);
  assert.ok(edges.some(edge => edge.target_name === 'crm_contacts' && edge.edge_kind === 'reads'));
  assert.ok(edges.some(edge => edge.target_name === 'create_crm_draft_quote' && edge.edge_kind === 'calls'));
  assert.ok(edges.some(edge => edge.target_name === 'welfare_alerts' && edge.edge_kind === 'writes'));
});

test('component extraction records multiline conditional RPC targets', () => {
  const edges = collectComponentEdges('apps/web/src/components/IdentityRecordsWorkspace.tsx', `
    const result = await supabase.rpc(
      selectedDocument.document_kind === "nzta_mvr_record"
        ? "review_nzta_mvr_identity_evidence"
        : "review_canonical_identity_evidence",
      { p_identity_document_id: selectedDocument.id },
    );
  `, {
    rpcs: new Set(['review_nzta_mvr_identity_evidence', 'review_canonical_identity_evidence']),
    tables: new Set(),
    edgeFunctions: new Set(),
  });

  assert.deepEqual(
    edges
      .filter((edge) => edge.target_type === 'rpc')
      .map((edge) => edge.target_name)
      .sort(),
    ['review_canonical_identity_evidence', 'review_nzta_mvr_identity_evidence'],
  );
});

test('stale edge compatibility helper retires only marker-owned live CI identities', () => {
  const base = { source_type: 'component', source_name: 'pages/CRMPage', target_type: 'table', source_file: 'apps/web/src/pages/CRMPage.tsx', retirement_status: 'live' };
  const existing = [
    { ...base, id: 'keep', target_name: 'quotes', edge_kind: 'reads', refresh_source: 'ci_generator', caller_context: `${OWNER_MARKER} read` },
    { ...base, id: 'stale', target_name: 'quote_lines', edge_kind: 'writes', refresh_source: 'ci_generator', caller_context: `${OWNER_MARKER} write` },
    { ...base, id: 'unmarked', target_name: 'invoice_lines', edge_kind: 'writes', refresh_source: 'ci_generator', caller_context: ".from('invoice_lines').insert({})" },
    { ...base, id: 'manual', target_name: 'quote_lines', edge_kind: 'writes', refresh_source: 'manual_seed' }
  ];
  const generated = [{ ...base, target_name: 'quotes', edge_kind: 'reads' }];
  assert.deepEqual(staleGeneratedEdgeIds(existing, generated), ['stale']);
});

test('component extraction recognizes governed Management API SQL RPC calls', () => {
  const inventory = { rpcs: new Set(['project_historical_patrol_roster', 'stage_patrol_finance_cost_rows']) };
  const edges = collectComponentEdges('scripts/seed-historical-patrol-roster.mjs', `
    const query = \`SELECT public.project_historical_patrol_roster($1);\`;
    const staged = \`DO $$
      DECLARE v_stage jsonb;
      BEGIN
        v_stage := public.stage_patrol_finance_cost_rows($1, $2, $3, $4, $5);
      END $$;\`;
  `, inventory);
  assert.ok(edges.some(edge => edge.target_name === 'project_historical_patrol_roster' && edge.edge_kind === 'calls'));
  assert.ok(edges.some(edge => edge.target_name === 'stage_patrol_finance_cost_rows' && edge.edge_kind === 'calls'));
});
test('an RPC called through a const bound to literal names is a real call edge, not an unwired gap', () => {
  const edges = collectComponentEdges('supabase/functions/bob-sql-read/index.ts', `
    const rpcClient = isAdmiral ? admin : callerClient;
    const rpcName = isAdmiral ? 'bob_execute_read_query' : 'bob_execute_read_query_scoped';
    const { data, error } = await rpcClient.rpc(rpcName, { query_text: q });
    const label = 'not_an_rpc';
  `, { rpcs: new Set(['bob_execute_read_query', 'bob_execute_read_query_scoped']) });
  const rpcTargets = edges.filter((edge) => edge.target_type === 'rpc').map((edge) => edge.target_name).sort();
  assert.deepEqual(rpcTargets, ['bob_execute_read_query', 'bob_execute_read_query_scoped']);
});
