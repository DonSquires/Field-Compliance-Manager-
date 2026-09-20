import { describe, expect, it } from 'vitest';
import { responseWords, type DeliverySummary } from './serviceDelivery';

const base: DeliverySummary = { agreement_id: 'a', period_start: '2026-09-01', period_end: '2026-09-30', places: [], totals: { patrol_expected: 0, patrol_completed: 0, patrol_missed: 0, patrol_late: 0, post_expected: 0, post_attended: 0, post_minutes: 0, place_count: 0 } };

describe('responseWords', () => {
  it('is silent for summaries that predate the responses block', () => {
    expect(responseWords(base)).toBeNull();
  });
  it('says plainly when nothing was raised', () => {
    expect(responseWords({ ...base, responses: { count: 0, attended: 0, within_target: 0, over_target: 0, still_open: 0, median_minutes_to_scene: null, slowest_minutes_to_scene: null, by_type: {} } })).toEqual({ tone: 'none', text: 'No alarms or incidents were raised under this agreement in this period.' });
  });
  it('counts what was raised, how many were inside the target, and the typical and slowest minutes to scene', () => {
    const words = responseWords({ ...base, responses: { count: 3, attended: 3, within_target: 2, over_target: 1, still_open: 0, median_minutes_to_scene: 14.5, slowest_minutes_to_scene: 31, by_type: { alarm_response: 2, incident: 1 } } });
    expect(words).toEqual({ tone: 'warn', text: '2 alarms, 1 incident raised · 2 of 3 attended inside the response target, typically 14.5 min from the alarm or call to on scene (slowest 31 min).' });
  });
  it('flags responses nobody has attended yet', () => {
    const words = responseWords({ ...base, responses: { count: 1, attended: 0, within_target: 0, over_target: 0, still_open: 1, median_minutes_to_scene: null, slowest_minutes_to_scene: null, by_type: { welfare_check: 1 } } });
    expect(words).toEqual({ tone: 'warn', text: '1 welfare check raised · 1 not attended yet.' });
  });
  it('is calm when everything attended was inside the target', () => {
    expect(responseWords({ ...base, responses: { count: 1, attended: 1, within_target: 1, over_target: 0, still_open: 0, median_minutes_to_scene: 9, slowest_minutes_to_scene: 9, by_type: { alarm_response: 1 } } })?.tone).toBe('ok');
  });
});
