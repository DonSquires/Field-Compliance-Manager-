import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260830111000_officer_breadcrumb_timeline.sql'), 'utf8');

describe('officer breadcrumb evidence schema', () => {
  it('derives officer and organization identity from auth and deduplicates device events', () => {
    expect(migration).toContain('v_user_id uuid := auth.uid()');
    expect(migration).toContain('client_event_id = p_client_event_id');
    expect(migration).toContain('idx_officer_gps_log_client_event');
  });

  it('restricts direct officer inserts to self and validates capture provenance', () => {
    expect(migration).toContain('officer_id = auth.uid()');
    expect(migration).toContain("role in ('officer', 'scan_operator')");
    expect(migration).toContain('recorded_at is outside the accepted capture window');
    expect(migration).toContain('Shift does not belong to the authenticated officer');
  });

  it('normalizes persistent source records through an authorized read-only timeline', () => {
    expect(migration).toContain('get_officer_activity_timeline');
    expect(migration).toContain('not public.is_admin_for_org(v_org_id)');
    for (const source of ['officer_gps_log', 'welfare_checks', 'observations', 'patrol_checkpoint_visits', 'officer_field_reports', 'shift_stop_actions']) {
      expect(migration).toContain(source);
    }
  });
});