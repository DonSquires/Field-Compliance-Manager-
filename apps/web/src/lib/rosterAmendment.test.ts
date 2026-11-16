import { describe, expect, it } from 'vitest';
import { readRosterEditContext, readRosterAmendmentReceipt } from './rosterAmendment';

const id = '11111111-1111-4111-8111-111111111111';
const timestamp = '2026-11-16T00:00:00.123456+00:00';
const slot = {
  id, organization_id: id, work_unit_id: id, staff_id: id, linked_shift_id: id,
  scheduled_start: timestamp, scheduled_end: '2026-11-16T08:00:00Z', updated_at: timestamp,
  status: 'accepted', notes: null, planned_break_minutes: 20, break_unpaid: true,
};
const shift = {
  id, organization_id: id, officer_user_id: id, status: 'in_progress',
  actual_start: timestamp, actual_end: null, updated_at: timestamp,
};
describe('roster amendment API evidence', () => {
  it('requires matching linked attendance, fresh versions and a complete live safety preview', () => {
    const context = { slot, shift, work_unit: { id, name: 'Synthetic unit', work_unit_type: 'static' },
      contact: null, finish_preview: { open_dispatch_jobs: 1, open_welfare_alerts: 0 } };
    expect(readRosterEditContext(context)).not.toBeNull();
    expect(readRosterEditContext({ ...context, finish_preview: null })).toBeNull();
    expect(readRosterEditContext({ ...context, shift: null })).toBeNull();
    expect(readRosterEditContext({ ...context, slot: { ...slot, updated_at: undefined } })).toBeNull();
    expect(readRosterEditContext({ ...context, shift: { ...shift, organization_id: '22222222-2222-4222-8222-222222222222' } })).toBeNull();
  });
  it('does not present an incomplete handover receipt as a confirmed save, including replays', () => {
    const receipt = {
      client_request_id: id, slot_id: id, shift_id: id, source: 'roster_slot_handover', replayed: true,
      slot_updated_at: timestamp, shift_updated_at: timestamp, replacement_slot_id: id,
      replacement_shift_id: null, replacement_slot_updated_at: timestamp, replacement_shift_updated_at: null,
      released_dispatch_jobs: 0, resolved_welfare_alerts: 0,
    };
    expect(readRosterAmendmentReceipt(receipt)).not.toBeNull();
    expect(readRosterAmendmentReceipt({ ...receipt, replacement_slot_id: null })).toBeNull();
    expect(readRosterAmendmentReceipt({ ...receipt, replacement_slot_updated_at: null })).toBeNull();
    expect(readRosterAmendmentReceipt({ ...receipt, released_dispatch_jobs: 'unknown' })).toBeNull();
  });
});
