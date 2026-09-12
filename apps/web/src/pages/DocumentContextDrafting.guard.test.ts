import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const studioSource = readFileSync(resolve(process.cwd(), 'src/pages/BobDocumentStudioPage.tsx'), 'utf8');
const locationsSource = readFileSync(resolve(process.cwd(), 'src/pages/LocationsPage.tsx'), 'utf8');
const breachSource = readFileSync(resolve(process.cwd(), 'src/pages/BreachReviewPage.tsx'), 'utf8');
const cctvSource = readFileSync(resolve(process.cwd(), 'src/pages/CCTVReviewPage.tsx'), 'utf8');
const adminShellSource = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');

describe('context-driven document drafting', () => {
  it('supports canonical site, CCTV, notice, and breach source types', () => {
    expect(studioSource).toContain("sourceType === 'site'");
    expect(studioSource).toContain("sourceType === 'cctv'");
    expect(studioSource).toContain("sourceType === 'notice' || sourceType === 'breach'");
    expect(studioSource).toContain("from('client_sites')");
    expect(studioSource).toContain("from('evidence_items')");
    expect(studioSource).toContain("from('breach_alerts')");
  });

  it('keeps each operational entry point linked to Document Studio', () => {
    expect(locationsSource).toContain('sourceType=site&sourceId=');
    expect(breachSource).toContain('sourceType=${sourceType}&sourceId=${alert.id}');
    expect(cctvSource).toContain('sourceType=cctv&sourceId=${selected.evidence_item_id}');
    expect(adminShellSource).toContain("case 'document-studio':");
    expect(adminShellSource).toContain('<BobDocumentStudioPage />');
  });

  it('marks unknown source fields for human confirmation', () => {
    expect(studioSource).toContain('[TO CONFIRM]');
    expect(studioSource).toContain('approval checklist');
  });
});
