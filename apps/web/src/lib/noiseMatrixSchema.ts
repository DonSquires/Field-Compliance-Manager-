/**
 * TDC (Time/Decibel/Character... per spec: Volume/Time/Tone) noise matrix.
 * Schema: noise_assessments.volume_score (0-4), time_score (1-4, ignored when
 * volume_score=0), tone_score (0-2), matrix_total. See column comments in
 * supabase/schema.sql for the exact band definitions.
 *
 * SCOPE: this computes the matrix total and the FIRST-TIER action only
 * (no_action | verbal_warning). Escalation to abatement_notice/enforcement/
 * seizure requires repeat-visit and prior-END detection, which is anchored to
 * the noise SOURCE address (site_id) per the dual-address model — that
 * address model is not built yet, so escalation is deliberately NOT computed
 * here rather than guessed from a free-text match. Excessive_threshold is
 * also not yet configurable per org (noise_module_config has no admin page
 * yet); the TDC default of 5 is used.
 */

export const EXCESSIVE_THRESHOLD_DEFAULT = 5;

export type NoiseActionTaken = 'no_action' | 'verbal_warning';

export interface NoiseMatrixInput {
  volumeScore: number;
  timeScore: number;
  toneScore: number;
}

export interface NoiseMatrixResult {
  matrixTotal: number;
  isExcessive: boolean;
  actionTaken: NoiseActionTaken;
}

export function computeNoiseMatrix({ volumeScore, timeScore, toneScore }: NoiseMatrixInput): NoiseMatrixResult {
  const matrixTotal = volumeScore === 0 ? 0 : volumeScore + timeScore + toneScore;
  const isExcessive = matrixTotal >= EXCESSIVE_THRESHOLD_DEFAULT;
  return {
    matrixTotal,
    isExcessive,
    actionTaken: isExcessive ? 'verbal_warning' : 'no_action',
  };
}

export const VOLUME_SCORE_LABELS: Record<number, string> = {
  0: 'No noise',
  1: 'Barely audible',
  2: 'Clearly audible',
  3: 'Loud',
  4: 'Extremely loud',
};

export const TIME_SCORE_LABELS: Record<number, string> = {
  1: '7am – 9pm',
  2: '9pm – midnight',
  3: 'Midnight – 2am',
  4: '2am – 7am',
};

export const TONE_SCORE_LABELS: Record<number, string> = {
  0: 'No bass',
  1: 'Slight bass',
  2: 'Heavy bass',
};

/** TDC bands per column comment on noise_assessments.time_score. */
export function deriveTimeScoreFromHour(hour: number): number {
  if (hour >= 7 && hour < 21) return 1;
  if (hour >= 21) return 2;
  if (hour < 2) return 3;
  return 4;
}
