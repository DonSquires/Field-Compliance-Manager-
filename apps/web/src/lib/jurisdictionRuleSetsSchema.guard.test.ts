import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901028000_jurisdiction_rule_sets_write.sql'), 'utf8');
const schema = readFileSync(resolve(process.cwd(), '../../supabase/schema.sql'), 'utf8');

describe('jurisdiction_rule_sets write access', () => {
  it('grants insert/update/delete only to org admins', () => {
    expect(migration).toContain('for insert with check (public.is_admin_for_org(organization_id))');
    expect(migration).toContain('for update using (public.is_admin_for_org(organization_id))');
    expect(migration).toContain('for delete using (public.is_admin_for_org(organization_id))');
  });

  it('is present in the generated schema dump', () => {
    expect(schema).toContain('CREATE POLICY "jurisdiction_rule_sets_insert"');
    expect(schema).toContain('CREATE POLICY "jurisdiction_rule_sets_update"');
    expect(schema).toContain('CREATE POLICY "jurisdiction_rule_sets_delete"');
  });
});

describe('get_crm_operational_geography exposes jurisdiction_rule_set_id', () => {
  it('selects jurisdiction_rule_set_id for zones so ZoneDetailPage can link a rule set', () => {
    expect(migration).toContain('z.jurisdiction_rule_set_id');
    expect(schema).toContain('z.jurisdiction_rule_set_id');
  });
});
