import { describe, expect, it } from 'vitest';
import { computeNoiseMatrix, deriveTimeScoreFromHour } from './noiseMatrixSchema';

describe('noise TDC matrix scoring', () => {
  it('ignores time and tone when volume is zero', () => {
    expect(computeNoiseMatrix({ volumeScore: 0, timeScore: 4, toneScore: 2 })).toEqual({
      matrixTotal: 0,
      isExcessive: false,
      actionTaken: 'no_action',
    });
  });

  it('sums volume + time + tone when volume is non-zero', () => {
    expect(computeNoiseMatrix({ volumeScore: 2, timeScore: 1, toneScore: 1 })).toEqual({
      matrixTotal: 4,
      isExcessive: false,
      actionTaken: 'no_action',
    });
  });

  it('classifies matrix_total >= 5 as excessive with a verbal warning', () => {
    expect(computeNoiseMatrix({ volumeScore: 3, timeScore: 2, toneScore: 1 })).toEqual({
      matrixTotal: 6,
      isExcessive: true,
      actionTaken: 'verbal_warning',
    });
  });

  it('treats matrix_total of exactly the threshold as excessive', () => {
    expect(computeNoiseMatrix({ volumeScore: 2, timeScore: 2, toneScore: 1 })).toEqual({
      matrixTotal: 5,
      isExcessive: true,
      actionTaken: 'verbal_warning',
    });
  });

  it('derives the TDC time band from the current hour', () => {
    expect(deriveTimeScoreFromHour(9)).toBe(1);
    expect(deriveTimeScoreFromHour(21)).toBe(2);
    expect(deriveTimeScoreFromHour(1)).toBe(3);
    expect(deriveTimeScoreFromHour(4)).toBe(4);
  });
});
