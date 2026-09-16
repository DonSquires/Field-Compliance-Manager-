import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = existsSync(resolve(process.cwd(), 'apps/web/src')) ? resolve(process.cwd(), 'apps/web') : process.cwd();
const repoRoot = existsSync(resolve(process.cwd(), 'supabase/migrations')) ? process.cwd() : resolve(process.cwd(), '../..');
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');

const officerPage = read('src/pages/OfficerVehicleLookupPage.tsx');
const adminPage = read('src/pages/VehicleSearchPage.tsx');
const observationPage = read('src/pages/ObservationSearchPage.tsx');
const sitePage = read('src/pages/SiteDetailPage.tsx');
const panel = read('src/components/SafetyWarningsPanel.tsx');
const lib = read('src/lib/safetyWarnings.ts');
const migration = readFileSync(resolve(repoRoot, 'supabase/migrations/20260916100000_safety_warnings_and_plate_registry_read.sql'), 'utf8');

describe('plate registry read model (canonical_vehicles stays Bob-only)', () => {
  it('every vehicle surface reads the projection, never the base table', () => {
    for (const source of [officerPage, adminPage, observationPage]) {
      expect(source).toContain("from('canonical_vehicle_public')");
      expect(source).not.toContain("from('canonical_vehicles')");
      expect(source).not.toContain("from('canonical_scv')");
    }
    expect(officerPage).toContain("from('canonical_scv_public')");
    expect(adminPage).toContain("from('canonical_scv_public')");
  });

  it('never selects or renders the private welfare narrative or registered owner', () => {
    for (const source of [officerPage, adminPage, observationPage, panel]) {
      expect(source).not.toContain('homeless_notes');
      expect(source).not.toContain('registered_owner_name');
    }
    expect(migration).toMatch(/CREATE OR REPLACE VIEW public\.canonical_vehicle_public AS[\s\S]*?FROM public\.canonical_vehicles;/);
    const projection = migration.match(/CREATE OR REPLACE VIEW public\.canonical_vehicle_public AS([\s\S]*?)FROM public\.canonical_vehicles;/)?.[1] ?? '';
    expect(projection).not.toContain('homeless_notes');
    expect(projection).not.toContain('registered_owner_name');
    expect(projection).toContain('homeless_status');
  });
});

describe('platform-wide safety warnings (H&S exception)', () => {
  it('vehicle and site surfaces show warnings through the redacting RPC, not entity_flags', () => {
    for (const source of [officerPage, adminPage, sitePage]) {
      expect(source).toContain('<SafetyWarningsPanel');
    }
    expect(officerPage).toContain('entityType="vehicle"');
    expect(adminPage).toContain('entityType="vehicle"');
    expect(sitePage).toContain('entityType="site"');
    expect(panel).toContain("supabase.rpc('get_safety_warnings'");
    expect(panel).toContain("supabase.rpc('raise_entity_flag'");
    expect(panel).toContain("supabase.rpc('resolve_entity_flag'");
    expect(panel).not.toContain("from('entity_flags')");
  });

  it("own-organisation of-interest flags exclude safety warnings so they are never double-shown", () => {
    expect(officerPage).toContain(".is('hazard_class', null)");
    expect(adminPage).toContain(".is('hazard_class', null)");
  });

  it('admin flag writes go through the governed RPCs, not table inserts/updates', () => {
    expect(adminPage).toContain("supabase.rpc('raise_entity_flag'");
    expect(adminPage).toContain("supabase.rpc('resolve_entity_flag'");
    expect(adminPage).not.toMatch(/from\('entity_flags'\)\s*\.insert/);
    expect(adminPage).not.toMatch(/from\('entity_flags'\)\s*\.update/);
  });

  it('the hazard classes offered in the UI are exactly the ones the database accepts', () => {
    const check = migration.match(/entity_flags_hazard_class_check\s+CHECK \(hazard_class IS NULL OR hazard_class = ANY \(ARRAY\[([\s\S]*?)\]\)\)/i)?.[1] ?? '';
    const dbClasses = [...check.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort();
    const hazardBlock = lib.match(/export const SAFETY_HAZARD_CLASSES[\s\S]*?\];/)?.[0] ?? '';
    const uiClasses = [...hazardBlock.matchAll(/\{ value: '([a-z_]+)', label:/g)].map((match) => match[1]).sort();
    expect(dbClasses.length).toBeGreaterThan(0);
    expect(uiClasses).toEqual(dbClasses);
  });

  it('other organisations only ever receive hazard class, severity, raiser org and contact path', () => {
    expect(migration).toContain("case when f.organization_id = v_org then f.reason else null end");
    expect(panel).toContain('warning.is_own_organization && warning.reason');
    expect(panel).toContain('warningContactPath(warning)');
  });
});
