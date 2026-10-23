/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');
const manager = read('src/components/OperationalPlaceManager.tsx');
const houseMap = read('src/components/LocationHouseMap.tsx');
const workbench = read('src/pages/SiteBoundaryReviewPage.tsx');
const organizationSetup = read('src/pages/OrganizationSetupPage.tsx');
const siteDetail = read('src/pages/SiteDetailPage.tsx');
const zoneDetail = read('src/pages/ZoneDetailPage.tsx');

describe('human geofence UX policy', () => {
  it('keeps every editable place boundary on a visual map workflow', () => {
    expect(manager).toContain('<LocationHouseMap key={boundaryTarget}');
    expect(siteDetail).toContain('<LocationHouseMap');
    expect(zoneDetail).toContain('<LocationHouseMap');
    expect(workbench).toContain('L.map(');
    expect(workbench).toContain('Click at least three points on the map');
    expect(organizationSetup).toContain('L.map(');
    expect(organizationSetup).toContain('Boundary preview loaded');
    expect(houseMap).toContain('Draw the boundary');
    expect(houseMap).toContain('Confirm this boundary');
  });

  it('does not expose raw geometry or unexplained closure language in operational setup', () => {
    expect(manager).not.toContain('GeoJSON Polygon');
    expect(manager).not.toContain('manual_geojson');
    expect(manager).not.toContain('Create closure');
    expect(manager).toContain('Temporary restrictions');
    expect(manager).toContain('Use this for a storm, fire risk, event, maintenance, or temporary client instruction.');
  });

  it('uses human map labels instead of implementation terminology', () => {
    for (const label of ['Place boundary map', 'Verified boundary matched', 'Matched work area', 'Rules loaded', 'Temporary restriction']) {
      expect(houseMap).toContain(label);
    }
    for (const phrase of ['Geofence control spine', 'Runtime zone', 'Module trigger', 'Operational overlay', 'Geometry answers where']) {
      expect(houseMap).not.toContain(phrase);
    }
  });
});