import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260912132300_finance_brief_source_health.sql'), 'utf8');

describe('finance brief source health', () => {
  it('checks source freshness before Bob relies on NZ finance guidance', () => {
    expect(migration).toContain('bob_nz_finance_sources');
    expect(migration).toContain("status <> 'active'");
    expect(migration).toContain('last_verified_on IS NULL');
    expect(migration).toContain('review_due_on < CURRENT_DATE');
  });

  it('surfaces stale sources as a plain-language priority and returns health facts', () => {
    expect(migration).toContain('NZ finance source');
    expect(migration).toContain('Bob will not rely on guidance until the source register is refreshed.');
    expect(migration).toContain("'finance_source_health_issues', v_source_health_issues");
  });
});
