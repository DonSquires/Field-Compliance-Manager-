import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/CRMPage.tsx'), 'utf8');
const workspace = readFileSync(resolve(process.cwd(), 'src/components/CrmAccountWorkspace.tsx'), 'utf8');
const organizationDialog = readFileSync(resolve(process.cwd(), 'src/components/CrmOrganizationDialog.tsx'), 'utf8');

describe('governed CRM accounts', () => {
  it('loads account context in batches including real primary contacts', () => {
    expect(page).toMatch(/\.from\(["']crm_contacts["']\)/);
    expect(page).toMatch(/\.from\(["']client_sites["']\)/);
    expect(page).toContain(".in('client_organization_id', accountIds)");
    expect(page).toContain('site.client_organization_id === acct.id');
    expect(page).toMatch(/\.from\(["']quotes["']\)/);
    expect(page).not.toContain('for (const acct of (accounts ?? []))');
    expect(page).toContain('primary_contact_name: primaryContacts.get(acct.id) ?? null');
  });

  it('creates draft quotes only through the governed RPC', () => {
    expect(page).toMatch(/supabase\.rpc\(["']create_crm_draft_quote_for_provider["']/);
    expect(page).toContain('quoteRequestId.current');
    expect(page).not.toMatch(/\.from\(["']quotes["']\)\.insert/);
  });

  it('adds explicit cost and charge lines through the governed pricing RPC', () => {
    expect(page).toMatch(/supabase\.rpc\(["']add_crm_quote_line["']/);
    expect(page).toContain('Provider unit cost');
    expect(page).toContain('Client unit charge');
    expect(page).not.toMatch(/\.from\(["']quote_lines["']\)\.insert/);
  });

  it('edits draft quote lines through the governed replay-safe correction RPC', () => {
    expect(page).toMatch(/supabase\.rpc\(["']update_crm_quote_line["']/);
    expect(page).toContain('updateLineRequestId.current');
    expect(page).toContain('Edit provider unit cost');
    expect(page).toContain('Edit client unit charge');
    expect(page).toContain('Save line');
    expect(page).toContain('cancelQuoteLineEdit');
    expect(page).not.toMatch(/\.from\(["']quote_lines["']\)\.update/);
  });

  it('sends and accepts or declines only through the governed lifecycle RPC', () => {
    expect(page).toMatch(/\.rpc\(["']manage_crm_quote["']/);
    expect(page).toContain('Confirm acceptance');
    expect(page).toContain('Decline reason');
    expect(page).not.toMatch(/\.rpc\(["']accept_quote["']/);
  });

  it('continues an accepted quote into its server-confirmed agreement', () => {
    expect(page).toContain('receipt.service_agreement_id');
    expect(page).toContain("quoteAction === 'accept' && !agreementId");
    expect(page).toContain('Open service agreement');
    expect(page).toContain("onNavigate('relationships', { accountId: quoteAcceptance.accountId, agreementId: quoteAcceptance.agreementId })");
  });

  it('operates account relationships and invoice lifecycle through governed RPCs', () => {
    expect(page).toContain('CrmAccountWorkspace');
    expect(page).toMatch(/\.from\(["']invoices["']\)/);
    expect(page).toMatch(/\.rpc\(["']manage_crm_invoice["']/);
    expect(page).not.toMatch(/\.from\(["']invoices["']\)\.update/);
  });

  it('groups organization-owned place records as house, site, and zone facets', () => {
    expect(workspace).toMatch(/\.from\(["']locations["']\)/);
    expect(workspace).toMatch(/\.eq\(["']organization_id["'], account\.id\)/);
    expect(workspace).toMatch(/\.from\(["']client_sites["']\)/);
    expect(workspace).toMatch(/\.eq\(["']client_organization_id["'], account\.id\)/);
    expect(workspace).toMatch(/\.from\(["']location_zones["']\)/);
    expect(workspace).toContain('Location / house');
    expect(workspace).toContain("Find, reuse, or create this organization\\'s location houses, sites, zones, boundaries, and closures.");
  });

  it('creates location houses inside the selected organization workspace', () => {
    expect(workspace).toContain("supabase.rpc('manage_crm_location'");
    expect(workspace).toContain("supabase.rpc('find_crm_location_candidates'");
    expect(workspace).toContain('Find or add location');
    expect(workspace).toContain('Open existing place');
    expect(workspace).not.toContain("onNavigate?.('locations'");
  });

  it('keeps proposals below the organization level and exposes organization editing', () => {
    expect(workspace).toContain('onEditOrganization');
    expect(workspace).toContain('Edit organization details');
    expect(page).toContain("onEditOrganization={(organization) => setOrganizationDialog(organization)}");
    expect(page).toContain("save_discovered_org_as_client");
    expect(workspace).toContain('Save as client organization');
    expect(workspace).toContain('onCreateProposal(account, { siteId: site.id');
    expect(workspace).toContain('onCreateProposal(account, { zoneId: zone.id');
    expect(workspace).not.toContain('Start a module-based commercial proposal for this organization.');
  });

  it('keeps real child organizations, module scope, and geofence defaults in the organization workspace', () => {
    expect(workspace).toMatch(/\.from\(["']organizations["']\)[\s\S]*\.eq\(["']parent_organization_id["'], account\.id\)/);
    expect(workspace).toMatch(/\.from\(["']organization_modules["']\)/);
    expect(workspace).toMatch(/\.from\(["']org_geofence_config["']\)/);
    expect(workspace).toMatch(/view === ["']structure["']/);
    expect(workspace).toContain('Add child organization');
    expect(workspace).toContain("supabase.rpc('manage_crm_organization_child'");
    expect(workspace).toContain('Client department');
    expect(workspace).toContain('What belongs in this hierarchy');
    expect(workspace).toContain('a First Security delivery region with its own staff, clients, pricing, rosters, and agreements');
    expect(workspace).toContain('it owns a budget, service area, or agreement');
    expect(workspace).toContain("{!showChildOrganizationForm && <button");
    expect(workspace).toMatch(/onOpenAccount\?\.\(\{[\s\S]*id: child\.id,[\s\S]*name: child\.name,[\s\S]*status: child\.status/);
  });

  it('shows agreement billing readiness before generating an invoice and does not offer fallback billing', () => {
    expect(page).toContain("supabase.from('crm_commercial_settings')");
    expect(page).toContain(".eq('status', 'accepted')");
    expect(page).toContain("agreement.invitation_status === 'accepted'");
    expect(page).toContain("invoiceReadiness?.source === 'missing'");
    expect(page).toContain('Configure accepted quote lines or commercial settings before creating a draft invoice.');
  });

  it('shows a provider tenant its own platform subscription and invoices only its operational agreements', () => {
    expect(page).toContain(".eq('client_organization_id', orgId)");
    expect(page).toContain(".eq('agreement_type', 'financial')");
    expect(page).toContain('Platform Subscription');
    expect(page).toContain("agreement.provider_organization_id === (operatingOrganizationId ?? profile?.organizationId) && agreement.invitation_status === 'accepted'");
  });

  it('shows parent oversight through a branch-preserving consolidated commercial read model', () => {
    expect(page).toContain("supabase.rpc('get_consolidated_commercial_overview'");
    expect(page).toContain('consolidatedCommercial: (consolidatedCommercial as ConsolidatedCommercialRow[]) ?? []');
    expect(page).toContain('Group commercial oversight');
    expect(page).toContain('row.source_organization_name');
    expect(page).toContain('Branch-owned commercial activity, consolidated for parent oversight.');
  });

  it('loads client portfolios through their accountable operating provider branch', () => {
    expect(page).toContain("supabase.rpc('get_crm_provider_portfolio'");
    expect(page).toContain('operating_provider_organization_id');
    expect(page).toContain('Operating provider: ${client.operating_provider_name}');
    expect(page).toContain('client.operating_provider_organization_id ?? operatingOrganizationId ?? profile?.organizationId');
    expect(page).toContain('Client Portfolios');
  });

  it('opens the exact account workspace once from explicit URL context', () => {
    expect(page).toContain('openedContextAccountId');
    expect(page).toContain('account.id === requestedAccountId');
    expect(page).toContain('setWorkspaceAccount({ id: requestedAccount.id, name: requestedAccount.name,');
  });

  it('clears CRM loading state when operating organization scope is unavailable', () => {
    expect(page).toContain('if (!orgId) {');
    expect(page).toContain('loading: false');
    expect(page).toContain('setState((s) => ({ ...s, loading: false, error: null }));');
  });

  it('searches and manages the organization spine with evidence-backed next actions', () => {
    expect(page).toContain('CrmOrganizationDialog');
    expect(page).toMatch(/\.rpc\(["']get_crm_organization_readiness["']/);
    expect(page).toContain('Set up a new client');
    expect(page).toContain("onNavigate('client-setup')");
    expect(page).toContain('Add other organisation');
    expect(page).toContain('client.next_action');
    expect(organizationDialog).toMatch(/Search all FCM organizations by name, NZBN, or an owned-place[\s\S]*address before creating/);
    expect(organizationDialog).toMatch(/Search results reveal identity details[\s\S]*service-specific contacts are added during setup/);
    expect(organizationDialog).toContain('Organization name or address');
    expect(organizationDialog).toContain('Search Companies Register');
    expect(organizationDialog).toContain('companies/app/ui/pages/companies/search?advancedPanel=true');
    expect(organizationDialog).toContain('candidate.manageable &&');
    expect(organizationDialog).toContain('onClick={() => onOpenAccount(candidate)}');
    expect(organizationDialog).toContain('Open account');
    expect(organizationDialog).toContain('!candidate.manageable &&');
    expect(organizationDialog).toContain('onClick={() => onUseOrganization(candidate)}');
    expect(organizationDialog).toContain('Open organization');
    expect(page).toContain('onUseOrganization={(organization) =>');
    expect(page).toContain("setWorkspaceInitialView('sites')");
    expect(page).not.toMatch(/\.from\(["']organizations["']\)\.insert/);
  });
});