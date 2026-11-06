import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../../supabase/migrations/20261107170000_supervisor_close_unfinished_shift.sql'),
  'utf8',
);
const page = readFileSync(resolve(process.cwd(), 'src/pages/DispatchConsolePage.tsx'), 'utf8');

describe('close unfinished officer shift', () => {
  it('is an admin-only, replay-safe RPC with an audit receipt', () => {
    expect(migration).toContain('public.is_admin_for_org(v_shift.organization_id)');
    expect(migration).toContain("al.action = 'shift_supervisor_close'");
    expect(migration).toContain('Shift changed since it was opened');
    expect(migration).toContain("'previous', v_previous");
    expect(migration).toContain("'resulting', v_resulting");
    expect(migration).toContain("SET search_path = ''");
    expect(migration).toContain('FROM PUBLIC, anon');
  });

  it('closes at a recorded time bounded by the start and now', () => {
    expect(migration).toContain('The end time must be after the shift started');
    expect(migration).toContain('The end time cannot be in the future');
    expect(migration).toContain("ended_reason = 'supervisor_closed'");
    expect(migration).toContain("'supervisor_closed'])");
  });

  it('refuses to hide open dispatch work or welfare alerts', () => {
    expect(migration).toContain("Complete or cancel this shift''s dispatch jobs before closing it");
    expect(migration).toContain("Resolve this shift''s welfare alerts before closing it");
  });

  it('offers the close action only for a started shift in the run sheet', () => {
    expect(page).toContain("supabase.rpc('close_unfinished_officer_shift'");
    expect(page).toContain("selectedShift.status === 'in_progress' && selectedShift.actualStart");
    expect(page).toContain('Shift ended at');
    expect(page).toContain('type="datetime-local"');
  });
});
