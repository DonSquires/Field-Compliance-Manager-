import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260905005000_operating_organization_context.sql'), 'utf8');

describe('operating organization context schema', () => {
  it('keeps employment context separate and returns active authorized delivery branches', () => {
    expect(migration).toContain('get_operating_organization_contexts');
    expect(migration).toContain("'branch_authorisation'::text");
    expect(migration).toContain("authorisation.status = 'active'");
    expect(migration).toContain("branch.organization_type = 'branch'");
    expect(migration).toContain('employer_organization_id');
  });

  it('permits corporate oversight branch selection only for corporate administration roles', () => {
    expect(migration).toContain("actor.role in ('grand_master', 'master', 'admin')");
    expect(migration).toContain("'corporate_oversight'::text");
    expect(migration).toContain('get_descendant_organizations');
  });

  it('requires an authorized operating branch for roster-owned writes', () => {
    expect(migration).toContain('user_can_operate_organization');
    expect(migration).toContain('create_operating_roster_work_unit');
    expect(migration).toContain('create_operating_organization_workplace');
    expect(migration).toContain('create_operating_cost_centre');
  });
});