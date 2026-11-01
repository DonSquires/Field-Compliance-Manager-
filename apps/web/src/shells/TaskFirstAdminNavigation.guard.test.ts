/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const shell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');
const crm = readFileSync(resolve(process.cwd(), 'src/pages/CRMPage.tsx'), 'utf8');
const crmStyles = readFileSync(resolve(process.cwd(), 'src/pages/CRMPage.css'), 'utf8');
const site = readFileSync(resolve(process.cwd(), 'src/pages/SiteDetailPage.tsx'), 'utf8');

describe('task-first client delivery navigation', () => {
  it('keeps optional activation and handoff destinations directly reachable', () => {
    expect(shell).toContain("label: 'Activation checklist'");
    expect(shell).toContain("label: 'Service handoffs'");
    expect(shell).not.toContain('WorkflowRail');
  });

  it('links follow-up work from the client directory, where the workspace toolbar is hidden', () => {
    expect(shell).toMatch(/showWorkspaceNavigation = ![^;]*'crm'/);
    expect(crm).toContain('aria-label="Client follow-up work"');
    expect(crm).toContain("{ page: 'relationships', label: 'Agreements & services' }");
    expect(crm).toContain("{ page: 'onboarding', label: 'Activation checklist' }");
    expect(crm).toContain("{ page: 'handoffs', label: 'Service handoffs' }");
    expect(crm).toContain('onNavigate(link.page)');
  });

  it('keeps the phone directory inside the viewport so follow-up links are not clipped', () => {
    expect(crmStyles).toMatch(/@media\(max-width:720px\)\{\.crm-page\.is-directory-workbench\{[^}]*width:100%/);
  });

  it('preserves explicit URL context at the shell routing boundary', () => {
    expect(shell).toContain('workflowContextQuery(context)');
    expect(shell).toContain('readWorkflowContext(location.search)');
  });

  it('loads contracted sites through the governed geography boundary', () => {
    expect(site).toContain("supabase.rpc('get_crm_operational_geography')");
    expect(site).not.toContain(".eq('client_organization_id', orgId)");
  });
});