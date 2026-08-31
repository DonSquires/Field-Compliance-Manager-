import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/CRMPage.tsx'), 'utf8');

describe('governed CRM accounts', () => {
  it('loads account context in batches including real primary contacts', () => {
    expect(page).toMatch(/\.from\(["']crm_contacts["']\)/);
    expect(page).toMatch(/\.from\(["']client_sites["']\)/);
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

  it('operates account relationships and invoice lifecycle through governed RPCs', () => {
    expect(page).toContain('CrmAccountWorkspace');
    expect(page).toMatch(/\.from\(["']invoices["']\)/);
    expect(page).toMatch(/\.rpc\(["']manage_crm_invoice["']/);
    expect(page).not.toMatch(/\.from\(["']invoices["']\)\.update/);
  });

  it('searches and manages the organization spine with evidence-backed next actions', () => {
    expect(page).toContain('CrmOrganizationDialog');
    expect(page).toMatch(/\.rpc\(["']get_crm_organization_readiness["']/);
    expect(page).toContain('Add organization');
    expect(page).toContain('client.next_action');
    expect(page).not.toMatch(/\.from\(["']organizations["']\)\.insert/);
  });
});