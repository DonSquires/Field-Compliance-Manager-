import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/OfficerSchedulePage.tsx'), 'utf8');

describe('officer unscheduled shift workflow', () => {
  it('starts through the governed officer RPC with the selected work unit module', () => {
    expect(source).toContain("supabase.rpc('start_ad_hoc_officer_shift'");
    expect(source).toContain('p_work_unit_id: unit.id');
    expect(source).toContain('p_module_key: unit.service_type');
  });

  it('limits the picker to active work units in the officer organisation', () => {
    expect(source).toContain("from('roster_work_units').select('id, name, work_unit_type, service_type')");
    expect(source).toContain("eq('organization_id', profile.organizationId).eq('active', true)");
  });

  it('does not offer unscheduled work while another shift is active', () => {
    expect(source).toContain('{!activeShiftId && adHocWorkUnits.length > 0');
    expect(source).toContain('You can only have one active shift.');
  });

  it('preserves the operator context in the shift start request', () => {
    expect(source).toContain('p_notes: adHocNotes.trim() || null');
    expect(source).toContain('Who asked you to start, or what needs attention?');
  });

  it('reports a confirmed receipt and refreshes the schedule', () => {
    expect(source).toContain('shift started now.');
    expect(source).toContain('await loadSchedule();');
  });
});
