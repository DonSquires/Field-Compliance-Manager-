import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/ReportsHubPage.tsx'), 'utf8');
const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901001000_govern_report_pack_generation.sql'), 'utf8');

describe('governed monthly report pack generation', () => {
  it('fails closed when organisation context is unavailable', () => {
    expect(page).toContain("if (!profile?.organizationId) {");
    expect(page).toContain("setError('Organisation access could not be confirmed. Reports are unavailable.');");
    expect(page).toContain('setLoading(false);');
  });

  it('generates through the governed RPC and shows the resulting pack queue', () => {
    expect(page).toContain("rpc('generate_due_report_packs'");
    expect(page).toContain("from('monthly_report_packs')");
    expect(page).toContain('report packs generated');
    expect(page).toContain('Generate report packs');
  });

  it('includes the complete selected end date for timestamped evidence', () => {
    expect(page).toContain('function exclusiveEndIso(date: string): string');
    expect(page).toContain(".lt('created_at', timestampEndExclusive)");
    expect(page).toContain(".lt('observed_at', timestampEndExclusive)");
    expect(page).not.toContain(".lte('created_at', dateRange.end)");
    expect(page).not.toContain(".lte('observed_at', dateRange.end)");
  });

  it('sends generated packs through the authenticated delivery function', () => {
    expect(page).toContain("supabase.functions.invoke('send-report-pack'");
    expect(page).toContain('pack_id: pack.id');
    expect(page).toContain('Send to client');
    expect(page).not.toMatch(/from\('monthly_report_packs'\)[\s\S]{0,240}\.update\(/);
  });

  it('triggers 24-hour operational rollups through the daily rollup edge function', () => {
    expect(page).toContain("supabase.functions.invoke('generate-daily-operational-rollup')");
    expect(page).toContain('Generate daily rollup');
    expect(page).toContain('Daily operational rollup draft generated');
  });

  it('does not mutate report packs directly from the browser', () => {
    expect(page).not.toMatch(/from\('monthly_report_packs'\)[\s\S]{0,240}\.(insert|update|upsert)\(/);
  });

  it('shows parent oversight as a branch-preserving reporting read model', () => {
    expect(page).toContain("rpc('get_consolidated_reporting_overview'");
    expect(page).toContain('Group Reporting Overview');
    expect(page).toContain('row.source_organization_name');
    expect(page).toContain('Branch-owned operational activity, consolidated for parent oversight.');
  });

  it('limits generation to the active provider administrator and records an audit receipt', () => {
    expect(migration).toContain('provider_organization_id=v_provider');
    expect(migration).toContain('public.is_admin_for_org(v_provider)');
    expect(migration).toContain("'monthly_report_packs_generated'");
    expect(migration).toContain('from public,anon;');
    expect(migration).toContain('to authenticated,service_role;');
  });
});