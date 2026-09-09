import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const supabaseUrl = process.env.SUPABASE_URL || 'https://dotczcyyzgabmtmnglqj.supabase.co';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const schemaPath = resolve(process.cwd(), '../../supabase/schema.sql');
const migrationPath = resolve(process.cwd(), '../../supabase/migrations/20260909100000_dispatch_operator_controls.sql');
const callerPath = resolve(process.cwd(), 'src/pages/DispatchConsolePage.tsx');

interface CapabilityRow {
  entity_type: string;
  entity_name: string;
  present: boolean;
  wired: boolean;
  exercised: boolean;
}

interface EdgeRow {
  source_type: string;
  source_name: string;
  target_type: string;
  target_name: string;
  edge_kind: string;
}

function readLocalFile(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function atlasGet<T>(path: string): Promise<T[]> {
  if (!serviceRoleKey) return [];
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
  });
  if (!response.ok) {
    console.log(`ATLAS READ FAILED ${response.status}: ${path}`);
    return [];
  }
  return response.json() as Promise<T[]>;
}

test("Bob's directed Atlas + schema diagnosis", async () => {
  const schema = readLocalFile(schemaPath);
  const migration = readLocalFile(migrationPath);
  const caller = readLocalFile(callerPath);
  const capabilities = await atlasGet<CapabilityRow>(
    'bob_capability_map?select=entity_type,entity_name,present,wired,exercised&entity_name=ilike.*dispatch*'
  );
  const edges = await atlasGet<EdgeRow>(
    'bob_app_map_edges?select=source_type,source_name,target_type,target_name,edge_kind&or=(source_name.ilike.*dispatch*,target_name.ilike.*dispatch*)&retirement_status=eq.live'
  );

  const migrationDefinesRpc = migration.includes('CREATE OR REPLACE FUNCTION public.manage_dispatch_job(');
  const schemaDefinesRpc = schema.includes('manage_dispatch_job');
  const callerPassesFullContract = [
    'p_job_id', 'p_expected_status', 'p_action', 'p_priority',
    'p_briefing_notes', 'p_dispatch_resource_id', 'p_reason',
  ].every((parameter) => caller.includes(parameter));
  const rpcCapability = capabilities.find((row) => row.entity_name.includes('manage_dispatch_job'));
  const rpcEdges = edges.filter((edge) => edge.source_name.includes('DispatchConsolePage') || edge.target_name.includes('manage_dispatch_job'));

  console.log('\n=== BOB DIRECTIVE: ATLAS + SCHEMA + NEXT MOVE ===');
  console.log('Question: Can the dispatch RPC failure be explained by the code, schema, or deployment terrain?');
  console.log('\n1. Schema truth');
  console.log(`  Migration defines manage_dispatch_job: ${migrationDefinesRpc ? 'YES' : 'NO'}`);
  console.log(`  schema.sql contains manage_dispatch_job: ${schemaDefinesRpc ? 'YES' : 'NO'}`);
  console.log(`  Frontend passes the full named contract: ${callerPassesFullContract ? 'YES' : 'NO'}`);
  console.log('\n2. Atlas terrain');
  console.log(`  Dispatch capability rows: ${capabilities.length}`);
  capabilities.slice(0, 12).forEach((row) => console.log(`  - ${row.entity_type}:${row.entity_name} present=${row.present} wired=${row.wired} exercised=${row.exercised}`));
  console.log(`  Dispatch edges: ${edges.length}; RPC-specific edges: ${rpcEdges.length}`);
  rpcEdges.slice(0, 12).forEach((edge) => console.log(`  - ${edge.source_name} --${edge.edge_kind}--> ${edge.target_name}`));
  console.log('\n3. Bob must choose the next move');

  if (migrationDefinesRpc && !schemaDefinesRpc) {
    console.log('  FINDING: Migration/schema snapshot drift. Do not claim the RPC is absent from production yet.');
    console.log('  NEXT: verify pg_proc on the target Supabase project, verify supabase_migrations.schema_migrations, then deploy/repair the migration or regenerate schema.sql.');
  } else if (!callerPassesFullContract) {
    console.log('  FINDING: Frontend RPC payload is stale or incomplete.');
    console.log('  NEXT: pass every named RPC parameter, then rerun the dispatch human walkthrough.');
  } else if (rpcCapability && (!rpcCapability.wired || !rpcCapability.exercised)) {
    console.log('  FINDING: RPC exists in Atlas but is not proven wired/exercised.');
    console.log('  NEXT: inspect real caller edges, exercise the button once in a controlled environment, then refresh Atlas.');
  } else {
    console.log('  FINDING: No single local contradiction.');
    console.log('  NEXT: query live pg_proc signature and PostgREST OpenAPI/schema cache, then compare the deployed frontend asset commit.');
  }

  console.log('\n4. Safety rules');
  console.log('  - Atlas references are not proof of a live read/write/call.');
  console.log('  - FK reach is not flow reach.');
  console.log('  - Never hand-edit Atlas edges to make the result look wired.');
  console.log('  - After a real fix, exercise the path, then run the scoped Atlas refresh.');

  expect(migrationDefinesRpc).toBe(true);
  expect(callerPassesFullContract).toBe(true);
});
