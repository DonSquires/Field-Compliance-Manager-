import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/AtlasPage.tsx'), 'utf8');

describe('Atlas recovery fallback', () => {
  it('shows the required GitLab platform systems as wired local systems', () => {
    for (const system of ['atlas-blast-radius', 'caddie-tool-catalogue', 'conductor-effect-enforcement', 'oracle-truth-state']) {
      expect(source).toContain(`entity_name: '${system}', present: true, wired: true`);
    }
  });

  it('treats welfare safety as one Oracle application, not the whole Oracle', () => {
    expect(source).toContain("entity_name: 'oracle-truth-state'");
    expect(source).toContain("entity_name: 'oracle-welfare-safety', present: true, wired: true");
    expect(source).toContain('Welfare safety is one Oracle application wired into the Conductor seam');
  });
});