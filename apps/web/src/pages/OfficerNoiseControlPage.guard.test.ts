import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/OfficerNoiseControlPage.tsx'), 'utf8');

describe('OfficerNoiseControlPage TDC matrix', () => {
  it('computes action_taken from the matrix rather than letting the officer choose it', () => {
    expect(source).toContain("import {\n  computeNoiseMatrix,\n  determineNoiseAction,\n  deriveTimeScoreFromHour,\n  EXCESSIVE_THRESHOLD_DEFAULT,\n  VOLUME_SCORE_LABELS,\n  TIME_SCORE_LABELS,\n  TONE_SCORE_LABELS,\n} from '../lib/noiseMatrixSchema'");
    expect(source).toContain('const matrix = computeNoiseMatrix(');
    expect(source).toContain('const actionTaken = determineNoiseAction(');
    expect(source).toContain('action_taken: actionTaken');
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

  it('anchors repeat-visit escalation to the noise source address', () => {
    expect(source).toContain("eq('noise_source_address', sourceAddress)");
    expect(source).toContain("eq('action_taken', 'abatement_notice')");
    expect(source).toContain('visitNumberTonight');
    expect(source).toContain('priorEndWithin72hrs');
  });

  it('gates anything beyond a verbal warning on a current, verified noise control warrant', () => {
    expect(source).toContain("eq('credential_type', 'noise_control_warrant')");
    expect(source).toContain("eq('verified', true)");
    expect(source).toContain('This assessment was not saved');
  });

  it('reads the per-org excessive threshold and skip_verbal_warning config', () => {
    expect(source).toContain("from('noise_module_config')");
    expect(source).toContain('excessiveThreshold: data.excessive_threshold');
    expect(source).toContain('skipVerbalWarning: Boolean(data.skip_verbal_warning)');
  });

  it('gates equipment seizure recording on the same verified warrant and mandatory police presence', () => {
    expect(source).toContain("from('noise_seizures')");
    expect(source).toContain('noise_assessment_id: assessmentId');
    expect(source).toContain('const hasWarrant = await hasVerifiedWarrant();');
    expect(source).toContain("Equipment seizure requires a current, verified noise control warrant.");
    expect(source).toContain('if (!seizureForm.police_present)');
    expect(source).toContain('RMA 1991 s.327');
  });
});
