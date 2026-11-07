import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(process.cwd(), 'supabase/migrations/20260904150000_bob_roster_plan_governance.sql');
const migration = readFileSync(existsSync(migrationPath) ? migrationPath : resolve(process.cwd(), '../../supabase/migrations/20260904150000_bob_roster_plan_governance.sql'), 'utf8');
const page = readFileSync(resolve(process.cwd(), 'src/pages/RosterOperationsPage.tsx'), 'utf8');

describe('governed Bob roster plans', () => {
  it('keeps Bob output in a separate plan ledger with editable slot evidence', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.bob_roster_plans');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.bob_roster_plan_slots');
    expect(migration).toContain("status IN ('applied', 'rolled_back')");
  });

  it('ranks only eligible open slots and never publishes them', () => {
    expect(migration).toContain('get_bob_roster_fill_candidates');
    expect(migration).toContain("slot.status = 'draft'");
    expect(migration).toContain('slot.staff_id is null');
    expect(migration).toContain('staff_fatigue_conflict');
    expect(migration).toContain('staff_has_roster_availability_conflict');
    expect(migration).not.toContain("status = 'published'");
  });

  it('rejects stale or human-edited slots during Bob application and rollback', () => {
    expect(migration).toContain('Only approved apply_roster_fill_plan actions can be executed');
    expect(migration).toContain("v_slot.status <> 'draft' or v_slot.staff_id is not null");
    expect(migration).toContain('it cannot be rolled back automatically');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.apply_bob_roster_fill_plan');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.rollback_bob_roster_fill_plan');
  });

  it('exposes separate human edit and publish controls', () => {
    expect(page).toContain('const openEdit = (slot: RosterSlot)');
    expect(page).toContain("selectedSlot.status === 'draft' && selectedSlot.staff_id && <button type=\"button\" onClick={() => openEdit(selectedSlot)}>Edit draft</button>");
    expect(page).toContain('update_roster_slot');
    expect(page).toContain("setSlotAction('publish')");
  });
});
