import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/modules/SmokeControlPage.tsx'), 'utf8');

describe('smoke assessment complainant site anchor', () => {
  it('submits an optional known affected site through the governed receipt function', () => {
    expect(source).toContain('complainant_site_id: formData.complainant_site_id || null');
    expect(source).toContain('id="smoke-complainant-site"');
    expect(source).toContain('Not a known site');
  });

  it('shows private evidence and keeps three review authorities separate', () => {
    expect(source).toContain("createSignedUrl(path, 15 * 60)");
    expect(source).toContain('Private evidence · link expires in 15 minutes');
    expect(source).toContain("rpc('review_smoke_photo_classification'");
    expect(source).toContain("rpc('manage_smoke_assessment'");
    expect(source).toContain("rpc('manage_smoke_assessment_review'");
    expect(source).toContain('Separate from photo inference');
    expect(source).toContain('machine confidence');
  });

  it('does not bypass the governed smoke writers with direct table updates', () => {
    expect(source).not.toMatch(/from\('smoke_assessments'\)[\s\S]{0,300}\.update\(/);
    expect(source).toContain('notice_number: formData.notice_number.trim() || null');
    expect(source).toContain('source_confirmed: formData.source_confirmed');
  });
});
