import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/ApprovalsActivityPage.tsx'), 'utf8');

describe('governed approvals workbench', () => {
  it('loads tree-scoped activity through the canonical RPC', () => {
    expect(source).toContain("rpc('get_approvals_activity'");
    expect(source).not.toContain(".from('bob_agentic_actions')");
  });

  it('requires reasoning and uses the governed decision edge function', () => {
    expect(source).toContain("functions.invoke('bob-proposal-approver'");
    expect(source).toContain('reasoning: reasoning.trim()');
    expect(source).toContain('required rows={4}');
  });

  it('sanitizes payload display and surfaces apply failures honestly', () => {
    expect(source).toContain('formatGovernedPayload');
    expect(source).toContain('response?.apply_error');
    expect(source).toContain('Approval recorded, but application failed');
  });

  it('respects the RPC decision-authority flag', () => {
    expect(source).toContain('selected.can_decide');
    expect(source).toContain('assigned_approver_name');
    expect(source).toContain('Decision owner');
    expect(source).toContain('Your authority');
    expect(source).toContain('owns this decision');
    expect(source).not.toContain('Decision authority</dt><dd>');
  });

  it('promotes classified document versions through the tenant-scoped edge function', () => {
    expect(source).toContain("functions.invoke('bob-document-promote'");
    expect(source).toContain('document_version_id: document.version_id');
    expect(source).toContain("target_scope: 'tenant_reference'");
    expect(source).not.toMatch(/from\('(documents|document_versions|document_classifications)'\)[\s\S]{0,240}\.(insert|update|upsert|delete)\(/);
  });
});