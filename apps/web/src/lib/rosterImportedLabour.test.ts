import { describe, expect, it } from 'vitest';
import { importedLabourLabel, isPricedRosterLabour } from './rosterImportedLabour';

describe('source-backed roster labour', () => {
  it('does not label normal slots as imported work', () => {
    expect(importedLabourLabel(null)).toBeNull();
    expect(importedLabourLabel({ source: 'other' })).toBeNull();
  });
  it('shows recorded hours, provenance count and approximate timing', () => {
    expect(importedLabourLabel({ source: 'rm_patrol_log_labour', recorded_hours: 3.125, source_records: [{}, {}] }))
      .toBe('Patrol log · 3.13h recorded · 2 source entries · start approximate');
  });
  it('names the client once labour sits on a shared patrol route row', () => {
    expect(importedLabourLabel({ source: 'rm_patrol_log_labour', recorded_hours: 7.5, source_records: [{}],
      client_name: ' Tasman District Council ', route_code: 'RM-NELSON-FORESTRY' }))
      .toBe('Patrol log · Tasman District Council · 7.5h recorded · 1 source entry · start approximate');
    expect(importedLabourLabel({ source: 'rm_patrol_log_labour', recorded_hours: 1, client_name: '  ' }))
      .toBe('Patrol log · 1h recorded · 0 source entries · start approximate');
  });
  it('does not invent hours from missing or invalid evidence', () => {
    for (const recorded_hours of [undefined, NaN, Infinity]) {
      expect(importedLabourLabel({ source: 'rm_patrol_log_labour', recorded_hours })).toContain('Hours not recorded');
    }
  });
  it('does not flag intentionally separate billing as unpriced labour', () => {
    for (const status of ['resolved', 'billed_via_patrol_log', 'billed_via_work_order']) expect(isPricedRosterLabour(status)).toBe(true);
    for (const status of ['no_pay_rule', 'no_billing_rule', 'no_rules']) expect(isPricedRosterLabour(status)).toBe(false);
  });
});
