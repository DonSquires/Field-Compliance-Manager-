/**
 * TDC (Time/Decibel/Character... per spec: Volume/Time/Tone) noise matrix.
 * Schema: noise_assessments.volume_score (0-4), time_score (1-4, ignored when
 * volume_score=0), tone_score (0-2), matrix_total. See column comments in
 * supabase/schema.sql for the exact band definitions.
 *
 * Escalation beyond a verbal warning (abatement_notice, seizure) requires
 * repeat-visit and prior-END detection anchored to the noise SOURCE address
 * (noise_assessments.noise_source_address), per the dual-address model.
 * excessive_threshold and skip_verbal_warning are per-org config
 * (noise_module_config); callers pass the resolved config in, falling back
 * to the TDC defaults when no config row exists yet for the org.
 */

export const EXCESSIVE_THRESHOLD_DEFAULT = 5;

export type NoiseActionTaken = 'no_action' | 'verbal_warning' | 'abatement_notice';

export interface NoiseMatrixInput {
  volumeScore: number;
  timeScore: number;
  toneScore: number;
}

export interface NoiseMatrixResult {
  matrixTotal: number;
  isExcessive: boolean;
}

export function computeNoiseMatrix({ volumeScore, timeScore, toneScore }: NoiseMatrixInput, excessiveThreshold = EXCESSIVE_THRESHOLD_DEFAULT): NoiseMatrixResult {
  const matrixTotal = volumeScore === 0 ? 0 : volumeScore + timeScore + toneScore;
  return {
    matrixTotal,
    isExcessive: matrixTotal >= excessiveThreshold,
  };
}

export interface DetermineActionInput {
  isExcessive: boolean;
  /** Assessments already recorded tonight at the same noise source address, including this one (>=1). */
  visitNumberTonight: number;
  /** An abatement_notice was already issued at this source address within the last 72 hours. */
  priorEndWithin72hrs: boolean;
  /** Org config: skip the verbal-warning tier and issue an END on the first excessive finding. */
  skipVerbalWarning: boolean;
}

/**
 * Phase F: the action is COMPUTED, never chosen by the officer. Seizure and
 * higher tiers require a physical seizure record (noise_seizures) and are not
 * determined here — this only reaches as far as abatement_notice (an END).
 */
export function determineNoiseAction({ isExcessive, visitNumberTonight, priorEndWithin72hrs, skipVerbalWarning }: DetermineActionInput): NoiseActionTaken {
  if (!isExcessive) return 'no_action';
  const alreadyWarned = priorEndWithin72hrs || visitNumberTonight > 1;
  if (skipVerbalWarning || alreadyWarned) return 'abatement_notice';
  return 'verbal_warning';
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

