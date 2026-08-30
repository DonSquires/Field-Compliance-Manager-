import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260830133000_enforce_roster_availability.sql'), 'utf8');
const schema = readFileSync(resolve(process.cwd(), '../../supabase/schema.sql'), 'utf8');

describe('roster availability invariant', () => {
  it('blocks only explicit unavailable and leave records', () => {
    expect(sql).toContain("a.availability_type in('unavailable','leave')");
    expect(sql).toContain("new.status not in('declined','cancelled')");
    expect(sql).toContain('Staff member is unavailable during this roster slot');
  });

  it('supports specific dates, recurring ISO weekdays, and partial-day overlap', () => {
    expect(sql).toContain('a.specific_date=roster_day::date');
    expect(sql).toContain('extract(isodow from roster_day)');
    expect(sql).toContain("tstzrange(p_scheduled_start,p_scheduled_end,'[)')");
    expect(sql).toContain("time zone 'Pacific/Auckland'");
  });

  it('enforces all slot writers through a trigger', () => {
    expect(sql).toContain('before insert or update of staff_id,scheduled_start,scheduled_end,status on public.roster_slots');
    expect(sql).toContain('revoke all on function public.staff_has_roster_availability_conflict');
    expect(schema).toContain('CREATE FUNCTION "public"."staff_has_roster_availability_conflict"');
    expect(schema).toContain('CREATE TRIGGER "trg_enforce_roster_slot_availability"');
  });
});