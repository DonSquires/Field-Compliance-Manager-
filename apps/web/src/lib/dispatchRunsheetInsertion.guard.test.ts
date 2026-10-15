import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../../supabase/migrations/20261015005110_govern_dispatch_runsheet_insertion.sql'),
  'utf8',
);
const declarativeFunction = readFileSync(
  resolve(process.cwd(), '../../supabase/schemas/public/functions/insert_adhoc_stop.sql'),
  'utf8',
);
const page = readFileSync(resolve(process.cwd(), 'src/pages/DispatchConsolePage.tsx'), 'utf8');

describe('governed dispatch run-sheet insertion', () => {
  it('replaces the anonymous legacy writer with authenticated, organization-scoped authority', () => {
    expect(migration).toContain('DROP FUNCTION IF EXISTS public.insert_adhoc_stop');
    expect(migration).toContain('public.is_admin_for_org(v_job.organization_id)');
    expect(migration).toContain("SET search_path TO 'public'");
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role');
    expect(migration).toContain('TO postgres, authenticated, service_role');
    expect(declarativeFunction).not.toContain('p_officer_gps_lat');
    expect(declarativeFunction).not.toContain('to public, "anon"');
  });

  it('proves agreement, place, module, officer, and current state before inserting', () => {
    expect(migration).toContain('v_shift.organization_id IS DISTINCT FROM v_job.organization_id');
    expect(migration).toContain('v_shift_agreement_id IS DISTINCT FROM v_job.service_agreement_id');
    expect(migration).toContain('public.service_agreement_locations');
    expect(migration).toContain('v_job.assigned_officer_id IS DISTINCT FROM v_shift.officer_user_id');
    expect(migration).toContain('v_job.module_key IS DISTINCT FROM v_shift.module_key');
    expect(migration).toContain('v_job.status IS DISTINCT FROM p_expected_job_status');
    expect(migration).toContain('v_shift.updated_at IS DISTINCT FROM p_expected_shift_updated_at');
    expect(migration).toContain("v_shift.status NOT IN ('published', 'accepted', 'in_progress')");
  });

  it('is replay-safe and leaves a complete operational receipt', () => {
    const replayCheck = migration.indexOf("metadata ->> 'client_request_id' = p_client_request_id::text");
    const staleJobCheck = migration.indexOf('v_job.status IS DISTINCT FROM p_expected_job_status');
    expect(replayCheck).toBeGreaterThan(-1);
    expect(replayCheck).toBeLessThan(staleJobCheck);
    expect(migration).toContain('idx_audit_dispatch_runsheet_insert_request');
    expect(migration).toContain("'dispatch_job_runsheet_insert'");
    expect(migration).toContain("'previous_job_status', v_job.status");
    expect(migration).toContain("'new_job_status', 'dispatched'");
    expect(migration).toContain("invalidation_reason = 'dispatch_job_runsheet_insert'");
  });

  it('uses one explicit run-sheet action with confirmation, reason, progress, and receipt feedback', () => {
    expect(page).toContain("supabase.rpc('insert_adhoc_stop'");
    expect(page).toContain('p_client_request_id: jobRunsheetRequestId');
    expect(page).toContain('p_expected_shift_updated_at: selectedShift.updatedAt');
    expect(page).toContain('Confirm and add stop');
    expect(page).toContain('Keep job separate');
    expect(page).toContain('Reason for the insertion');
    expect(page).toContain('officer route and supervisor view now share the same job');
    expect(page).toContain('The selected run sheet belongs to a different service agreement.');
  });
});
