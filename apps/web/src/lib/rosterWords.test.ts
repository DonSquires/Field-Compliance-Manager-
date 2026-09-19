import { describe, expect, it } from 'vitest';
import { plainWords, plural, slotStatusLabel, timeRange, workUnitTypeLabel } from './rosterWords';

describe('roster plain words', () => {
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
    expect(workUnitTypeLabel(undefined)).toBe('Unknown');
  });

  it('formats counts and time ranges for chips and dialogs', () => {
    expect(plural(1, 'draft')).toBe('1 draft');
    expect(plural(0, 'draft')).toBe('0 drafts');
    expect(plural(3, 'field shift record')).toBe('3 field shift records');
    const range = timeRange('2026-08-25T08:00:00+12:00', '2026-08-25T16:00:00+12:00');
    expect(range).toMatch(/\d{2}:\d{2}.*\u2013.*\d{2}:\d{2}/);
  });
});
