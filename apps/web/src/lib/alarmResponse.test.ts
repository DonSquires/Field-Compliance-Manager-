import { describe, expect, it } from 'vitest';
import { localDateTimeValue, responseLadderWords } from './alarmResponse';

const job = { createdAt: '2026-08-30T09:00:00.000Z', dispatchedAt: '2026-08-30T09:02:00.000Z', acknowledgedAt: null, enRouteAt: '2026-08-30T09:05:00.000Z', onSceneAt: null, completedAt: null, slaMinutes: 15, status: 'en_route' };
const alarm = { received_at: '2026-08-30T08:50:00.000Z', signal_type: 'burglary', intake_channel: 'phone', panel_id: null, zone_name: null, zone_number: null, account_number: null };

describe('responseLadderWords', () => {
  it('counts every step from the alarm when one is recorded', () => {
    const ladder = responseLadderWords({ ...job, onSceneAt: '2026-08-30T09:12:00.000Z', status: 'on_scene' }, alarm);
    expect(ladder.rows[0].label).toBe('Alarm received (Burglary / intruder, by phone call)');
    expect(ladder.rows[0].words).not.toContain('after');
    expect(ladder.rows[1]).toMatchObject({ label: 'Job created' });
    expect(ladder.rows[1].words).toContain('10 min after the alarm');
    expect(ladder.rows.find((row) => row.label === 'On scene')?.words).toContain('22 min after the alarm');
    expect(ladder.rows.find((row) => row.label === 'Acknowledged')?.words).toBe('Not yet');
    expect(ladder.verdict).toEqual({ tone: 'stop', text: 'On scene 22 min after the alarm — 7 min over the 15 min target.' });
  });

  it('is inside the target when the officer arrives in time', () => {
    const ladder = responseLadderWords({ ...job, onSceneAt: '2026-08-30T09:04:00.000Z', status: 'on_scene' }, alarm);
    expect(ladder.verdict).toEqual({ tone: 'ok', text: 'On scene 14 min after the alarm — inside the 15 min target.' });
  });

  it('counts from the job and says so when no alarm is recorded', () => {
    const ladder = responseLadderWords(job, null, new Date('2026-08-30T09:10:00.000Z'));
    expect(ladder.rows[0]).toMatchObject({ label: 'Job created' });
    expect(ladder.verdict.tone).toBe('warn');
    expect(ladder.verdict.text).toBe('Not on scene yet · 10 min since the job · 5 min left of the 15 min target. No alarm time is recorded, so the clock counts from when the job was created.');
  });

  it('says how far over the target a response already is', () => {
    const ladder = responseLadderWords(job, alarm, new Date('2026-08-30T09:20:00.000Z'));
    expect(ladder.verdict).toEqual({ tone: 'stop', text: 'Not on scene yet · 30 min since the alarm · already 15 min over the 15 min target.' });
  });

  it('a cancelled job is not judged against the target', () => {
    expect(responseLadderWords({ ...job, status: 'cancelled' }, null).verdict).toEqual({ tone: 'warn', text: 'Cancelled before anyone was on scene.' });
  });
});

describe('localDateTimeValue', () => {
  it('formats the browser-local wall clock for a datetime-local input, not UTC', () => {
    const date = new Date(2026, 8, 20, 7, 5);
    expect(localDateTimeValue(date)).toBe('2026-09-20T07:05');
  });
});
