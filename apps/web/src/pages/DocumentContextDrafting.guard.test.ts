import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const studioSource = readFileSync(resolve(process.cwd(), 'src/pages/BobDocumentStudioPage.tsx'), 'utf8');
const locationsSource = readFileSync(resolve(process.cwd(), 'src/pages/LocationsPage.tsx'), 'utf8');
const breachSource = readFileSync(resolve(process.cwd(), 'src/pages/BreachReviewPage.tsx'), 'utf8');
const cctvSource = readFileSync(resolve(process.cwd(), 'src/pages/CCTVReviewPage.tsx'), 'utf8');
const debriefSource = readFileSync(resolve(process.cwd(), 'src/pages/DebriefFollowupPage.tsx'), 'utf8');
const adminShellSource = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');
const agenticFunctionSource = readFileSync(resolve(process.cwd(), '../../supabase/functions/bob-agentic-document-draft/index.ts'), 'utf8');

describe('context-driven document drafting', () => {
  it('supports canonical site, CCTV, notice, breach, and debrief source types', () => {
    expect(studioSource).toContain("sourceType === 'site'");
    expect(studioSource).toContain("sourceType === 'cctv'");
    expect(studioSource).toContain("sourceType === 'notice' || sourceType === 'breach'");
    expect(studioSource).toContain("sourceType === 'debrief'");
    expect(studioSource).toContain("from('client_sites')");
    expect(studioSource).toContain("from('evidence_items')");
    expect(studioSource).toContain("from('breach_alerts')");
    expect(studioSource).toContain("from('shift_debriefs')");
  });

  it('keeps each operational entry point linked to Document Studio', () => {
    expect(locationsSource).toContain('sourceType=site&sourceId=');
    expect(breachSource).toContain('sourceType=${sourceType}&sourceId=${alert.id}');
    expect(cctvSource).toContain('sourceType=cctv&sourceId=${selected.evidence_item_id}');
    expect(debriefSource).toContain('sourceType=debrief&sourceId=');
    expect(adminShellSource).toContain("case 'document-studio':");
    expect(adminShellSource).toContain('<BobDocumentStudioPage />');
  });

  it('marks unknown source fields for human confirmation', () => {
    expect(studioSource).toContain('[TO CONFIRM]');
    expect(studioSource).toContain('approval checklist');
  });

  it('keeps agentic drafting scoped and human-approved', () => {
    expect(studioSource).toContain("searchParams.get('auto') !== '1'");
    expect(studioSource).toContain("functions.invoke('bob-agentic-document-draft'");
    expect(agenticFunctionSource).toContain("['site', 'cctv', 'breach', 'notice', 'debrief']");
    expect(agenticFunctionSource).toContain("eq('organization_id', profile.organization_id)");
    expect(agenticFunctionSource).toContain("submit_bob_document_for_review");
    expect(agenticFunctionSource).not.toContain('request_bob_document_output');
    expect(agenticFunctionSource).not.toContain('review_bob_document_draft');
  });
});
