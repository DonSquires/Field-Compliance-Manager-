import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/ZoneDetailPage.tsx'), 'utf8');
const migration = readFileSync(
  resolve(process.cwd(), '../../supabase/migrations/20261015085340_govern_parking_zone_rule_authoring.sql'),
  'utf8',
);
const scan = readFileSync(
  resolve(process.cwd(), '../../supabase/functions/process-officer-scan/index.ts'),
  'utf8',
);
const schema = readFileSync(resolve(process.cwd(), '../../supabase/schema.sql'), 'utf8');

describe('source-backed Parking zone rules', () => {
  it('routes the zone workspace through the governed optimistic command', () => {
    expect(page).toContain("rpc('manage_parking_zone_rule'");
    expect(page).toContain('p_client_request_id: parkingRequestId');
    expect(page).toContain('p_expected_version: selected.configuration_version');
    expect(page).toContain("p_limit_source: 'manual'");
    expect(page).toMatch(/storage\s*\.from\('scans'\)/);
    expect(page).toContain('I checked the entered limit and disabled-bay multiplier against the photographed sign.');
    expect(page).toContain('Keep current rule');
    expect(page).not.toMatch(/from\(['"]location_zones['"]\)\.(?:update|upsert|delete)/);
  });

  it('requires private image evidence and retains replay plus previous/resulting receipts', () => {
    expect(migration).toContain('Parking signage photo evidence is required');
    expect(migration).toMatch(/object\.metadata ->> 'mimetype'[\s\S]*'image\/jpeg'[\s\S]*'image\/png'[\s\S]*'image\/webp'/);
    expect(migration).toContain("metadata ->> 'client_request_id' = p_client_request_id::text");
    expect(migration).toContain("'previous', v_before");
    expect(migration).toContain("'resulting', jsonb_build_object(");
    expect(migration).toContain('resulting_configuration_version');
    expect(migration).toContain('configuration_version <> p_expected_version');
  });

  it('returns rule readiness to the workspace and the field scanner consumes the same zone rule', () => {
    for (const field of [
      'zone.parking_time_limit_minutes',
      'zone.parking_disabled_multiplier',
      'zone.parking_signage_photo_url',
      'zone.parking_limit_source',
      'zone.parking_limit_set_at',
    ]) {
      expect(migration).toContain(field);
    }
    expect(scan).toContain("rpc('evaluate_parking_compliance'");
    expect(schema).toMatch(/SELECT parking_time_limit_minutes, parking_disabled_multiplier INTO v_legacy_zone_limit, v_legacy_multiplier/);
    expect(schema).toMatch(/v_effective_limit := COALESCE\(p_sign_time_limit_minutes, v_rule\.time_limit_minutes, v_legacy_zone_limit/);
  });
});
