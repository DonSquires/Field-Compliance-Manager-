import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const local = resolve(process.cwd(), 'supabase/migrations/20260904210000_govern_rate_rules.sql');
const sql = readFileSync(existsSync(local) ? local : resolve(process.cwd(), '../../supabase/migrations/20260904210000_govern_rate_rules.sql'), 'utf8');
const page = readFileSync(resolve(process.cwd(), 'src/pages/RateRulesPage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');

describe('governed rate rule management', () => {
  it('replaces direct browser writes with one audited expected-state RPC', () => {
    expect(sql).toContain('DROP POLICY IF EXISTS rate_rules_write');
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE ON public.rate_rules');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.manage_rate_rule');
    expect(sql).toContain('Rate rule changed since it was opened');
    expect(sql).toContain("'rate_rule_managed'");
  });
  it('exposes create, update, and activate/deactivate only through the governed RPC', () => {
    expect(page).toContain("supabase.rpc('manage_operating_branch_rate_rule'");
    expect(page).toContain("p_action: 'update'");
    expect(page).toContain('p_expected_updated_at: editingRule.updated_at');
    expect(page).toContain('Edit rule');
    expect(page).toContain("supabase.rpc('resolve_dispatch_job_pay_lines'");
    expect(page).toContain('Finished jobs that still need pay and charge checked');
    expect(page).not.toContain(".from('rate_rules').insert");
    expect(page).not.toContain(".from('rate_rules').update");
  });
  it('is routed through the admin finance navigation', () => {
    expect(shell).toContain("'rate-rules'");
    expect(shell).toContain('RateRulesPage');
  });
});
