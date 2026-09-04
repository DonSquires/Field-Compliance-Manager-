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
});
