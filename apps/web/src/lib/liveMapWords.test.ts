import { describe, expect, it } from 'vitest';
import { alertWords, clock, gpsAgeWords, officerActivityWords, safetyWords } from './liveMapWords';

const NOW = new Date('2026-09-21T08:05:00+12:00').getTime();
// Clock words follow the runner's local time zone, as they do in the browser.
const at = (iso: string) => clock(iso);
const shift = { id: 's1', status: 'in_progress', scheduled_start: '2026-09-21T07:00:00+12:00', scheduled_end: '2026-09-21T11:00:00+12:00', organization_id: 'o1', organization_name: 'First Security Nelson', service_type: 'patrol', zone_id: null, route_name: 'Nelson run', work_unit_name: 'Nelson parking run' };
const shiftHours = `${at(shift.scheduled_start)}–${at(shift.scheduled_end)}`;

describe('live officer map words', () => {
  it('says how old the last fix is in the words a dispatcher uses', () => {
    expect(gpsAgeWords(null, NOW)).toBe('No fix');
    expect(gpsAgeWords(new Date(NOW - 20_000).toISOString(), NOW)).toBe('Just now');
    expect(gpsAgeWords(new Date(NOW - 3 * 60_000).toISOString(), NOW)).toBe('3m ago');
    expect(gpsAgeWords(new Date(NOW - 130 * 60_000).toISOString(), NOW)).toBe('2h ago');
  });

  it('describes the work from the shift first, then the last breadcrumb', () => {
    expect(officerActivityWords({ shift, activity_type: 'gps_update', speed_kmh: 0, zone_name: 'Parking zone' })).toBe(`On shift · Nelson parking run · ${shiftHours} · in Parking zone`);
    expect(officerActivityWords({ shift: { ...shift, status: 'accepted', work_unit_name: null }, activity_type: null, speed_kmh: 32, zone_name: null })).toBe(`Shift accepted · Nelson run · ${shiftHours} · 32 km/h`);
    expect(officerActivityWords({ shift: null, activity_type: 'gps_update', speed_kmh: null, zone_name: null })).toBe('Position update');
    expect(officerActivityWords({ shift: null, activity_type: 'sos', speed_kmh: null, zone_name: null })).toBe('SOS raised');
    expect(officerActivityWords({ shift: null, activity_type: null, speed_kmh: null, zone_name: null })).toBe('Off shift');
  });

  it('names alert types plainly', () => {
    expect(alertWords('sos')).toBe('SOS');
    expect(alertWords('man_down')).toBe('Man down');
    expect(alertWords('something_new')).toBe('Something new');
  });

  it('gives the safety headline and the check-in clock; offline GPS never quietens an overdue check-in', () => {
    const welfare = { enabled: true, check_interval_minutes: 30, last_checkin_at: null };
    const firstDue = at('2026-09-21T07:30:00+12:00');
    expect(safetyWords({ welfare, shift, alert: null }, 'overdue', 'overdue', NOW)).toEqual({ headline: 'Check-in overdue', detail: `No check-in yet · first due ${firstDue}` });
    expect(safetyWords({ welfare, shift, alert: null }, 'offline', 'overdue', NOW)).toEqual({ headline: 'GPS offline · check-in overdue', detail: `No check-in yet · first due ${firstDue}` });
    expect(safetyWords({ welfare: { ...welfare, last_checkin_at: '2026-09-21T07:50:00+12:00' }, shift, alert: null }, 'ok', 'ok', NOW)).toEqual({ headline: 'Safety OK', detail: `Checked in ${at('2026-09-21T07:50:00+12:00')} · next due ${at('2026-09-21T08:20:00+12:00')}` });
    expect(safetyWords({ welfare, shift: null, alert: { id: 'a', alert_type: 'sos', status: 'pending', triggered_at: '2026-09-21T08:01:00+12:00' } }, 'alerting', 'alerting', NOW)).toEqual({ headline: 'Active alert', detail: `SOS ${at('2026-09-21T08:01:00+12:00')}` });
    // off shift with no check-in: nothing was ever verified, so no clock is invented
    expect(safetyWords({ welfare, shift: null, alert: null }, 'unknown', null, NOW)).toEqual({ headline: 'Safety unknown', detail: null });
  });
});
