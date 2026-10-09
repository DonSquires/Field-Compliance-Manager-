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
    expect(pageSource).toContain('pdf_renderer_version');
    expect(pageSource).toContain("report.status === 'sent' || report.pdf_renderer_version === 'fcm-report-pack-pdf-lib-a4-v5'");
  });

  it('keeps client finance behind the canonical agreement capability boundary', () => {
    expect(shellSource).not.toContain("id: 'incidents'");
    expect(shellSource).toContain("id: 'finance'");
    expect(shellSource).toContain('allowedPages.has(item.id)');
    expect(pageSource).toContain(".from('invoices')");
    expect(pageSource).not.toContain("from('officer_field_reports')");
  });

  it('starts agreement-scoped records in a loading state to avoid empty-state flicker', () => {
    expect(pageSource).toContain('useState(true)');
    expect(pageSource).toContain('setLoadingRecords(false);');
    expect(pageSource).toContain('Loading invoices');
    expect(pageSource).toContain('Loading report packs');
  });
});