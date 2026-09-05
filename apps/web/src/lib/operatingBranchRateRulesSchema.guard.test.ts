import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260905006000_govern_operating_branch_rate_rules.sql'), 'utf8');

describe('operating branch rate rules', () => {
  it('requires an authorized active delivery branch and preserves audit/expected-state controls', () => {
    expect(migration).toContain('user_can_operate_organization(p_operating_organization_id)');
    expect(migration).toContain("organization_type='branch' and branch.active");
    expect(migration).toContain("'Rate rule changed since it was opened'");
    expect(migration).toContain("'operating_branch_rate_rule_managed'");
  });
});