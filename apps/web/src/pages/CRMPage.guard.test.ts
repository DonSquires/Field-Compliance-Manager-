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
    expect(page).not.toContain('primary_contact_name: null');
  });

  it('creates draft quotes only through the governed RPC', () => {
    expect(page).toMatch(/supabase\.rpc\(["']create_crm_draft_quote["']/);
    expect(page).toContain('quoteRequestId.current');
    expect(page).not.toMatch(/\.from\(["']quotes["']\)\.insert/);
  });

  it('adds explicit cost and charge lines through the governed pricing RPC', () => {
    expect(page).toMatch(/supabase\.rpc\(["']add_crm_quote_line["']/);
    expect(page).toContain('Provider unit cost');
    expect(page).toContain('Client unit charge');
    expect(page).not.toMatch(/\.from\(["']quote_lines["']\)\.insert/);
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
    expect(workspace).toContain(".from('locations')");
    expect(workspace).toContain(".eq('organization_id', account.id)");
    expect(workspace).toContain(".from('client_sites')");
    expect(workspace).toContain(".eq('client_organization_id', account.id)");
    expect(workspace).toContain(".from('location_zones')");
    expect(workspace).toContain('Location / house');
    expect(workspace).toContain('Client-owned houses with their sibling site and zone facets.');
  });

  it('keeps real child organizations, module scope, and geofence defaults in the organization workspace', () => {
    expect(workspace).toContain(".from('organizations').select('id,name,organization_type,status').eq('parent_organization_id', account.id)");
    expect(workspace).toContain(".from('organization_modules')");
    expect(workspace).toContain(".from('org_geofence_config')");
    expect(workspace).toContain("view === 'structure'");
    expect(workspace).toContain('Branches and divisions');
    expect(workspace).toContain('A service agreement, not the organization tree, authorizes a provider');
    expect(workspace).toContain('onOpenAccount?.({ id: child.id, name: child.name, status: child.status })');
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
    expect(page).toContain("agreement.provider_organization_id === profile?.organizationId && agreement.invitation_status === 'accepted'");
  });

  it('opens the exact account workspace once from explicit URL context', () => {
    expect(page).toContain('openedContextAccountId');
    expect(page).toContain('account.id === requestedAccountId');
    expect(page).toContain('setWorkspaceAccount({ id: requestedAccount.id, name: requestedAccount.name,');
  });

  it('searches and manages the organization spine with evidence-backed next actions', () => {
    expect(page).toContain('CrmOrganizationDialog');
    expect(page).toMatch(/\.rpc\(["']get_crm_organization_readiness["']/);
    expect(page).toContain('Add organization');
    expect(page).toContain('client.next_action');
    expect(organizationDialog).toContain('Organization, company number, address, client ID, or contact');
    expect(organizationDialog).toContain('close spellings are included');
    expect(organizationDialog).toContain('Search Companies Register');
    expect(organizationDialog).toContain('companies/app/ui/pages/companies/search?advancedPanel=true');
    expect(organizationDialog).toContain('candidate.manageable &&');
    expect(organizationDialog).toContain('onClick={() => onOpenAccount(candidate)}');
    expect(organizationDialog).toContain('Open account');
    expect(page).not.toMatch(/\.from\(["']organizations["']\)\.insert/);
  });
});