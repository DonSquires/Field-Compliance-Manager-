import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/OfficerNoiseControlPage.tsx'), 'utf8');

describe('OfficerNoiseControlPage TDC matrix', () => {
  it('computes action_taken from the matrix rather than letting the officer choose it', () => {
    expect(source).toContain("import {\n  computeNoiseMatrix,\n  deriveTimeScoreFromHour,\n  VOLUME_SCORE_LABELS,\n  TIME_SCORE_LABELS,\n  TONE_SCORE_LABELS,\n} from '../lib/noiseMatrixSchema'");
    expect(source).toContain('const matrix = computeNoiseMatrix(');
    expect(source).toContain('action_taken: matrix.actionTaken');
    expect(source).not.toContain('<input type="text" value={form.action_taken}');
  });

  it('ignores time and tone scoring inputs when volume is zero', () => {
    expect(source).toContain("time_score: form.volume_score === 0 ? null : form.time_score");
    expect(source).toContain("tone_score: form.volume_score === 0 ? null : form.tone_score");
    expect(source).toContain('disabled={form.volume_score === 0}');
  });

  it('writes the computed matrix_total alongside the raw score inputs', () => {
    expect(source).toContain('volume_score: form.volume_score');
    expect(source).toContain('matrix_total: matrix.matrixTotal');
  });
});
