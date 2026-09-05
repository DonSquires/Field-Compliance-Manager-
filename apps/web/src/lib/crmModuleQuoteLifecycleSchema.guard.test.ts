import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(import.meta.dirname, '../../../../supabase/migrations/20260905007100_module_priced_quote_send.sql'), 'utf8');

describe('module-priced quote send lifecycle', () => {
  it('allows a positively priced module line only when that module is quoted', () => {
    expect(migration).toContain("line.kind='module'");
    expect(migration).toContain('line.module_key IS NOT NULL');
    expect(migration).toContain('quote_proposal_modules module');
    expect(migration).toContain('At least one positively priced labour or quoted module line is required');
  });

  it('retains locked state, positive total, margin, and audit requirements', () => {
    expect(migration).toContain('v_quote.status<>p_expected_status');
    expect(migration).toContain('v_quote.total_charge<=0');
    expect(migration).toContain('v_margin<v_quote.target_margin_pct');
    expect(migration).toContain("'crm_quote_sent'");
  });
});