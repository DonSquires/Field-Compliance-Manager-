import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/ReportsHubPage.tsx'), 'utf8');
const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901001000_govern_report_pack_generation.sql'), 'utf8');

describe('governed monthly report pack generation', () => {
  it('generates through the governed RPC and shows the resulting pack queue', () => {
    expect(page).toContain("rpc('generate_due_report_packs'");
    expect(page).toContain("from('monthly_report_packs')");
    expect(page).toContain('report packs generated');
    expect(page).toContain('Generate report packs');
  });

  it('does not mutate report packs directly from the browser', () => {
    expect(page).not.toMatch(/from\('monthly_report_packs'\)[\s\S]{0,240}\.(insert|update|upsert)\(/);
  });

  it('limits generation to the active provider administrator and records an audit receipt', () => {
    expect(migration).toContain('provider_organization_id=v_provider');
    expect(migration).toContain('public.is_admin_for_org(v_provider)');
    expect(migration).toContain("'monthly_report_packs_generated'");
    expect(migration).toContain('from public,anon;');
    expect(migration).toContain('to authenticated,service_role;');
  });
});