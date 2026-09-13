import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/PatrolOversightPage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');
const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901009000_patrol_evidence_oversight.sql'), 'utf8');

describe('admin patrol evidence oversight', () => {
  it('uses a dedicated read-only admin page instead of the officer patrol workflow', () => {
    expect(shell).toContain('return <PatrolOversightPage />');
    expect(page).toContain("from('patrol_checkpoint_visits')");
    expect(page).toContain(".eq('organization_id', organizationId)");
    expect(page).toContain("from('patrol_checkpoints')");
    expect(page).toContain("from('user_profiles')");
    expect(page).not.toMatch(/from\('patrol_checkpoint_visits'\)[\s\S]{0,300}\.(insert|update|delete)\(/);
  });

  it('shows checkpoint, officer, GPS confidence, and exact evidence identity', () => {
    for (const value of ['Checkpoint evidence', 'Within checkpoint', 'GPS accuracy', 'Evidence ID', 'shift_stop_id']) expect(page).toContain(value);
  });

  it('makes the dormant unscoped stop completion RPC service-only', () => {
    expect(migration).toContain('revoke all on function public.complete_shift_stop(uuid,text,double precision,double precision) from public,anon,authenticated');
    expect(migration).toContain('grant execute on function public.complete_shift_stop(uuid,text,double precision,double precision) to service_role');
  });

  it('clears loading state when organization scope is unavailable', () => {
    expect(page).toContain('if (!organizationId) {');
    expect(page).toContain('setLoading(false);');
  });
});