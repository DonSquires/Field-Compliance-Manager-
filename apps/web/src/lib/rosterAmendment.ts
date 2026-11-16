interface PlannedSlot {
  id: string; organization_id: string; work_unit_id: string; staff_id: string | null;
  linked_shift_id: string | null; scheduled_start: string; scheduled_end: string; updated_at: string;
  status: string; notes: string | null; planned_break_minutes: number; break_unpaid: boolean;
}
interface LinkedAttendance {
  id: string; organization_id: string; officer_user_id: string; status: string;
  actual_start: string | null; actual_end: string | null; updated_at: string;
}
interface ShiftContact { contact_name: string | null; contact_phone: string | null; version: string; }
interface FinishDependencies { open_dispatch_jobs: number; open_welfare_alerts: number; }
export interface RosterEditContext {
  slot: PlannedSlot; shift: LinkedAttendance | null; contact: ShiftContact | null;
  work_unit: { id: string; name: string; work_unit_type: string };
  finish_preview: FinishDependencies | null;
}
interface AmendmentReceipt {
  client_request_id: string; slot_id: string; shift_id: string | null;
  source: 'roster_slot_amended' | 'roster_slot_handover'; replayed: boolean;
  slot_updated_at: string; shift_updated_at: string | null;
  replacement_slot_id: string | null; replacement_shift_id: string | null;
  replacement_slot_updated_at: string | null; replacement_shift_updated_at: string | null;
  released_dispatch_jobs: number; resolved_welfare_alerts: number;
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const instant = (value: unknown): value is string => typeof value === 'string'
  && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const textOrNull = (value: unknown) => value === null || typeof value === 'string';
const uuidOrNull = (value: unknown) => value === null || uuid(value);
const instantOrNull = (value: unknown) => value === null || instant(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const plannedSlot = (value: unknown): value is PlannedSlot => record(value)
  && uuid(value.id) && uuid(value.organization_id) && uuid(value.work_unit_id)
  && uuidOrNull(value.staff_id) && uuidOrNull(value.linked_shift_id)
  && instant(value.scheduled_start) && instant(value.scheduled_end) && instant(value.updated_at)
  && typeof value.status === 'string' && textOrNull(value.notes)
  && count(value.planned_break_minutes) && value.planned_break_minutes <= 240 && typeof value.break_unpaid === 'boolean';
const attendance = (value: unknown): value is LinkedAttendance => record(value)
  && uuid(value.id) && uuid(value.organization_id) && uuid(value.officer_user_id) && typeof value.status === 'string'
  && instantOrNull(value.actual_start) && instantOrNull(value.actual_end) && instant(value.updated_at);
const contact = (value: unknown): value is ShiftContact => record(value)
  && textOrNull(value.contact_name) && textOrNull(value.contact_phone) && uuid(value.version);
const dependencies = (value: unknown): value is FinishDependencies => record(value)
  && count(value.open_dispatch_jobs) && count(value.open_welfare_alerts);

export function readRosterEditContext(value: unknown): RosterEditContext | null {
  if (!record(value) || !plannedSlot(value.slot) || !record(value.work_unit)
    || !uuid(value.work_unit.id) || typeof value.work_unit.name !== 'string'
    || typeof value.work_unit.work_unit_type !== 'string'
    || !(value.shift === null || attendance(value.shift))
    || !(value.contact === null || contact(value.contact))
    || !(value.finish_preview === null || dependencies(value.finish_preview))) return null;
  if (value.work_unit.id !== value.slot.work_unit_id || value.slot.linked_shift_id !== (value.shift?.id ?? null)
    || (value.shift && value.shift.organization_id !== value.slot.organization_id)
    || (value.shift?.status === 'in_progress' && !value.finish_preview)) return null;
  return { slot: value.slot, shift: value.shift, contact: value.contact, finish_preview: value.finish_preview,
    work_unit: { id: value.work_unit.id, name: value.work_unit.name, work_unit_type: value.work_unit.work_unit_type } };
}

const amendmentReceipt = (value: unknown): value is AmendmentReceipt => record(value)
  && uuid(value.client_request_id) && uuid(value.slot_id) && uuidOrNull(value.shift_id)
  && (value.source === 'roster_slot_amended' || value.source === 'roster_slot_handover')
  && typeof value.replayed === 'boolean' && instant(value.slot_updated_at) && instantOrNull(value.shift_updated_at)
  && uuidOrNull(value.replacement_slot_id) && uuidOrNull(value.replacement_shift_id)
  && instantOrNull(value.replacement_slot_updated_at) && instantOrNull(value.replacement_shift_updated_at)
  && count(value.released_dispatch_jobs) && count(value.resolved_welfare_alerts);

export function readRosterAmendmentReceipt(value: unknown): AmendmentReceipt | null {
  if (!amendmentReceipt(value)) return null;
  if ((value.source === 'roster_slot_handover') !== Boolean(value.replacement_slot_id)
    || Boolean(value.replacement_slot_id) !== Boolean(value.replacement_slot_updated_at)
    || Boolean(value.replacement_shift_id) !== Boolean(value.replacement_shift_updated_at)
    || Boolean(value.shift_id) !== Boolean(value.shift_updated_at)) return null;
  return value;
}
