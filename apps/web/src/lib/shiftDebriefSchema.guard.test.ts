import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260830124000_shift_debriefs.sql'), 'utf8');

describe('shift debrief contract', () => {
  it('creates one append-only debrief per canonical shift', () => {
    expect(migration).toContain('unique (shift_id)');
    expect(migration).toContain('Shift completion remains a separate lifecycle truth');
    expect(migration).not.toContain('create policy shift_debriefs_update');
    expect(migration).not.toContain('create policy shift_debriefs_delete');
  });
  it('derives officer identity, verifies ownership, and deduplicates retries', () => {
    expect(migration).toContain('v_user_id uuid := auth.uid()');
    expect(migration).toContain('v_shift.officer_user_id <> v_user_id');
    expect(migration).toContain('client_event_id = p_client_event_id');
  });
  it('requires meaningful handover and follow-up context before auditing', () => {
    expect(migration).toContain('between 10 and 5000');
    expect(migration).toContain("raise exception 'Follow-up notes are required'");
    expect(migration).toContain("'shift_debrief_submitted'");
  });
});