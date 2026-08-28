/**
 * useOfficerSafety.guard.test.ts — source-level regression guards
 *
 * Mirrors the original repo's own `useManDownDetection.guard.test.ts`
 * pattern (a source-text guard, not a behavioural test) for two properties
 * that must never regress silently:
 *
 *   1. Escalation timing (L1→L2→L3) stays server-authoritative, owned by
 *      the `welfare-escalation-tick` edge function. The client may set
 *      `escalation_level: 1` on the initial alert insert only — it must
 *      never write `escalation_level` again, and must never write
 *      `escalated_at` at all.
 *   2. The P0 fix itself: recordMovement must never be able to clear an
 *      active alert. This guard is not present in the original test (its
 *      scope was escalation ownership only, not resolve-on-movement) but is
 *      added here because that is precisely the defect this rebuild exists
 *      to prevent from reintroducing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const HOOK_PATH = resolve(__dirname, 'useOfficerSafety.ts');
const source = readFileSync(HOOK_PATH, 'utf-8');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const executableSource = stripComments(source);

describe('useOfficerSafety — server-authoritative escalation guard', () => {
  it('does not contain an .update() call that writes escalation_level', () => {
    const updateBlocks = executableSource.match(/\.update\s*\(\{[\s\S]*?\}\)/g) ?? [];
    for (const block of updateBlocks) {
      expect(block).not.toContain('escalation_level');
    }
  });

  it('does not reference escalated_at anywhere in executable code', () => {
    expect(executableSource).not.toContain('escalated_at');
  });

  it('only references escalation_level once, on the initial insert', () => {
    const refs = executableSource.split('\n').filter((line) => line.includes('escalation_level'));
    expect(refs).toHaveLength(1);
    expect(refs[0].trim()).toMatch(/escalation_level:\s*1,?$/);
  });

  it('still contains GPS movement detection (haversineMetres, MOVEMENT_THRESHOLD_M)', () => {
    expect(source).toContain('haversineMetres');
    expect(source).toContain('MOVEMENT_THRESHOLD_M');
  });
});

describe('useOfficerSafety — recordMovement can never resolve an alert (P0 guard)', () => {
  function extractFunctionBody(name: string): string {
    const marker = `const ${name} = useCallback(`;
    const start = executableSource.indexOf(marker);
    expect(start, `expected to find ${marker}`).toBeGreaterThanOrEqual(0);
    const end = executableSource.indexOf('}, [', start);
    expect(end, `expected to find the end of ${name}`).toBeGreaterThan(start);
    return executableSource.slice(start, end);
  }

  it('recordMovement never calls setActiveAlert', () => {
    expect(extractFunctionBody('recordMovement')).not.toContain('setActiveAlert');
  });

  it('recordMovement never calls fireAlert or touches the Supabase client', () => {
    const body = extractFunctionBody('recordMovement');
    expect(body).not.toContain('fireAlert');
    expect(body).not.toContain('supabase');
  });

  it('only checkIn and acknowledgeAlert are allowed to clear activeAlert (setActiveAlert(null))', () => {
    const clearingCallsites = executableSource
      .split('\n')
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.includes('setActiveAlert(null)'));
    expect(clearingCallsites.length).toBeGreaterThan(0);

    for (const { index } of clearingCallsites) {
      const precedingSource = executableSource.split('\n').slice(0, index + 1).join('\n');
      const lastCheckIn = precedingSource.lastIndexOf('const checkIn = useCallback(');
      const lastAcknowledge = precedingSource.lastIndexOf('const acknowledgeAlert = useCallback(');
      const lastRecordMovement = precedingSource.lastIndexOf('const recordMovement = useCallback(');
      const owningFunctionStart = Math.max(lastCheckIn, lastAcknowledge, lastRecordMovement);
      expect(owningFunctionStart === lastCheckIn || owningFunctionStart === lastAcknowledge).toBe(true);
    }
  });
});
