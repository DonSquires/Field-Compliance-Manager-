import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260912131000_finance_owner_brief.sql'), 'utf8');

describe('finance owner brief', () => {
  it('provides a tenant-scoped read-only finance summary', () => {
    expect(migration).toContain('get_finance_owner_brief()');
    expect(migration).toContain('is_admin_for_org(v_org)');
    expect(migration).toContain("status IN ('over_budget','no_budget')");
    expect(migration).toContain("reconciliation_status <> 'matched'");
    expect(migration).toContain("rate_status = 'unresolved'");
  });

  it('returns plain-language priorities with governed tax boundaries', () => {
    expect(migration).toContain('Nothing urgent was found in the finance records Bob checked.');
    expect(migration).toContain('Bob can prepare the figures and checklist; you approve filing and payment.');
    expect(migration).toContain("REVOKE ALL ON FUNCTION public.get_finance_owner_brief() FROM PUBLIC, anon");
    expect(migration).not.toContain('INSERT INTO');
    expect(migration).not.toContain('UPDATE public.');
  });
});
