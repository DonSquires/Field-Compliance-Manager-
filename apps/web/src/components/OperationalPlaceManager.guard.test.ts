/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const manager = readFileSync(resolve(process.cwd(), 'src/components/OperationalPlaceManager.tsx'), 'utf8');
const houseMap = readFileSync(resolve(process.cwd(), 'src/components/LocationHouseMap.tsx'), 'utf8');
const locations = readFileSync(resolve(process.cwd(), 'src/pages/LocationsPage.tsx'), 'utf8');
const zones = readFileSync(resolve(process.cwd(), 'src/pages/ZoneDetailPage.tsx'), 'utf8');
const users = readFileSync(resolve(process.cwd(), 'src/pages/UserManagementPage.tsx'), 'utf8');

describe('human operational controls', () => {
  it('exposes one guided manager from locations and zones', () => {
    expect(locations).toContain('Manage location');
    expect(zones).toContain('Manage selected zone');
    expect(locations).toContain('<OperationalPlaceManager');
    expect(zones).toContain('<OperationalPlaceManager');
  });

  it('uses plain-language steps and explains temporary restrictions', () => {
    for (const label of ['1. Site briefing', '2. Work areas', '3. Map boundaries', '4. Temporary restrictions', 'Save site briefing', 'Add work area', 'Schedule restriction', 'End restriction now']) {
      expect(manager).toContain(label);
    }
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
    expect(manager).toContain('{isFreedomCamping && <fieldset');
    expect(manager).toContain('Self-contained vehicle requirement applies');
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

  it('labels user lifecycle and access commands', () => {
    for (const label of ['Resend', 'Reactivate', 'Deactivate', 'Edit user']) expect(users).toContain(label);
  });
});