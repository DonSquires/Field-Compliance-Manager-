import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../../supabase/migrations/20261107180000_retrospective_dispatch_job_outcome.sql'),
  'utf8',
);
const page = readFileSync(resolve(process.cwd(), 'src/pages/DispatchConsolePage.tsx'), 'utf8');

describe('retrospective noise-control outcomes', () => {
  it('uses an admin-only, replay-safe RPC with source provenance and an audit receipt', () => {
    expect(migration).toContain('public.is_admin_for_org(v_job.organization_id)');
    expect(migration).toContain('pg_catalog.pg_advisory_xact_lock');
    expect(migration).toContain("al.action = 'dispatch_job_retroactive_register_completion'");
    expect(migration).toContain("'source', jsonb_build_object(");
    expect(migration).toContain("'sha256', lower(p_source_sha256)");
    expect(migration).toContain("SET search_path = ''");
    expect(migration).toContain('FROM PUBLIC, anon');
  });

  it('requires an exact noise-job reference and ordered New Zealand source times', () => {
    expect(migration).toContain("v_job.job_type <> 'noise_control'");
    expect(migration).toContain("v_job.briefing_notes");
    expect(migration).toContain("p_source_time_zone IS DISTINCT FROM 'Pacific/Auckland'");
    expect(migration).toContain('v_source_received > v_source_arrived OR v_source_arrived > v_source_departed');
    expect(migration).toContain('The source off-site time cannot be in the future');
  });

  it('preserves source-reported attendance without inventing dispatch, GPS, or an officer stop', () => {
    expect(migration).toContain("fcm.retrospective_register_completion");
    expect(migration).toContain("'gps_captured', false");
    expect(migration).toContain("'shift_stop_created', false");
    expect(migration).toContain("SET status = 'completed'");
    expect(migration).not.toContain('INSERT INTO public.shift_stops');
    expect(migration).toContain("WHEN v_job.shift_id IS NULL THEN 'No linked shift/officer is available for pay attribution'");
    expect(migration).toContain("travel_basis', 'not_calculated_without_dispatch_origin'");
  });

  it('lets an admin hash the source locally and confirm its provenance before completing', () => {
    expect(page).toContain('sha256Hex(await file.arrayBuffer())');
    expect(page).toContain("supabase.rpc('record_retrospective_noise_job_outcome'");
    expect(page).toContain('type="file"');
    expect(page).toContain('type="datetime-local"');
    expect(page).toContain('I reviewed the exact source record.');
    expect(page).toContain('No FCM GPS was added.');
  });
});
