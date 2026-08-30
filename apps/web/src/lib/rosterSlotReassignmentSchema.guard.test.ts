import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260830132000_reassign_roster_slot.sql'), 'utf8');
const schema = readFileSync(resolve(process.cwd(), '../../supabase/schema.sql'), 'utf8');

describe('admin roster slot reassignment', () => {
  it('authorizes and race-checks a limited slot lifecycle', () => {
    expect(sql).toContain('public.is_admin_for_org');
    expect(sql).toContain('v_slot.status<>p_expected_status');
    expect(sql).toContain("v_slot.status not in('draft','published','accepted','declined')");
    expect(sql).toContain('Reassignment reason is required');
    expect(schema).toContain('CREATE FUNCTION "public"."reassign_roster_slot"');
  });

  it('checks replacement readiness, leave, and both planning conflicts', () => {
    expect(sql).toContain('sp.work_ready');
    expect(sql).toContain("l.status='approved'");
    expect(sql).toContain('overlapping roster slot');
    expect(sql).toContain('overlapping field shift');
  });

  it('blocks runtime evidence and synchronizes linked field ownership', () => {
    expect(sql).toContain('v_shift.actual_start is not null');
    expect(sql).toContain('Active dispatch work prevents reassignment');
    expect(sql).toContain('Recorded field activity prevents reassignment');
    expect(sql).toContain("officer_user_id=v_staff.user_id,status='published'");
    expect(sql).toContain("'roster_slot_reassigned'");
  });
});