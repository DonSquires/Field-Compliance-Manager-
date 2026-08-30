import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260830125000_submit_officer_field_report.sql'), 'utf8');

describe('officer field report capture', () => {
  it('derives active officer identity and deduplicates client events', () => {
    expect(migration).toContain('v_user_id uuid := auth.uid()');
    expect(migration).toContain("role in ('officer', 'admin_officer')");
    expect(migration).toContain('idx_officer_field_reports_client_event');
    expect(migration).toContain('r.client_event_id = p_client_event_id');
  });
  it('validates capture time, GPS pairing, shift ownership, and follow-up context', () => {
    expect(migration).toContain('reported_at is outside the accepted capture window');
    expect(migration).toContain("raise exception 'Both GPS coordinates are required together'");
    expect(migration).toContain('s.officer_user_id = v_user_id');
    expect(migration).toContain("raise exception 'Follow-up notes are required'");
  });
  it('submits canonical status and records an audit receipt', () => {
    expect(migration).toContain("'submitted'");
    expect(migration).toContain("'officer_field_report_submitted'");
  });
});