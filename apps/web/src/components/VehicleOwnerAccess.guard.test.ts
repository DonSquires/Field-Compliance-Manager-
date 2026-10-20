import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const panel = read('src/components/VehicleOwnerPanel.tsx');
const workspace = read('src/components/UserIdentityWorkspace.tsx');
const profile = read('src/components/VehicleProfile.tsx');
const repeat = read('src/components/RepeatSubjectsPanel.tsx');
const migration = read('../../supabase/migrations/20261020180000_vehicle_owner_access_area_locality.sql');
const people = read('../../supabase/migrations/20261020190000_vehicle_people_tiered_visibility.sql');
const search = read('src/pages/VehicleSearchPage.tsx');
const thumbnails = read('src/lib/observationThumbnails.ts');
const investigation = read('src/components/SendToInvestigationPanel.tsx');

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

  it('tiers person details: full details for authorised users, locality only for everyone else', () => {
    expect(people).toContain('v_full := public.can_access_vehicle_owner_identity(p_organization_id);');
    expect(people).toContain("CASE WHEN v_full THEN p.metadata->'profile_details'->>'address' END");
    expect(people).toContain("CASE WHEN v_full THEN coalesce(p.display_name, cp.display_name) END");
    expect(people).toContain("public.vehicle_owner_locality(p.metadata->'profile_details')");
    expect(people).toContain('NOT public.org_access_allowed(p_organization_id)');
    expect(panel).toContain('link.details_visible ?');
    expect(panel).toMatch(/identified/);
  });

  it('records drivers and associated people only through the audited RPC', () => {
    expect(people).toContain("p_relationship NOT IN ('owner', 'driver', 'associated_person')");
    expect(people).toMatch(/entity_links_write[\s\S]*'driver', 'associated_person'/);
    expect(people).toContain("'vehicle_person_recorded'");
    expect(people).toContain("IF p_source = 'nzta_mvr' AND p_relationship <> 'owner'");
    expect(panel).toContain("supabase.rpc('record_vehicle_person'");
    expect(panel).toContain('p_observation_id: observationId');
  });

  it('shows the first observation photo, opens the sighting beside the list and can send it to an investigation', () => {
    expect(thumbnails).toContain("from('observation_supporting_evidence')");
    expect(thumbnails).toContain("in('metadata->>observation_id', missing)");
    expect(search).toContain('observationPhotos[obs.id]');
    expect(search).toContain('vehicle-observation-panel');
    expect(search).toContain('vehicle-observation-overlay');
    expect(search).toContain('<SendToInvestigationPanel');
    expect(investigation).toContain("supabase.rpc('link_investigation_entity'");
    expect(investigation).toContain("supabase.rpc('is_admin_for_org', { target_org_id: organizationId })");
  });

  it('makes a flagged vehicle obvious with a coloured border and a risk banner at the top', () => {
    expect(search).toContain('riskLevel={riskLevel} riskBanner={riskBanner}');
    expect(profile).toContain('vehicle-risk-border is-${riskLevel}');
  });
});
