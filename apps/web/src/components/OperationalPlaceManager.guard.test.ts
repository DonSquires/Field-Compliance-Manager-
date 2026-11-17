/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const manager = readFileSync(resolve(process.cwd(), 'src/components/OperationalPlaceManager.tsx'), 'utf8');
const houseMap = readFileSync(resolve(process.cwd(), 'src/components/LocationHouseMap.tsx'), 'utf8');
const policy = readFileSync(resolve(process.cwd(), 'src/components/WorkingZonePolicyEditor.tsx'), 'utf8');
const locations = readFileSync(resolve(process.cwd(), 'src/pages/LocationsPage.tsx'), 'utf8');
const zones = readFileSync(resolve(process.cwd(), 'src/pages/ZoneDetailPage.tsx'), 'utf8');
const site = readFileSync(resolve(process.cwd(), 'src/pages/SiteDetailPage.tsx'), 'utf8');
const users = readFileSync(resolve(process.cwd(), 'src/pages/UserManagementPage.tsx'), 'utf8');

describe('human operational controls', () => {
  it('keeps geofence authoring in Location House and links facet pages there', () => {
    expect(locations).toContain('Manage location');
    expect(locations).toContain('<OperationalPlaceManager');
    expect(site).toContain('Manage geofences in Location House');
    expect(zones).toContain('Manage in Location House');
    expect(site).not.toContain('editableEntity=');
    expect(zones).not.toContain('editableEntity={{');
    expect(zones).not.toContain('<OperationalPlaceManager');
  });

  it('uses plain-language steps and explains temporary restrictions', () => {
    for (const label of ['1. Site briefing', '2. Work areas', '3. Map boundaries', '4. Checkpoints', '5. Temporary restrictions', 'Save site briefing', 'Add work area', 'Schedule restriction', 'End restriction now']) {
      expect(manager).toContain(label);
    }
    expect(manager).toContain("supabase.rpc('get_location_patrol_checkpoints'");
    expect(manager).toContain("supabase.rpc('manage_location_patrol_checkpoint'");
    expect(manager).toContain("p_entity_type: 'patrol_checkpoint'");
    expect(manager).toContain('checkpointReviewed !== selectedCheckpoint.id');
    expect(manager).not.toMatch(/supabase\.from\(/);
    expect(manager).toContain('storm, fire risk, event, maintenance, or temporary client instruction');
    expect(manager).toContain('Officers see the restriction when GPS matches this area.');
    expect(manager).not.toContain('Create closure');
  });

  it('uses the visual house map rather than asking a person for GeoJSON', () => {
    expect(manager).toContain('<LocationHouseMap');
    expect(manager).toContain('Use the map, not GeoJSON.');
    expect(manager).toContain('Find the LINZ parcel, draw corners over satellite imagery, or use a measured radius.');
    expect(manager).not.toContain('JSON.parse');
    expect(manager).not.toContain('manual_geojson');
    expect(houseMap).toContain('L.geoJSON');
    expect(houseMap).toContain('setDrawPoints');
    expect(houseMap).toContain("supabase.rpc('propose_boundary'");
    expect(houseMap).toContain("supabase.rpc('accept_boundary_proposal'");
    expect(houseMap).toContain("supabase.rpc('verify_boundary'");
  });

  it('shows freedom-camping fields only for the freedom-camping service', () => {
    expect(manager).toContain("const isFreedomCamping = zoneForm.moduleKey === 'freedom_camping'");
    expect(manager).toContain('<WorkingZonePolicyEditor');
    expect(manager).toContain("['parking_enforcement', 'freedom_camping'].includes(zone.module_key)");
    expect(policy).toContain('Self-contained vehicle requirement applies');
    expect(policy).toContain('Parking policy');
    expect(policy).toContain("supabase.rpc('save_working_zone_policy'");
    expect(manager).toContain("p_scv_required: isFreedomCamping ? zoneForm.scv : false");
    expect(manager).toContain('What may officers or visitors do here?');
    expect(manager).not.toContain('<span>Rule</span>');
  });

  it('uses only governed place commands', () => {
    for (const rpc of ['get_crm_operational_place_editor', 'get_crm_operational_geography', 'manage_crm_site_profile', 'manage_crm_zone', 'manage_crm_zone_closure']) {
      expect(manager).toContain(rpc);
    }
    expect(manager).not.toMatch(/supabase\.from\(/);
  });

  it('sets a work area as part of another through the governed parent command, with its own save state', () => {
    expect(manager).toContain("supabase.rpc('set_location_zone_parent', { p_zone_id: zone.id, p_parent_zone_id: partOf || null, p_expected_version: zone.configuration_version })");
    expect(manager).toContain('partOfOptions(data.zones, zone.id)');
    expect(manager).toContain('<option value="">Not part of another area</option>');
    expect(manager).toContain('Save part of');
    expect(manager).toContain("partOfState === 'saving'");
    expect(manager).toContain("partOfState === 'saved'");
    expect(manager).toContain('The area could not be moved. Reload and try again.');
    expect(manager).toContain('orderZonesByParent(data.zones)');
  });

  it('never pairs an old Area settings draft with a newer version', () => {
    expect(manager).toContain('areaDraftSync(zoneDraft, zone)');
    expect(manager).toMatch(/\}, \[creatingZone, zone\?\.id, zone\?\.configuration_version\]\);/);
    expect(manager).not.toMatch(/\}, \[creatingZone, zone\]\);/);
    expect(manager).toContain('p_expected_version: creatingZone ? 0 : zoneDraft.zoneId === zone?.id ? zoneDraft.version : zone?.configuration_version ?? 0');
    expect(manager).toContain('This area changed since you started editing — reload to see the latest');
    expect(manager).toContain('Discard my changes and load the latest');
  });

  it('blocks "Save part of" while area or policy changes are unsaved', () => {
    expect(manager).toContain('onDirtyChange={setPolicyDirty}');
    expect(manager).toContain('const unsavedAreaChanges = zoneDirty || policyDirty;');
    expect(manager).toContain("disabled={unsavedAreaChanges || partOfState === 'saving' || partOf === (zone.parent_zone_id ?? '')}");
    expect(manager).toContain('Save or discard your area changes first');
    expect(policy).toContain('onDirtyChange?: (dirty: boolean) => void');
    expect(policy).toContain('Discard policy changes');
  });

  it('keeps area settings and rule saves from overwriting each other through the shared version', () => {
    expect(manager).toContain("disabled={busy || !zoneForm.name.trim() || (!creatingZone && policyDirty)}");
    expect(manager).toContain('if (!data || !zoneForm.name.trim() || (!creatingZone && policyDirty)) return;');
    expect(manager).toContain('Save or discard your rule changes first');
    expect(manager).toContain('saveBlockedReason={zoneDirty ? \'Save or discard your area settings first\' : null}');
    expect(policy).toContain('saveBlockedReason?: string | null');
    expect(policy).toContain('disabled={saving || !confirmed || !draft.source.trim() || Boolean(saveBlockedReason)}');
    expect(policy).toContain('if (!receipt || saving || saveBlockedReason) return;');
  });

  it('rebases the draft on the saved version when the reload after an area save fails', () => {
    expect(manager).toContain('if (!(await load(savedZone.id))) {');
    expect(manager).toContain("version: typeof savedZone.configuration_version === 'number' ? savedZone.configuration_version : current.version");
  });

  it('takes "Part of" from the place editor read, which lists every work area on the place', () => {
    expect(manager).toContain('parent_zone_id: item.parent_zone_id ?? null');
  });

  it('reports Saved only after the reload succeeds', () => {
    expect(manager).toContain('if (!(await load(zone.id))) {');
    expect(manager).toMatch(/const load = useCallback\(async \(preferredZoneId\?: string\): Promise<boolean> =>/);
  });

  it('labels user lifecycle and access commands', () => {
    for (const label of ['Resend', 'Reactivate', 'Deactivate', 'Edit user']) expect(users).toContain(label);
  });
});