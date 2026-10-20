import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const panel = read('src/components/VehicleOwnerPanel.tsx');
const workspace = read('src/components/UserIdentityWorkspace.tsx');
const profile = read('src/components/VehicleProfile.tsx');
const repeat = read('src/components/RepeatSubjectsPanel.tsx');
const migration = read('../../supabase/migrations/20261020180000_vehicle_owner_access_area_locality.sql');

describe('vehicle owner details for authorised users', () => {
  it('gates owner reads and writes on the vehicle_owner_identity access area, not administrator role alone', () => {
    expect(migration).toContain("grant_row.area = 'vehicle_owner_identity'");
    expect(migration).toContain('public.can_access_vehicle_owner_identity(p_organization_id, true)');
    expect(migration).toContain('public.can_access_vehicle_owner_identity(v_link.organization_id, true)');
    expect(migration).toContain('OR public.can_access_vehicle_owner_identity(organization_id)');
    expect(migration).not.toMatch(/record_vehicle_owner[\s\S]*manage_identity_person_record\(/);
  });

  it('lets only an organisation administrator switch the area, with a reason and audit row', () => {
    expect(migration).toMatch(/set_vehicle_owner_access[\s\S]*is_admin_for_org\(v_target\.organization_id\)/);
    expect(migration).toContain("'vehicle_owner_access_granted'");
    expect(workspace).toContain("supabase.rpc('set_vehicle_owner_access'");
    expect(workspace).toContain('!reason.trim()');
  });

  it('works out view and record access in the panel itself', () => {
    expect(panel).toContain("supabase.rpc('can_access_vehicle_owner_identity'");
    expect(panel).not.toContain('canManage');
    expect(profile).not.toMatch(/VehicleOwnerPanel[^>]*canManage/);
    expect(repeat).not.toContain('isHomeAdmin');
  });

  it('shows suburb and city only, never the street address', () => {
    expect(migration).toContain('public.vehicle_owner_locality(p.metadata->\'profile_details\')');
    expect(migration).not.toMatch(/get_vehicle_owner_links[\s\S]*profile_details'->>'address'/);
    expect(panel).toContain('owner.locality');
    expect(panel).not.toContain('owner.address');
  });
});
