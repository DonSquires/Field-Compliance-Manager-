import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260905006300_read_operating_branch_rate_rules.sql'), 'utf8');

describe('operating branch rate rule read access', () => {
  it('allows authorized operating branch reads without reopening direct writes', () => {
    expect(migration).toContain('user_can_operate_organization(organization_id)');
    expect(migration).toContain('REVOKE INSERT, UPDATE, DELETE ON public.rate_rules FROM authenticated');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.user_can_operate_organization(uuid) TO authenticated');
  });
});