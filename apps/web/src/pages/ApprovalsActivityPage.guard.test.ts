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
    expect(source).toContain('current scope cannot decide it');
  });
});