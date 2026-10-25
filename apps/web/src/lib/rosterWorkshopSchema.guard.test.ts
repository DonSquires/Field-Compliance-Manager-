import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(import.meta.dirname, '../../../../supabase/migrations/20261029130000_roster_workshop_work_units.sql'), 'utf8');
describe('work-order-backed roster labour', () => {
  it('keeps an organisation-scoped foreign key and a single roster unit per order', () => {
    expect(sql).toContain('FOREIGN KEY (organization_id, workshop_work_order_id)');
    expect(sql).toContain('CREATE UNIQUE INDEX roster_work_units_workshop_order_key');
    expect(sql).toContain("work_unit_type = 'workshop'");
    expect(sql).toContain('workshop_work_order_id IS NOT NULL');
  });
  it('uses branch administrator authority and derives the service from the source order', () => {
    expect(sql).toContain('public.user_can_operate_organization(p_operating_organization_id)');
    expect(sql).toContain('public.is_admin_for_org(p_operating_organization_id)');
    expect(sql).toContain("'workshop', v_order.kind, v_order.id");
    expect(sql).toContain('Approve an open Workshop work order before rostering its labour');
  });
  it('updates every field-shift publication entry point rather than only the create button', () => {
    for (const name of ['batch_publish_roster_slots', 'finalize_shift_coverage', 'preview_batch_publish_roster_slots', 'reassign_roster_slot', 'respond_to_overtime_offer', 'materialize_roster_slot_core']) {
      expect(sql).toContain(`FUNCTION "public"."${name}"`);
    }
    expect(sql).not.toMatch(/work_unit_type\s*<>\s*'internal'/);
    expect(sql).toContain('Only patrol and static roster slots materialize field shifts');
  });
  it('keeps payroll separate from existing patrol and workshop invoices', () => {
    expect(sql).toContain("'billed_via_work_order'");
    expect(sql).toContain("'billed_via_patrol_log'");
    expect(sql).toContain('bill on not historical.yes');
  });
});
