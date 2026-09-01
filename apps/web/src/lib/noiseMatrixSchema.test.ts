import { describe, expect, it } from 'vitest';
import { computeNoiseMatrix, determineNoiseAction, deriveTimeScoreFromHour } from './noiseMatrixSchema';

describe('noise TDC matrix scoring', () => {
  it('ignores time and tone when volume is zero', () => {
    expect(computeNoiseMatrix({ volumeScore: 0, timeScore: 4, toneScore: 2 })).toEqual({
      matrixTotal: 0,
      isExcessive: false,
    });
  });

  it('sums volume + time + tone when volume is non-zero', () => {
    expect(computeNoiseMatrix({ volumeScore: 2, timeScore: 1, toneScore: 1 })).toEqual({
      matrixTotal: 4,
      isExcessive: false,
    });
  });

  it('classifies matrix_total >= 5 as excessive', () => {
    expect(computeNoiseMatrix({ volumeScore: 3, timeScore: 2, toneScore: 1 })).toEqual({
      matrixTotal: 6,
      isExcessive: true,
    });
  });

  it('treats matrix_total of exactly the threshold as excessive', () => {
    expect(computeNoiseMatrix({ volumeScore: 2, timeScore: 2, toneScore: 1 })).toEqual({
      matrixTotal: 5,
      isExcessive: true,
    });
  });

  it('honours a per-org excessive_threshold override', () => {
    expect(computeNoiseMatrix({ volumeScore: 2, timeScore: 2, toneScore: 1 }, 6).isExcessive).toBe(false);
  });

  it('derives the TDC time band from the current hour', () => {
    expect(deriveTimeScoreFromHour(9)).toBe(1);
    expect(deriveTimeScoreFromHour(21)).toBe(2);
    expect(deriveTimeScoreFromHour(1)).toBe(3);
    expect(deriveTimeScoreFromHour(4)).toBe(4);
  });
});

describe('noise action determination (Phase F, computed not chosen)', () => {
  it('takes no action when not excessive, regardless of repeat visits', () => {
    expect(determineNoiseAction({ isExcessive: false, visitNumberTonight: 3, priorEndWithin72hrs: true, skipVerbalWarning: false })).toBe('no_action');
  });

  it('issues a verbal warning on the first excessive finding tonight', () => {
    expect(determineNoiseAction({ isExcessive: true, visitNumberTonight: 1, priorEndWithin72hrs: false, skipVerbalWarning: false })).toBe('verbal_warning');
  });

  it('escalates to an abatement notice on a repeat excessive visit tonight', () => {
    expect(determineNoiseAction({ isExcessive: true, visitNumberTonight: 2, priorEndWithin72hrs: false, skipVerbalWarning: false })).toBe('abatement_notice');
  });

  it('escalates to an abatement notice when a prior END exists within 72 hours', () => {
    expect(determineNoiseAction({ isExcessive: true, visitNumberTonight: 1, priorEndWithin72hrs: true, skipVerbalWarning: false })).toBe('abatement_notice');
  });

  it('skips the verbal warning tier entirely when the org config requires it', () => {
    expect(determineNoiseAction({ isExcessive: true, visitNumberTonight: 1, priorEndWithin72hrs: false, skipVerbalWarning: true })).toBe('abatement_notice');
  });
});
