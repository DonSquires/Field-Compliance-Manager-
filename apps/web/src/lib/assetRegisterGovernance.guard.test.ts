import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
const migration = read('../../supabase/migrations/20261015044226_govern_asset_register.sql');
const timestampMigration = read('../../supabase/migrations/20261015044758_advance_asset_concurrency_token.sql');
const page = read('src/pages/RosterHRPage.tsx');
const css = read('src/pages/RosterHRPage.css');

describe('governed fleet and equipment register', () => {
  it('replaces the callerless signature with replay and optimistic guards', () => {
    expect(migration).toContain('DROP FUNCTION public.manage_asset(');
    expect(migration).toContain('idx_audit_asset_management_request');
    expect(migration).toContain("hashtextextended('asset-management:' || p_client_request_id::text, 0)");
    expect(migration).toContain('v_previous.updated_at IS DISTINCT FROM p_expected_updated_at');
    expect(migration).toContain('This asset changed after it was opened. Reload it before saving.');
    expect(migration).toContain('client_request_id has already been used for a different asset action');
    expect(timestampMigration).toContain('NEW.updated_at := clock_timestamp()');
    expect(timestampMigration).toContain('BEFORE UPDATE ON public.assets');
  });

  it('normalizes identifiers and rejects invalid lifecycle state', () => {
    expect(migration).toContain('assets_org_registration_unique');
    expect(migration).toContain('assets_org_serial_number_unique');
    expect(migration).toContain("upper(regexp_replace(btrim(coalesce(p_registration, '')), '\\s+', '', 'g'))");
    expect(migration).toContain('An asset becomes in use only when it is signed out to a shift');
    expect(migration).toContain('Asset is still assigned to an active shift');
    expect(migration).toContain('Asset year must be between 1900 and next year');
  });

  it('records before and after evidence under least privilege', () => {
    expect(migration).toContain("'previous_record', CASE");
    expect(migration).toContain("'record', to_jsonb(v_asset)");
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.manage_asset\([\s\S]*?\) FROM PUBLIC, anon, authenticated, service_role;/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.manage_asset\([\s\S]*?\) TO postgres, authenticated, service_role;/);
  });

  it('uses one accountable UI path with safe exit and downstream meaning', () => {
    expect(page).toContain("supabase.rpc('manage_asset'");
    expect(page).toContain('Keep current register');
    expect(page).toContain('Confirm update');
    expect(page).toContain('Add to register');
    expect(page).toContain('Shift assignment remains a separate officer action with its own receipt.');
    expect(page).not.toMatch(/from\('assets'\)[\s\S]{0,300}\.(insert|update|upsert|delete)\(/);
  });

  it('keeps create and edit usable on narrow screens', () => {
    expect(css).toContain('.hr-asset-register-header');
    expect(css).toContain('.hr-asset-form-grid');
    expect(css).toContain('max-height:calc(100dvh - 20px);overflow-y:auto');
    expect(css).toMatch(/@media\(max-width:560px\)[\s\S]*\.hr-asset-form-grid\{grid-template-columns:1fr\}/);
  });
});
