import { describe, expect, it } from 'vitest';
import { classifyWorkshopJob } from './workshopJobClassifier';

describe('classifyWorkshopJob', () => {
  it.each([
    ['Fix the lock on the Kaituna gate', 'maintenance', 'physical_lock', 'maintenance'],
    ['Install a new gate at the Rai Valley entrance', 'maintenance', 'gate', 'installation'],
    ['Replace broken padlock', 'maintenance', 'physical_lock', 'maintenance'],
    ['Repair the E-Lock keypad', 'maintenance', 'electronic_lock', 'maintenance'],
    ['Install signs on the forestry road', 'maintenance', 'sign', 'installation'],
    ['Digger work clearing the culvert', 'maintenance', 'earthworks', 'maintenance'],
    ['Excavator - post holes for gate', 'maintenance', 'gate', 'maintenance'],
    ['Fabricate a lockbox', 'fabrication', 'physical_lock', 'manufacture'],
    ['Weld a new barrier arm', 'fabrication', 'gate', 'manufacture'],
    ['Remove old camera', 'maintenance', 'camera', 'uninstall'],
    ['Lock up the yard', 'maintenance', 'general', 'securing'],
    ['Fix the gate with a new hinge', 'maintenance', 'gate', 'maintenance'],
  ])('%s', (text, kind, subjectCode, activityCode) => {
    expect(classifyWorkshopJob(text)).toMatchObject({ kind, subjectCode, activityCode });
  });

  it('falls back to general maintenance and explains no matches', () => {
    expect(classifyWorkshopJob('Odd job for client')).toEqual({ kind: 'maintenance', subjectCode: 'general', activityCode: 'maintenance', matched: [] });
  });

  it('reports the words that drove the suggestion', () => {
    expect(classifyWorkshopJob('Fix the gate').matched).toEqual(['gate', 'fix']);
  });
});
