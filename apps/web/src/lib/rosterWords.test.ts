import { describe, expect, it } from 'vitest';
import { contractedDaysWords, contractedHoursWords, plainWords, plural, sentenceCase, shiftStatusLabel, slotStatusLabel, submittedWords, timeRange, workUnitTypeLabel } from './rosterWords';

describe('roster plain words', () => {
  it('states when a timesheet reached the server in NZ time, or nothing when unknown', () => {
    // 21:15 UTC on 1 Nov is 10:15 on 2 Nov in New Zealand daylight time.
    const words = submittedWords('2026-11-01T21:15:00Z');
    expect(words).toMatch(/^Submitted 2 Nov/);
    expect(words).toContain('10:15');
    expect(submittedWords(null)).toBeNull();
    expect(submittedWords('')).toBeNull();
    expect(submittedWords('not a date')).toBeNull();
  });

  it('tells the rosterer what each field shift status means on the board', () => {
    expect(shiftStatusLabel('published')).toBe('Waiting for officer');
    expect(shiftStatusLabel('accepted')).toBe('Accepted');
    expect(shiftStatusLabel('in_progress')).toBe('On shift now');
    expect(shiftStatusLabel('completed')).toBe('Completed');
    expect(shiftStatusLabel('something_new')).toBe('Something new');
  });

  it('tells the rosterer what each slot status means for them', () => {
    expect(slotStatusLabel('draft')).toBe('Draft \u2013 not sent yet');
    expect(slotStatusLabel('published')).toBe('Waiting for officer');
    expect(slotStatusLabel('accepted')).toBe('Accepted');
    expect(slotStatusLabel('declined')).toBe('Declined \u2013 reassign');
    expect(slotStatusLabel('completed')).toBe('Completed');
    expect(slotStatusLabel('cancelled')).toBe('Cancelled');
  });

  it('never leaks an unknown code with underscores', () => {
    expect(slotStatusLabel('offered_overtime')).toBe('offered overtime');
    expect(plainWords('in_progress')).toBe('In progress');
    expect(plainWords('on_track')).toBe('On track');
    expect(plainWords(null)).toBe('Not recorded');
    expect(plainWords(undefined, 'Not calculated yet')).toBe('Not calculated yet');
  });

  it('names work unit types the way the rest of the app does', () => {
    expect(workUnitTypeLabel('patrol')).toBe('Patrol run');
    expect(workUnitTypeLabel('static')).toBe('Static post');
    expect(workUnitTypeLabel('internal')).toBe('Office / internal');
    expect(workUnitTypeLabel('workshop')).toBe('Manufacturing & maintenance');
    expect(workUnitTypeLabel(undefined)).toBe('Unknown');
  });

  it('formats counts and time ranges for chips and dialogs', () => {
    expect(plural(1, 'draft')).toBe('1 draft');
    expect(plural(0, 'draft')).toBe('0 drafts');
    expect(plural(3, 'field shift record')).toBe('3 field shift records');
    const range = timeRange('2026-08-25T08:00:00+12:00', '2026-08-25T16:00:00+12:00');
    expect(range).toMatch(/\d{2}:\d{2}.*\u2013.*\d{2}:\d{2}/);
  });

  it('describes contracted days Monday-first and treats no restriction as every day (owner ruling 2026-09-20)', () => {
    expect(contractedDaysWords([1, 2, 3, 4, 5, 6, 7])).toBe('every day');
    expect(contractedDaysWords([])).toBe('every day');
    expect(contractedDaysWords(null)).toBe('every day');
    expect(contractedDaysWords([5, 1, 2, 3, 4])).toBe('Mon\u2013Fri');
    expect(contractedDaysWords([6, 7])).toBe('Sat, Sun');
    expect(contractedDaysWords([7, 1])).toBe('Mon, Sun');
    expect(contractedDaysWords([1, 3, 5])).toBe('Mon, Wed, Fri');
    expect(sentenceCase(contractedDaysWords([2, 3, 4]))).toBe('Tue\u2013Thu');
  });

  it('treats a patrol with no contracted window as 24-hour work', () => {
    expect(contractedHoursWords(null, null)).toBe('any time of day (24-hour)');
    expect(contractedHoursWords('07:00:00', '19:00:00')).toBe('07:00\u201319:00');
    expect(contractedHoursWords('22:00', null)).toBe('22:00\u2013end of shift');
    expect(sentenceCase('every day')).toBe('Every day');
  });
});
