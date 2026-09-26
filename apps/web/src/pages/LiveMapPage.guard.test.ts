import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/LiveMapPage.tsx'), 'utf8');

describe('live officer safety layer', () => {
  it('gates welfare reads and rendering through the shared safety contract', () => {
    expect(source).toContain("isModuleEnabled('welfare', { safetyRelevant: true })");
    expect(source).toContain('<SafetyGate');
    expect(source).toContain('if (welfareEnabled)');
  });

  it('reads the live picture through one governed RPC for the operating branch, never the raw tables', () => {
    expect(source).toContain("supabase.rpc('get_live_officer_positions', { p_organization_id: branchId, p_since_minutes: 240, p_zone_ids: zoneIds })");
    expect(source).not.toContain(".from('officer_gps_log')");
    expect(source).not.toContain(".from('welfare_alerts')");
    expect(source).not.toContain(".from('officer_welfare_settings')");
    expect(source).toContain('deriveAdminSafetyStatus');
    expect(source).toContain('deriveOfficerPinStatus');
  });

  it('keeps tenant filters on the realtime paths and re-reads through the RPC on every change', () => {
    expect(source).toContain("table: 'officer_gps_log', filter: `organization_id=eq.${orgId}` }, () => void loadPositions())");
    expect(source).toContain("table: 'welfare_alerts', filter: `organization_id=eq.${orgId}` }, () => void loadPositions())");
  });

  it('never labels an unavailable safety state as ok', () => {
    expect(source).toContain('Safety unavailable');
    expect(source).toContain('status-unknown');
  });

  it('clears loading state when the operating branch is unavailable', () => {
    expect(source).toContain("if (!branchId) { setPicture(null); setError('Operating branch access could not be confirmed. Live positions are unavailable.'); setLoading(false); return; }");
  });

  it('plots dispatch jobs at either their Site centre or Zone centre', () => {
    expect(source).toContain('zone:zone_id(name, center_point)');
    expect(source).toContain('site: site ?? (zone ?');
    expect(source).toContain('gps_lat: point?.[1] ?? null');
  });
});