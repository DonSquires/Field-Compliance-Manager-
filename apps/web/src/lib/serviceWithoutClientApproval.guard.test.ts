import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

// Owner ruling 2026-11-01 (docs/canon/ORG_SERVICE_MODEL.md): client approval is not a condition of
// service. invitation_status records the client-portal invitation lifecycle only, so provider-side
// screens must not hide agreements, actions or invoices until a client accepts.
const providerSurfaces = [
  'src/pages/CRMPage.tsx',
  'src/pages/ClientSetupPage.tsx',
  'src/pages/InvestigationPage.tsx',
  'src/pages/RelationshipWorkspacePage.tsx',
  'src/components/ServiceClientWorkspace.tsx',
  'src/components/CustomReportBuilder.tsx',
  'src/components/FinanceControlPanel.tsx',
  'src/components/FinanceLabourCostWorkspace.tsx',
  'src/components/RepeatSubjectsPanel.tsx',
];

describe('service without client approval', () => {
  it.each(providerSurfaces)('%s does not gate provider work on portal acceptance', (file) => {
    const source = read(file);
    expect(source).not.toMatch(/\.eq\(\s*'invitation_status'/);
    expect(source).not.toMatch(/\.in\(\s*'invitation_status'/);
    expect(source).not.toMatch(/&&\s*\w+\.invitation_status\s*===\s*'accepted'/);
    expect(source).not.toMatch(/invitation_status\s*===\s*'accepted'\s*&&/);
    expect(source).not.toContain('engagement_confirmation');
  });

  it('treats a current operational agreement as engagement', () => {
    const workspace = read('src/components/ServiceClientWorkspace.tsx');
    expect(workspace).toContain("&& (!item.ends_on || item.ends_on >= today));");
    expect(workspace).toContain('Service does not wait for client approval');
  });

  it('counts agreements in force rather than accepted invitations', () => {
    const relationships = read('src/pages/RelationshipWorkspacePage.tsx');
    expect(relationships).toContain('<SummaryCard label="In force"');
    expect(relationships).toContain("{relationship.agreement_type === 'operational' && <><button");
  });

  it('keeps the client-portal invitation status visible as portal status', () => {
    expect(read('src/pages/AccountOnboardingPage.tsx')).toContain("selected.invitation_status === 'accepted'");
    expect(read('src/components/CrmOnboardingPanel.tsx')).toContain("const clientAccepted = seated && invitationStatus === 'accepted';");
  });
});
