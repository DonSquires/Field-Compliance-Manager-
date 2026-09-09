import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260909100000_dispatch_operator_controls.sql'), 'utf8');

describe('dispatch operator controls', () => {
  it('provides governed job, stop, and shift actions', () => {
    expect(migration).toContain('manage_dispatch_job');
    expect(migration).toContain("p_action NOT IN ('amend','reassign','escalate','cancel')");
    expect(migration).toContain('manage_shift_stop');
    expect(migration).toContain("p_action NOT IN ('reorder','skip','cancel')");
    expect(migration).toContain('manage_active_shift');
    expect(migration).toContain("p_action NOT IN ('amend','escalate','cancel')");
  });

  it('requires reasons and writes audit events', () => {
    expect(migration).toContain('A reason is required');
    expect(migration).toContain("'dispatch_job_'||p_action");
    expect(migration).toContain("'shift_stop_'||p_action");
    expect(migration).toContain("'shift_'||p_action");
    expect(migration).toContain('Completed or cancelled jobs cannot be changed');
    expect(migration).toContain('An attended stop cannot be skipped or cancelled');
    expect(migration).toContain('An active shift cannot be cancelled after it has started');
  });
});
