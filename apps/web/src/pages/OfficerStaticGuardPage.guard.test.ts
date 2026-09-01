import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const shell = readFileSync(resolve(process.cwd(), 'src/shells/OfficerShell.tsx'), 'utf8');
const home = readFileSync(resolve(process.cwd(), 'src/pages/OfficerHomePage.tsx'), 'utf8');
const page = readFileSync(resolve(process.cwd(), 'src/pages/OfficerStaticGuardPage.tsx'), 'utf8');
const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901014000_static_guard_post_attendance.sql'), 'utf8');
const shiftUpdateFix = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901015000_fix_static_guard_shift_updates.sql'), 'utf8');

describe('officer static guarding post', () => {
  it('routes static assignments to a dedicated post workspace', () => {
    expect(shell).toContain("case 'site_guard':");
    expect(shell).toContain('return <OfficerStaticGuardPage />');
    expect(home).toContain("shift.shift_type === 'static_guarding' ? 'site_guard'");
    expect(shell).not.toMatch(/case 'site_guard':[\s\S]{0,120}<OfficerDispatchPage/);
  });

  it('uses governed read and attendance RPCs without direct stop mutation', () => {
    expect(page).toContain("supabase.rpc('get_officer_static_post'");
    expect(page).toContain("supabase.rpc('manage_officer_static_post'");
    expect(page).not.toMatch(/from\('shift_stops'\)[\s\S]{0,300}\.(insert|update|delete)\(/);
    expect(page).toContain('p_gps_accuracy_metres: position.accuracy');
    expect(page).toContain("p_action: 'depart'");
    expect(page).not.toContain('GPS verified');
  });

  it('locks lifecycle changes to the owning officer and expected stop state', () => {
    expect(migration).toContain('v_shift.officer_user_id<>v_actor');
    expect(migration).toContain("v_stop.module_key<>'static_guarding'");
    expect(migration).toContain('v_stop.status<>p_expected_status');
    expect(migration).toContain("p_action not in('arrive','depart')");
    expect(migration).toContain("sam.module_key='static_guarding'");
    expect(migration).toContain("when s.status='in_progress' then 0");
    expect(migration).toContain('when now() between s.scheduled_start and s.scheduled_end then 1');
    expect(migration).toContain('case when s.scheduled_start>now() then s.scheduled_start end');
  });

  it('starts and completes attendance, module work, and auditable receipts atomically', () => {
    expect(migration).toContain("status='on_scene'");
    expect(migration).toContain("status='in_progress'");
    expect(migration).toContain("status='completed'");
    expect(migration).toContain("sm.status not in('completed','skipped')");
    expect(migration).toContain("'static_post_arrived'");
    expect(migration).toContain("'static_post_departed'");
    expect(migration).toContain('Departure notes are required');
    expect(migration).toContain('client_request_id=p_request_id');
    expect(migration).toContain('shift_stop_actions_org_request_uidx');
    expect(migration).toContain("'capture_method','browser_geolocation'");
    expect(migration).toContain("'reference','SG-'");
    expect(shiftUpdateFix).toContain("update public.shifts set status='in_progress',actual_start=coalesce(actual_start,v_at)");
    expect(shiftUpdateFix).toContain('update public.shifts set completed_stops=');
    expect(shiftUpdateFix).not.toMatch(/update public\.shifts set[^;]*updated_at/);
  });
});
