import { expect, test } from '@playwright/test';

/**
 * Bob's Atlas Integration Test
 * 
 * This test combines manual walkthrough observations with queries to Bob's
 * capability map (bob_capability_map and bob_app_map_edges) to diagnose
 * whether missing fields are due to:
 * 1. Entity not present in capability map at all
 * 2. Entity present but not wired (no callers/edges)
 * 3. Entity wired but not exercised (edges exist but never run)
 * 4. RLS policy missing or broken
 * 5. Data writer function/trigger missing or failing
 * 
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Queries: bob_capability_map, bob_app_map_edges, bob_atlas_flow_reach RPC
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dotczcyyzgabmtmnglqj.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

interface CapabilityMapRow {
  entity_type: string;
  entity_name: string;
  present: boolean;
  wired: boolean;
  exercised: boolean;
  last_exercised_at?: string;
}

interface EdgeRow {
  source_type: string;
  source_name: string;
  target_type: string;
  target_name: string;
  edge_kind: string;
}

async function queryAtlas<T>(query: string, params?: Record<string, unknown>): Promise<T[]> {
  if (!SERVICE_ROLE_KEY) {
    console.log('⚠ SUPABASE_SERVICE_ROLE_KEY not set — Atlas queries disabled');
    return [];
  }

  const url = new URL(`${SUPABASE_URL}/rest/v1/rpc/bob_query_atlas`);
  
  try {
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'apikey': SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_query: query,
        p_params: params || {},
      }),
    });

    if (!response.ok) {
      console.log(`⚠ Atlas query failed: ${response.status} ${response.statusText}`);
      return [];
    }

    const data = await response.json();
    return data || [];
  } catch (err) {
    console.log(`⚠ Atlas query error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function queryCapabilityMap(entityName: string): Promise<CapabilityMapRow[]> {
  if (!SERVICE_ROLE_KEY) return [];

  const url = `${SUPABASE_URL}/rest/v1/bob_capability_map?select=entity_type,entity_name,present,wired,exercised,last_exercised_at&entity_name=ilike.%${entityName}%`;

  try {
    const response = await fetch(url, {
      headers: {
        'apikey': SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      },
    });

    if (response.ok) {
      return await response.json();
    }
  } catch (err) {
    console.log(`⚠ Capability map query error: ${err instanceof Error ? err.message : String(err)}`);
  }

  return [];
}

async function queryEdges(entityName: string): Promise<EdgeRow[]> {
  if (!SERVICE_ROLE_KEY) return [];

  const url = `${SUPABASE_URL}/rest/v1/bob_app_map_edges?select=source_type,source_name,target_type,target_name,edge_kind&or=(source_name.eq.${entityName},target_name.eq.${entityName})&retirement_status=eq.live`;

  try {
    const response = await fetch(url, {
      headers: {
        'apikey': SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      },
    });

    if (response.ok) {
      return await response.json();
    }
  } catch (err) {
    console.log(`⚠ Edges query error: ${err instanceof Error ? err.message : String(err)}`);
  }

  return [];
}

test.describe("Bob's Atlas — Entity Wiring & Gap Diagnosis", () => {
  test('Atlas Connection Test', async () => {
    console.log('\n' + '='.repeat(80));
    console.log("BOB'S ATLAS INTEGRATION TEST");
    console.log('='.repeat(80));
    console.log(`\nAtlas Base URL: ${SUPABASE_URL}`);
    console.log(`Service Role Key: ${SERVICE_ROLE_KEY ? '✓ present' : '✗ missing'}`);

    if (!SERVICE_ROLE_KEY) {
      console.log(
        '\n⚠⚠⚠ Cannot run Atlas queries without SUPABASE_SERVICE_ROLE_KEY'
      );
      return;
    }

    console.log('\n✓ Ready to diagnose entity wiring\n');
  });

  test('AUDIT: welfare_alerts.resolved_by field', async () => {
    console.log('\n--- AUDITING: welfare_alerts.resolved_by ---');
    console.log(
      'User Report: Resolver field appears NULL in alert detail page'
    );

    // Check if column exists
    const column = await queryCapabilityMap('welfare_alerts.resolved_by');
    console.log(`\n1️⃣ Entity Check:`);
    if (column.length > 0) {
      const row = column[0];
      console.log(`   ✓ Column exists in capability map`);
      console.log(`   - Present: ${row.present}`);
      console.log(`   - Wired: ${row.wired}`);
      console.log(`   - Exercised: ${row.exercised}`);
      if (row.last_exercised_at) {
        console.log(`   - Last run: ${row.last_exercised_at}`);
      }

      if (!row.exercised) {
        console.log(
          `   ⚠⚠⚠ GAP CONFIRMED: Column wired but never exercised — no UPDATE happening`
        );
      }
    } else {
      console.log(
        `   ⚠ Column not in capability map — may not be tracked or not present`
      );
    }

    // Check for data writers
    console.log(`\n2️⃣ Data Writer Check:`);
    const writers = await queryEdges('welfare_alerts');
    const updateEdges = writers.filter(
      (e) =>
        e.target_name === 'welfare_alerts' &&
        (e.edge_kind === 'writes' || e.edge_kind === 'fk_references')
    );

    if (updateEdges.length > 0) {
      console.log(
        `   ✓ Found ${updateEdges.length} potential writer(s):`
      );
      updateEdges.forEach((edge) => {
        console.log(
          `     - ${edge.source_type}: ${edge.source_name} [${edge.edge_kind}]`
        );
      });
    } else {
      console.log(
        `   ⚠⚠⚠ NO WRITERS FOUND — resolved_by will always be NULL (Gap 3)`
      );
    }

    // Diagnosis
    console.log(`\n3️⃣ Diagnosis:`);
    if (updateEdges.length === 0) {
      console.log(
        `   PRIMARY CAUSE: No Edge Function or RPC writes welfare_alerts.resolved_by`
      );
      console.log(`   ACTION: Check supabase/functions/ for alert resolution RPC`);
    } else if (column.length > 0 && !column[0].exercised) {
      console.log(`   PRIMARY CAUSE: Writer exists but is never called`);
      console.log(
        `   ACTION: Check if resolve endpoint in web app calls the writer RPC`
      );
    } else {
      console.log(
        `   UNCLEAR: Entity appears wired, check RLS policies and logs`
      );
    }
  });

  test('AUDIT: dispatch_jobs.sla_respond_by field', async () => {
    console.log('\n--- AUDITING: dispatch_jobs.sla_respond_by ---');
    console.log(
      'User Report: SLA respond-by field appears NULL in job detail page'
    );

    // Check if column exists
    const column = await queryCapabilityMap('dispatch_jobs.sla_respond_by');
    console.log(`\n1️⃣ Entity Check:`);
    if (column.length > 0) {
      const row = column[0];
      console.log(`   ✓ Column exists in capability map`);
      console.log(`   - Present: ${row.present}`);
      console.log(`   - Wired: ${row.wired}`);
      console.log(`   - Exercised: ${row.exercised}`);
      if (row.last_exercised_at) {
        console.log(`   - Last run: ${row.last_exercised_at}`);
      }

      if (!row.exercised) {
        console.log(
          `   ⚠⚠⚠ GAP CONFIRMED: Column wired but never exercised — INSERT/UPDATE not happening`
        );
      }
    } else {
      console.log(
        `   ⚠ Column not in capability map — may not be tracked or not present`
      );
    }

    // Check for trigger that writes SLA
    console.log(`\n2️⃣ Data Writer Check:`);
    const writers = await queryEdges('dispatch_jobs');
    const triggerEdges = writers.filter(
      (e) => e.source_type === 'trigger' || e.edge_kind === 'writes'
    );

    if (triggerEdges.length > 0) {
      console.log(
        `   ✓ Found ${triggerEdges.length} potential writer(s):`
      );
      triggerEdges.forEach((edge) => {
        console.log(
          `     - ${edge.source_type}: ${edge.source_name} [${edge.edge_kind}]`
        );
      });
    } else {
      console.log(
        `   ⚠⚠⚠ NO WRITERS FOUND — sla_respond_by will always be NULL (Gap 2)`
      );
    }

    // Diagnosis
    console.log(`\n3️⃣ Diagnosis:`);
    if (triggerEdges.length === 0) {
      console.log(`   PRIMARY CAUSE: No trigger writes dispatch_jobs.sla_respond_by on INSERT`);
      console.log(`   ACTION: Check supabase/schema.sql for trigger on dispatch_jobs table`);
    } else if (column.length > 0 && !column[0].exercised) {
      console.log(`   PRIMARY CAUSE: Trigger exists but table never receives INSERT`);
      console.log(
        `   ACTION: Verify dispatch job creation RPC actually inserts into dispatch_jobs`
      );
    } else {
      console.log(
        `   UNCLEAR: Entity appears wired, check trigger conditions and logs`
      );
    }
  });

  test('AUDIT: bob_crm_accounts.account_manager_id (FK/RLS)', async () => {
    console.log('\n--- AUDITING: bob_crm_accounts.account_manager_id ---');
    console.log(
      'User Report: Account manager field NULL in CRM detail page (Gap 1)'
    );

    // Check if FK column exists
    const column = await queryCapabilityMap('bob_crm_accounts.account_manager_id');
    console.log(`\n1️⃣ Column Check:`);
    if (column.length > 0) {
      const row = column[0];
      console.log(`   ✓ Column exists in capability map`);
      console.log(`   - Present: ${row.present}`);
      console.log(`   - Wired: ${row.wired}`);
      console.log(`   - Exercised: ${row.exercised}`);
    } else {
      console.log(
        `   ⚠ Column not in capability map or not tracked`
      );
    }

    // Check for related officers table
    console.log(`\n2️⃣ FK Expansion Check:`);
    const fkEdges = await queryEdges('bob_crm_accounts');
    const officerJoins = fkEdges.filter(
      (e) => e.edge_kind === 'fk_references' && e.target_name?.includes('officer')
    );

    if (officerJoins.length > 0) {
      console.log(`   ✓ Found FK joins to officers:`);
      officerJoins.forEach((edge) => {
        console.log(
          `     - Joins ${edge.target_name} [${edge.edge_kind}]`
        );
      });
    } else {
      console.log(
        `   ⚠ No FK joins found — account manager expansion may be missing`
      );
    }

    // Check for RLS policy
    console.log(`\n3️⃣ RLS Policy Check:`);
    const rlsEdges = fkEdges.filter((e) => e.edge_kind === 'secured_by');
    if (rlsEdges.length > 0) {
      console.log(`   ✓ RLS policies found: ${rlsEdges.length}`);
      rlsEdges.forEach((edge) => {
        console.log(`     - Secured by: ${edge.source_name}`);
      });
    } else {
      console.log(
        `   ⚠⚠⚠ NO RLS POLICIES — Account manager likely blocked by permission denied (Gap 1)`
      );
    }

    // Diagnosis
    console.log(`\n4️⃣ Diagnosis:`);
    if (rlsEdges.length === 0) {
      console.log(`   PRIMARY CAUSE: Missing RLS policy on bob_crm_accounts`);
      console.log(`   ACTION: Check supabase/schema.sql for CREATE POLICY`);
    } else if (officerJoins.length === 0) {
      console.log(
        `   PRIMARY CAUSE: FK join configured but page doesn't expand it`
      );
      console.log(
        `   ACTION: Check CRM portfolio page query — ensure selecting officer details`
      );
    } else {
      console.log(`   UNCLEAR: Edges present but expansion fails — check logs`);
    }
  });

  test('Blast Radius: If we fix account_manager_id, what else moves?', async () => {
    console.log('\n--- BLAST RADIUS: account_manager_id fix ---');
    console.log('Question: If we add RLS + enable FK expansion, what changes?');

    const edges = await queryEdges('bob_crm_accounts');
    console.log(`\n1️⃣ Upstream (what reads bob_crm_accounts):`);
    const readers = edges.filter(
      (e) => e.target_name === 'bob_crm_accounts' && e.edge_kind === 'reads'
    );
    if (readers.length > 0) {
      readers.forEach((e) => {
        console.log(`   - ${e.source_type}: ${e.source_name}`);
      });
    } else {
      console.log(`   ℹ No direct reads registered (may use REST API)`);
    }

    console.log(`\n2️⃣ Downstream (what bob_crm_accounts reads):`);
    const downstream = edges.filter(
      (e) => e.source_name === 'bob_crm_accounts' && e.edge_kind === 'reads'
    );
    if (downstream.length > 0) {
      downstream.forEach((e) => {
        console.log(`   - Reads ${e.target_type}: ${e.target_name}`);
      });
    } else {
      console.log(`   ℹ No joins registered (may expand via FK)`);
    }

    console.log(`\n3️⃣ Risk Assessment:`);
    console.log(`   - Pages affected: ${readers.length || '?'}`);
    console.log(
      `   - Tables joined: ${downstream.length || '?'} (+ possibly FK joins)`
    );
    console.log(`   - Test coverage needed: CRM portfolio, account detail`);
  });

  test('Summary & Next Steps', async () => {
    console.log('\n' + '='.repeat(80));
    console.log('ATLAS AUDIT SUMMARY');
    console.log('='.repeat(80));
    console.log(`\nAtlas reveals the "wiring" of your app:`);
    console.log(`  1. Entity present? (CREATE TABLE happened)`);
    console.log(`  2. Wired? (Has callers/edges in the data flow graph)`);
    console.log(`  3. Exercised? (Actually runs in production)`);
    console.log(`\nMissing fields = missing writers OR missing RLS OR both`);
    console.log(`\nTo rebuild terrain after a fix:`);
    console.log(
      `  - Run: npm run atlas:refresh (from docs/ATLAS_REBUILD_ORDER.md)`
    );
    console.log(`  - Re-run: npx playwright test live-deployment-manual-walkthrough.spec.ts`);
    console.log(`\nFor deeper debugging:`);
    console.log(`  - Check supabase/schema.sql for the real CREATE TABLE`);
    console.log(`  - Look for triggers, policies, edge functions`);
    console.log(`  - Query pg_stat_user_tables to see if table ever ran`);
    console.log('='.repeat(80) + '\n');
  });
});
