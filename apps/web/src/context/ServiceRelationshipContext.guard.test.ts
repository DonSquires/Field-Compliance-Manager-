import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/context/ServiceRelationshipContext.tsx'), 'utf8');

describe('service relationship operational scope', () => {
  it('loads only active agreement-location links', () => {
    expect(source).toContain(".from('service_agreement_locations')");
    expect(source).toContain(".eq('status', 'active')");
  });

  it('derives zone agreement identity from the canonical link table', () => {
    expect(source).not.toContain("is_active, service_agreement_id')");
    expect(source).toContain("find((link) => link.zone_id === zone.id)?.service_agreement_id");
  });

  it('never selects the nonexistent zone agreement column', () => {
    expect(source).not.toMatch(/from\('location_zones'\)[\s\S]{0,180}service_agreement_id/);
  });

  it('keeps admin place selection manual and field place selection GPS-driven', () => {
    expect(source).toContain("locationMode !== 'gps'");
    expect(source).toContain("const [locationMode, setLocationMode] = useState<'manual' | 'gps'>('manual')");
    expect(source).toContain('setSelectedPlaceIds({ siteId: null, zoneId })');
    expect(source).toContain('setSelectedPlaceIds({ siteId, zoneId: null })');
    expect(source).toContain("supabase.rpc('resolve_context_authorized'");
    expect(source).toContain('if (matchedAgreementZone)');
    expect(source).toContain('if (matchedAgreementSite)');
    expect(source).not.toContain('setSelectedSiteId');
    expect(source).not.toContain('setSelectedZoneId');
  });
});