import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string) => {
  const local = resolve(process.cwd(), `supabase/migrations/${name}`);
  const root = existsSync(local) ? local : resolve(process.cwd(), `../../supabase/migrations/${name}`);
  return readFileSync(root, 'utf8');
};

const swap = read('20260907001900_direct_shift_swap_notifications.sql');
const notify = read('20260907002000_roster_change_notifications.sql');
const attendance = read('20260907002100_roster_attendance_exceptions.sql');
const templatePreview = read('20260907002200_preview_roster_templates.sql');
const batchPreview = read('20260907002300_preview_batch_publish.sql');
const repeat = read('20260907002400_repeat_roster_slot_range.sql');
const batchFailures = read('20260907002500_batch_publish_failure_audit.sql');
const attendanceAck = read('20260907002600_acknowledge_roster_attendance_exception.sql');
const skills = read('20260907002800_roster_skill_requirements.sql');
const skillCatalog = read('20260907002900_canonical_roster_skill_catalog.sql');
const skillIds = read('20260907003000_canonical_work_unit_skill_ids.sql');
const inductions = read('20260907003100_site_induction_requirements.sql');

const migrations = [swap, notify, attendance, templatePreview, batchPreview, repeat, batchFailures, attendanceAck, skills, skillCatalog, skillIds, inductions];

describe('new roster lifecycle migrations remain governed', () => {
  it('restricts every new executable function to authenticated and service roles', () => {
    for (const source of migrations.filter((source) => source !== notify)) {
      expect(source).toContain('revoke all on function');
      expect(source).toContain('grant execute on function');
      expect(source).not.toMatch(/grant execute on function[^;]+ to public/);
    }
    expect(notify).toContain('security definer');
  });

  it('keeps write actions actor and state protected', () => {
    expect(swap).toContain('Only the assigned officer can request a swap');
    expect(swap).toContain('not public.is_admin_for_org');
    expect(swap).toContain('v_swap.status <> p_expected_status');
    expect(repeat).toContain('not public.is_admin_for_org');
    expect(repeat).toContain("v_source.status in ('completed', 'cancelled')");
    expect(batchFailures).toContain('not public.is_admin_for_org');
    expect(attendanceAck).toContain('not public.is_admin_for_org');
  });

  it('bounds preview and repeat windows', () => {
    expect(templatePreview).toContain('p_to_date - p_from_date > 92');
    expect(repeat).toContain('p_to_date - p_from_date > 92');
    expect(batchPreview).toContain('p_from');
    expect(batchPreview).toContain('p_to');
  });

  it('retains audit and notification provenance', () => {
    expect(swap).toContain("'shift_swap_requested'");
    expect(swap).toContain('enqueue_notification');
    expect(notify).toContain('trg_notify_roster_slot_change');
    expect(notify).toContain('trg_notify_shift_change');
    expect(attendanceAck).toContain("'roster_attendance_exception_acknowledged'");
    expect(attendanceAck).toContain('enqueue_notification');
    expect(batchFailures).toContain("'roster_batch_publish_materialization_failed'");
  });

  it('enforces current required skills at roster slot write time', () => {
    expect(skills).toContain('required_skill_names');
    expect(skills).toContain('manage_roster_work_unit_skill_requirements');
    expect(skills).toContain('tg_enforce_roster_slot_skill_requirements');
    expect(skills).toContain('certification_expiry >= current_date');
    expect(skills).toContain('Assigned staff member lacks required current skill');
  });

  it('provides canonical organization-scoped skill catalog and staff assignment', () => {
    expect(skillCatalog).toContain('create table if not exists public.roster_skill_catalog');
    expect(skillCatalog).toContain('skill_key text not null');
    expect(skillCatalog).toContain('skill_id uuid references public.roster_skill_catalog');
    expect(skillCatalog).toContain('manage_roster_skill_catalog');
    expect(skillCatalog).toContain('assign_roster_skill_to_staff');
    expect(skillCatalog).toContain('is_admin_for_org');
  });

  it('supports stable canonical skill IDs on work-unit requirements', () => {
    expect(skillIds).toContain('required_skill_ids');
    expect(skillIds).toContain('manage_roster_work_unit_skill_ids');
    expect(skillIds).toContain('skill.skill_id = v_required_id');
    expect(skillIds).toContain('required_skill_names');
  });

  it('keeps site induction separate from global skills', () => {
    expect(inductions).toContain('create table if not exists public.site_induction_requirements');
    expect(inductions).toContain('create table if not exists public.staff_site_inductions');
    expect(inductions).toContain('service_agreement_location_id');
    expect(inductions).toContain('get_site_induction_state');
    expect(inductions).toContain('expires_at');
    expect(inductions).toContain('manage_site_induction_requirement');
    expect(inductions).toContain('record_staff_site_induction');
    expect(inductions).toContain('is_admin_for_org');
    expect(inductions).toContain('has_location_access');
    expect(inductions).toContain('sa.provider_organization_id = v_org');
  });

  it('enforces required site inductions at roster slot write time', () => {
    expect(inductions).toContain('tg_enforce_roster_slot_site_induction_requirements');
    expect(inductions).toContain('site_induction_requirements');
    expect(inductions).toContain('Assigned staff member lacks required current site induction');
    expect(inductions).toContain('before insert or update of staff_id, work_unit_id');
  });
});
