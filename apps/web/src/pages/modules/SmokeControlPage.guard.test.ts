import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/modules/SmokeControlPage.tsx'), 'utf8');

describe('SmokeControlPage', () => {
  it('uses complaint_source values that match the smoke_assessments CHECK constraint', () => {
    for (const value of ['neighbour', 'council_hotline', 'self_report', 'other']) {
      expect(source).toContain(`value="${value}"`);
    }
    expect(source).not.toContain('value="public"');
    expect(source).not.toContain('value="council"');
  });

  it('uses smoke_source_type values that match the smoke_assessments CHECK constraint', () => {
    for (const value of ['domestic_solid_fuel', 'industrial', 'vehicle_exhaust', 'agricultural', 'nuisance_burning', 'unknown']) {
      expect(source).toContain(`value="${value}"`);
    }
    expect(source).not.toContain('value="outdoor_burning"');
    expect(source).not.toContain('value="domestic_fire"');
  });

  it('captures photo evidence and GPS, and submits through the edge function rather than a direct insert', () => {
    expect(source).toContain("import { getCurrentPosition, imageFileToBase64 } from '../../lib/officerScan'");
    expect(source).toContain('type="file"');
    expect(source).toContain('capture="environment"');
    expect(source).toContain("functions.invoke('submit-smoke-assessment'");
    expect(source).not.toContain("from('smoke_assessments')\n        .insert(");
  });

  it('treats AI classification as advisory only, never overriding the officer\'s action_taken choice', () => {
    expect(source).toContain('advisory only');
    expect(source).toContain('action_taken: formData.action_taken');
  });
});
