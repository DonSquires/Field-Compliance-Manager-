import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260905006100_branch_roster_staff_directory.sql'), 'utf8');

describe('branch roster staff directory', () => {
  it('returns active, roster-eligible branch assignments joined to employer-owned staff records', () => {
    expect(migration).toContain("assignment.status='active'");
    expect(migration).toContain('assignment.can_be_rostered');
    expect(migration).toContain('join public.staff_profiles staff');
  });

  it('requires operating-branch roster authority', () => {
    expect(migration).toContain('user_can_operate_organization');
    expect(migration).toContain("'roster_impact_approve'");
  });
});