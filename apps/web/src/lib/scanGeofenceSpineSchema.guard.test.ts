/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260831085000_scan_geofence_context.sql'), 'utf8');
const operationalContext = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901020000_resolve_contracted_operational_context.sql'), 'utf8');
const scan = readFileSync(resolve(process.cwd(), '../../supabase/functions/process-officer-scan/index.ts'), 'utf8');

describe('officer scan geofence spine', () => {
  it('adds durable geofence evidence to both scan fact tables', () => {
    expect(migration).toContain('observations add column if not exists geofence_context jsonb');
    expect(migration).toContain('parking_chalk_records add column if not exists geofence_context jsonb');
    expect(scan.match(/geofence_context: geofenceContext/g)).toHaveLength(2);
    expect(migration).toContain('preserve_scan_geofence_context');
    expect(migration).toContain("raise exception 'Captured geofence context is immutable'");
    expect(migration.match(/before update of geofence_context/g)).toHaveLength(2);
  });

  it('resolves closure state after every zone match and fails closed on lookup errors', () => {
    expect(scan).toContain("error: 'Geofence context could not be resolved'");
    expect(scan).toContain("supabase.rpc('resolve_operational_context'");
    expect(scan).toContain("supabase.rpc('is_zone_closed'");
    expect(scan).toContain("error: 'Zone closure state could not be resolved'");
    expect(scan).toContain("resolution_source: manualZoneId ? 'manual_zone' : 'resolve_operational_context'");
  });

  it('prevents manual Zone selection from bypassing tenant and geofence gates', () => {
    expect(scan).toContain("if (manualZoneId) zoneQuery = zoneQuery.eq('organization_id', orgId)");
    expect(scan).toContain("zoneData.boundary_verification !== 'verified'");
    expect(scan).toContain('zoneData.module_key !== moduleKey');
    expect(scan).toContain("supabase.rpc('_geofence_active_at'");
    expect(scan).toContain("error: 'Selected Zone is not active at the capture time'");
    expect(scan).toContain('spatial_resolution_evaluated: !manualZoneId');
  });

  it('resolves only active contracted places for provider field operations', () => {
    expect(operationalContext).toContain('from public.resolve_context(p_lat,p_lng,p_org_id,p_module_key,p_at)');
    expect(operationalContext).toContain("sa.invitation_status='accepted'");
    expect(operationalContext).toContain("sal.status='active'");
    expect(operationalContext).toContain('sam.enabled');
    expect(operationalContext).toContain('sal.zone_id=rc.matched_zone_id');
    expect(operationalContext).toContain('to service_role');
  });

  it('rejects scans without defensible spatial evidence', () => {
    expect(scan).toContain("error: 'A manual Zone or complete GPS coordinates are required'");
    expect(scan).toContain("error: 'gps_lat and gps_lng must be a complete valid coordinate pair'");
    expect(scan).toContain('Number(gpsLat) < -90');
    expect(scan).toContain('Number(gpsLng) > 180');
  });

  it('returns closure evidence without rewriting module verdict semantics', () => {
    expect(scan.match(/zone_closed: zoneClosure\?\.closed === true/g)).toHaveLength(2);
    expect(scan.match(/zone_closure: zoneClosure/g)).toHaveLength(2);
    expect(scan).not.toContain("compliance.reason = 'zone_closed'");
    expect(scan).not.toContain("parkingCompliance.verdict = 'zone_closed'");
  });
});