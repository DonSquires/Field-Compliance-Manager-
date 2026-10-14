import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../../supabase/migrations/20261014222834_harden_dispatch_runsheet_controls.sql'),
  'utf8',
);
const page = readFileSync(resolve(process.cwd(), 'src/pages/DispatchConsolePage.tsx'), 'utf8');

describe('dispatch runsheet controls', () => {
  it('uses request identity, row locks, and optimistic timestamps', () => {
    expect(migration).toContain('p_client_request_id uuid');
    expect(migration).toContain('p_expected_updated_at timestamptz');
    expect(migration).toContain('ORDER BY ss.stop_order, ss.id');
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain('Shift stop changed since it was opened');
    expect(migration).toContain('Shift changed since it was opened');
  });

  it('replays completed requests before rejecting stale source state', () => {
    const stopReplay = migration.indexOf("al.metadata ->> 'client_request_id' = p_client_request_id::text");
    const stopConflict = migration.indexOf("v_stop.updated_at IS DISTINCT FROM p_expected_updated_at");
    const shiftReplay = migration.lastIndexOf("al.metadata ->> 'client_request_id' = p_client_request_id::text");
    const shiftConflict = migration.indexOf("v_shift.updated_at IS DISTINCT FROM p_expected_updated_at");
    expect(stopReplay).toBeGreaterThan(-1);
    expect(stopReplay).toBeLessThan(stopConflict);
    expect(shiftReplay).toBeGreaterThan(-1);
    expect(shiftReplay).toBeLessThan(shiftConflict);
    expect(migration).toContain('idx_audit_dispatch_runsheet_request');
    expect(migration).toContain("'replayed', true");
  });

  it('moves the selected stop while preserving route order', () => {
    expect(migration).toContain('The stop is already in that position');
    expect(migration).toContain('The shift route already has duplicate stop positions');
    expect(migration).toContain('The shift route has non-contiguous stop positions');
    expect(migration).toContain('ss.stop_order + 1');
    expect(migration).toContain('ss.stop_order - 1');
    expect(migration).toContain('stop_order = p_new_order');
  });

  it('records before and after evidence under least privilege', () => {
    expect(migration).toContain("'previous', v_previous");
    expect(migration).toContain("'resulting', v_resulting");
    expect(migration).toContain("SET search_path = ''");
    expect(migration).toContain('FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('TO authenticated, service_role');
  });

  it('uses explicit callers and a visible receipt workflow instead of prompts', () => {
    expect(page).toContain("supabase.rpc('manage_shift_stop'");
    expect(page).toContain("supabase.rpc('manage_active_shift'");
    expect(page).not.toContain('window.prompt');
    expect(page).toContain('New route position');
    expect(page).toContain('Updated shift note');
    expect(page).toContain('writes a before-and-after audit receipt');
    expect(page).toContain('replayed safely');
  });
});
