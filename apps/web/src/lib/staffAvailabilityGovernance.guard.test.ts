import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../../supabase/migrations/20261015011658_govern_staff_availability.sql'),
  'utf8',
);
const page = readFileSync(resolve(process.cwd(), 'src/pages/RosterOperationsPage.tsx'), 'utf8');
const css = readFileSync(resolve(process.cwd(), 'src/pages/RosterOperationsPage.css'), 'utf8');

describe('governed staff availability', () => {
  it('enforces canonical schedule shape and removes direct browser mutation', () => {
    expect(migration).toContain('staff_availability_schedule_xor');
    expect(migration).toContain('staff_availability_day_range');
    expect(migration).toContain('staff_availability_type_check');
    expect(migration).toContain('staff_availability_time_check');
    expect(migration).toContain('REVOKE ALL ON TABLE public.staff_availability FROM PUBLIC, anon, authenticated, service_role');
    expect(migration).toContain('GRANT SELECT ON TABLE public.staff_availability TO authenticated');
    expect(migration).not.toContain('GRANT INSERT ON TABLE public.staff_availability TO authenticated');
  });

  it('replays requests before mutation and binds deletion to the selected staff member', () => {
    const replay = migration.indexOf("al.metadata ->> 'client_request_id' = p_client_request_id::text");
    const insert = migration.indexOf('INSERT INTO public.staff_availability');
    expect(replay).toBeGreaterThan(-1);
    expect(replay).toBeLessThan(insert);
    expect(migration).toContain('idx_audit_staff_availability_request');
    expect(migration).toContain('AND sa.staff_id = v_staff.id');
    expect(migration).toContain("'record', to_jsonb(v_avail)");
    expect(migration).toContain('A removal reason is required');
  });

  it('provides a deliberate configuration, correction, and receipt workflow', () => {
    expect(page).toContain("supabase.rpc('manage_staff_availability'");
    expect(page).toContain('Staff availability saved with an audit receipt.');
    expect(page).toContain('Availability record removed with an audit receipt.');
    expect(page).toContain('Keep record');
    expect(page).toContain('Confirm removal');
    expect(page).toContain('Approved leave remains governed in People.');
    expect(page).toContain('openAvailabilityDialog(person, isoDate(day))');
    expect(page).not.toContain('availabilityOccurrences.map(({ day, person, record }, index) => <button type="button" onClick={() => openCreate(person, day)}');
  });

  it('keeps the configuration usable on narrow screens', () => {
    expect(css).toContain('@media (max-width: 680px)');
    expect(css).toContain('.roster-availability-grid');
    expect(css).toContain('grid-template-columns: 1fr');
  });
});
