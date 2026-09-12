import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260912143000_akahu_personal_grandmaster_test.sql'), 'utf8');
const edge = readFileSync(resolve(process.cwd(), '../../supabase/functions/finance-akahu-personal-check/index.ts'), 'utf8');
const ui = readFileSync(resolve(process.cwd(), 'src/components/FinanceConnectionWizard.tsx'), 'utf8');

describe('Grandmaster Personal Akahu test', () => {
  it('is Grandmaster-only and records only redacted account summaries', () => {
    expect(migration).toContain("role = 'grand_master'");
    expect(migration).toContain('finance_akahu_personal_checks');
    expect(edge).toContain("Deno.env.get('AKAHU_PERSONAL_USER_TOKEN')");
    expect(edge).toContain("Deno.env.get('AKAHU_PERSONAL_USER_TOKEN') ?? '').trim()");
    expect(edge).toContain("Deno.env.get('AKAHU_APP_ID') ?? '').trim()");
    expect(edge).toContain('id_suffix');
    expect(edge).toContain('transactions_imported: false');
    expect(edge).not.toContain('finance_external_bank_transactions');
  });

  it('exposes the personal test only to the Grandmaster UI', () => {
    expect(ui).toContain("profile?.role === 'grand_master'");
    expect(ui).toContain("supabase.functions.invoke('finance-akahu-personal-check'");
    expect(ui).toContain('Test personal Akahu');
  });
});
