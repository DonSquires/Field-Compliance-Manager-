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

const migrations = [swap, notify, attendance, templatePreview, batchPreview, repeat, batchFailures, attendanceAck];

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
});
