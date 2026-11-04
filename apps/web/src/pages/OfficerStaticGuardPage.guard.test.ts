import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const shell = readFileSync(resolve(process.cwd(), 'src/shells/OfficerShell.tsx'), 'utf8');
const home = readFileSync(resolve(process.cwd(), 'src/pages/OfficerHomePage.tsx'), 'utf8');
const page = readFileSync(resolve(process.cwd(), 'src/pages/OfficerStaticGuardPage.tsx'), 'utf8');
const privateBriefing = readFileSync(resolve(process.cwd(), 'src/lib/officerStaticBriefing.ts'), 'utf8');
const startGateMigration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20261104214253_static_arrival_requires_started_shift.sql'), 'utf8');
const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901014000_static_guard_post_attendance.sql'), 'utf8');
const shiftUpdateFix = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901015000_fix_static_guard_shift_updates.sql'), 'utf8');
const rehydrationMigration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901016000_rehydrate_static_guard_evidence.sql'), 'utf8');
const boundaryMigration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901017000_enforce_static_guard_site_boundary.sql'), 'utf8');

describe('officer static guarding post', () => {
  it('routes static assignments to a dedicated post workspace', () => {
    expect(shell).toContain("case 'site_guard':");
    expect(shell).toContain('return <OfficerStaticGuardPage />');
    expect(home).toContain("normalized === 'static_guarding'");
    expect(home).toContain("return { destination: 'site_guard'");
    expect(shell).not.toMatch(/case 'site_guard':[\s\S]{0,120}<OfficerDispatchPage/);
  });

  it('uses private governed reads and attendance RPCs without direct stop mutation', () => {
    expect(page).toContain('await fetchOfficerStaticBriefing(requestedShiftId)');
    expect(privateBriefing).toContain("supabase.functions.invoke('officer-shift-briefing'");
    expect(page).not.toContain("supabase.rpc('get_officer_static_post'");
    expect(page).toContain('const next = parseStaticPost(data.post)');
    expect(page).toContain('Static post data was incomplete');
    expect(page).not.toContain('p_zone_ids:');
    expect(page).not.toContain("p_module_key: 'site_guard'");
    expect(page).toContain('p_shift_id: requestedShiftId');
    expect(page).toContain('EndShiftDialog');
    expect(page).not.toMatch(/from\('shift_stops'\)[\s\S]{0,300}\.(insert|update|delete)\(/);
    expect(page).not.toContain("supabase.rpc('manage_officer_static_post'");
    expect(page).toContain('no separate on-site or off-site button');
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
    expect(startGateMigration).toContain("v_shift.status<>'in_progress' or v_shift.actual_start is null");
    expect(startGateMigration).not.toContain("update public.shifts set status='in_progress'");
  });

  it('rehydrates durable attendance evidence and suppresses invalid actions from persisted state', () => {
    expect(rehydrationMigration).toContain("from public.shift_stop_actions a where a.shift_stop_id=v_stop.id and a.action_type='static_post_arrived'");
    expect(rehydrationMigration).toContain("a.action_type='static_post_departed'");
    expect(rehydrationMigration).toContain("'attendance_evidence',jsonb_build_object('arrival',v_arrival_receipt,'departure',v_departure_receipt)");
    expect(page).toContain('post.attendance_evidence.arrival.reference');
    expect(page).toContain('post.attendance_evidence.departure.reference');
    expect(page).toContain("post.shift.status === 'in_progress'");
    expect(page).toContain('next.shift.id !== requestedShiftId');
  });

  it('rejects off-site transitions before state or evidence changes', () => {
    expect(boundaryMigration).toContain("s.boundary_verification='verified'");
    expect(boundaryMigration).toContain('st_covers(s.boundary,p.geometry)');
    expect(boundaryMigration).toContain('st_dwithin(coalesce(s.center_point,s.boundary)::geography');
    expect(boundaryMigration).toContain('Current position is outside the assigned site boundary');
    expect(boundaryMigration.indexOf('Current position is outside the assigned site boundary')).toBeLessThan(boundaryMigration.indexOf("update public.shift_stops set status='on_scene'"));
    expect(boundaryMigration).toContain("'gps_result',v_geofence_result");
    expect(boundaryMigration).toContain("'geofence_result',v_geofence_result");
  });
});
