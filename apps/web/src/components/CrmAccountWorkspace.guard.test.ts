import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/components/CrmAccountWorkspace.tsx'), 'utf8');

describe('client portfolio hub', () => {
  it('loads dispatch history through account agreements so Site and Zone jobs are included', () => {
    expect(source).toContain(".in('service_agreement_id', agreementIds)");
    expect(source).toContain('service_agreement_id,client_site_id,zone_id');
    expect(source).not.toContain(".in('client_site_id', siteIds)");
  });

  it('keeps modules inside the organization portfolio context', () => {
    expect(source).toContain('Modules');
    expect(source).toContain('organizationModules.filter((module) => module.enabled)');
    expect(source).toContain('Modules radiate from this portfolio');
    expect(source).toContain('module_key.replaceAll');
  });

  it('keeps places and finance as portfolio views', () => {
    expect(source).toContain('Places <strong>{locations.length}</strong>');
    expect(source).toContain('Finance <strong>');
    expect(source).toContain('Location house 360');
  });

  it('keeps schedules in the portfolio while handing staff assignment to roster', () => {
    expect(source).toContain('Operations <strong>{deliverySchedules.length}</strong>');
    expect(source).toContain('Schedules and roster readiness stay in the portfolio context');
    expect(source).toContain("onNavigate?.('roster'");
    expect(source).toContain('deliverySchedules.map');
  });

  it('provides one portfolio readiness checklist for the next human action', () => {
    expect(source).toContain('>Readiness</button>');
    expect(source).toContain('crm-readiness-list');
    expect(source).toContain('Organization identity');
    expect(source).toContain('No recorded activation blockers');
  });

  it('shows the corporate hub status at the top of the portfolio', () => {
    expect(source).toContain('Client access');
    expect(source).toContain('Commercial agreement');
    expect(source).toContain('Schedules');
    expect(source).toContain('headlineInvitation');
    expect(source).toContain('onClick={() => setView(\'readiness\')}');
    expect(source).toContain('onClick={() => setView(\'operations\')}');
  });

  it('preserves the legacy account-flow progression inside the portfolio', () => {
    expect(source).toContain('Client portfolio account flow');
    expect(source).toContain("{ label: 'Agreement'");
    expect(source).toContain("{ label: 'Handoff'");
    expect(source).toContain('crm-portfolio-flow');
  });

  it('makes Bob portfolio scoping visible without creating a second assistant surface', () => {
    expect(source).toContain('Bob uses this portfolio context');
    expect(source).not.toContain('onspace-ai-chat');
  });

  it('shows live record freshness without inventing a separate audit source', () => {
    expect(source).toContain('portfolioUpdatedAt');
    expect(source).toContain('Live account record updated');
  });

  it('shows where corporate work is maintained from the portfolio overview', () => {
    expect(source).toContain('Where work lives');
    expect(source).toContain('identity and relationship');
    expect(source).toContain('schedules and coverage');
  });

  it('prevents invalid branch creation under a client parent', () => {
    expect(source).toContain('const childType = !canAddBranch');
    expect(source).toContain("'department' : childOrganizationForm.type");
  });

  it('offers only current report-pack PDFs for preview and download', () => {
    expect(source).toContain('pdf_source_updated_at === pack.updated_at');
    expect(source).toContain('pack.pdf_renderer_version === CURRENT_REPORT_PDF_RENDERER');
    expect(source).toContain('GeneratedArtifactActions bucket="bob-uploads"');
    expect(source).toContain('pdf_path,pdf_renderer_version,pdf_source_updated_at');
  });

  it('attaches tender sources through the governed provenance RPC', () => {
    expect(source).toContain("supabase.rpc('attach_tender_document'");
    expect(source).toContain("supabase.storage.from('bob-uploads').upload");
    expect(source).toContain("supabase.storage.from('bob-uploads').remove");
    expect(source).toContain("crypto.subtle.digest('SHA-256'");
    expect(source).toContain("Tender source hashing failed:");
    expect(source).toContain("upsert: false");
    expect(source).toContain("Tender source attached as unreviewed evidence.");
    expect(source).not.toContain(".from('tender_documents').insert");
  });
});