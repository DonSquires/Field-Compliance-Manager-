import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/NzscvSupplierPage.tsx'), 'utf8');
const router = readFileSync(resolve(process.cwd(), 'src/routing/RoleRouter.tsx'), 'utf8');
const platform = readFileSync(resolve(process.cwd(), 'src/pages/GrandMasterPlatformPage.tsx'), 'utf8');
const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260927160000_nzscv_supplier_dashboard.sql'), 'utf8');

describe('NZSCV supplier transparency portal', () => {
  it('is a dedicated portal for NZSCV suppliers with grand-master oversight access', () => {
    expect(router).toContain("role === 'nzscv_monitor' || role === 'grand_master'");
    expect(router).toContain("expectedPrefix = '/nzscv'");
    expect(router).not.toContain("role === 'admin' ||\n    role === 'nzscv_monitor'");
    expect(platform).toContain("navigate('/nzscv')");
    expect(platform).toContain('Open NZSCV supplier view');
  });

  it('loads only through the role-gated aggregate supplier RPC', () => {
    expect(page).toContain("rpc('get_nzscv_supplier_dashboard'");
    expect(page).not.toMatch(/from\('(canonical_scv|observations|scv_import_batches)'\)/);
    expect(migration).toContain("v_role NOT IN ('nzscv_monitor', 'grand_master')");
    expect(migration).toContain("observation.module_key = 'freedom_camping'");
    expect(migration).toContain('FROM public.canonical_scv_public register');
  });

  it('shows aggregate use and public register fields without operational identities or raw source rows', () => {
    expect(page).toContain('Aggregate use only');
    expect(page).toContain('No client, officer, incident, location, photo, or raw source-row details are included.');
    expect(page).toContain('Search plate or certificate');
    expect(page).toContain('const PAGE_SIZE = 25');
    expect(page).not.toContain('Import SCV CSV');
    expect(migration).toContain("'tenant_details_included', false");
    expect(migration).toContain("'officer_details_included', false");
    expect(migration).toContain("'raw_source_rows_included', false");
    expect(migration).not.toContain('raw_source_row,');
  });
});
