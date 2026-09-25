import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const cctv = read('src/pages/CCTVImportPage.tsx');
const banner = read('src/components/PlaceContextBanner.tsx');
const relationships = read('src/context/ServiceRelationshipContext.tsx');
const observations = read('src/pages/ObservationSearchPage.tsx');
const rosterHr = read('src/pages/RosterHRPage.tsx');
const rosterTargets = read('src/pages/RosterTargetsPage.tsx');
const crm = read('src/pages/CRMPage.tsx');

describe('generic place selection policy', () => {
  it('offers site and zone facets on generic admin selectors', () => {
    expect(cctv).toContain('<PlaceFacetPicker');
    expect(cctv).toContain('p_site_id: siteId');
    expect(cctv).toContain('p_zone_id: zoneId');
    expect(banner).toContain('<optgroup label="Sites">');
    expect(banner).toContain('<optgroup label="Zones">');
    for (const outcome of ['outside_all_geofences', 'unresolved_no_geofence', 'unresolved_unverified', 'unresolved_invalid']) expect(banner).toContain(`${outcome}:`);
    expect(banner).toContain('visually verify this Site or Zone');
    expect(banner).not.toContain("locationStatus === 'outside_geofence'\n      ? 'Outside the selected service geofence'");
    expect(observations).toContain('<span>Site</span>');
    expect(observations).toContain('<span>Zone</span>');
    expect(observations).toContain("if (event.target.value) setNextZoneId('')");
    expect(observations).toContain("if (event.target.value) setNextSiteId('')");
    expect(rosterHr).toContain('siteInductionDraft.siteId');
    expect(rosterHr).toContain('siteInductionDraft.zoneId');
    expect(rosterTargets).toContain('site_id: string | null');
    expect(rosterTargets).toContain('zone_id: string | null');
    expect(crm).toContain("place.kind === 'Site' || place.kind === 'Zone'");
  });

  it('uses GPS geofence resolution only when a field shell opts in', () => {
    expect(relationships).toContain("locationMode !== 'gps'");
    expect(relationships).toContain("supabase.rpc('resolve_operational_context_authorized'");
    expect(relationships).toContain('matchedAgreementZone');
    expect(relationships).toContain('matchedAgreementSite');
  });
});