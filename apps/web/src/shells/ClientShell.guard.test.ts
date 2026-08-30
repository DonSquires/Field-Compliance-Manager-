import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const shellSource = readFileSync(resolve(process.cwd(), 'src/shells/ClientShell.tsx'), 'utf8');
const pageSource = readFileSync(resolve(process.cwd(), 'src/pages/ClientPortalPage.tsx'), 'utf8');

describe('ClientShell agreement boundary', () => {
  it('only opens notification destinations allowed by the selected agreement', () => {
    expect(shellSource).toContain('<NotificationCenter onNavigate={navigateFromNotification} />');
    expect(shellSource).toContain('allowedPages.has(destination.page)');
  });

  it('uses the canonical agreement access policy for menus and direct routes', () => {
    expect(shellSource).toContain('getClientPortalPages');
    expect(shellSource).toContain('allowedPages.has(activePage)');
    expect(shellSource).toContain('NAVIGATION.filter((item) => allowedPages.has(item.id))');
  });

  it('reads observations only through the client organization and selected locations', () => {
    expect(pageSource).toContain(".eq('client_org_id', profile.organizationId)");
    expect(pageSource).toContain('selectedAgreementSites');
    expect(pageSource).toContain('selectedAgreementZones');
    expect(pageSource).not.toMatch(/from\('observations'\)[\s\S]{0,300}\.insert\(/);
  });

  it('reads report packs by selected service agreement', () => {
    expect(pageSource).toContain(".from('monthly_report_packs')");
    expect(pageSource).toContain(".eq('service_agreement_id', agreement.id)");
  });

  it('does not fabricate client incident or finance surfaces', () => {
    expect(shellSource).not.toContain("id: 'incidents'");
    expect(shellSource).not.toContain("id: 'finance'");
    expect(pageSource).not.toContain("from('officer_field_reports')");
  });
});