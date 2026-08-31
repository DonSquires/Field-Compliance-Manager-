/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/AccountOnboardingPage.tsx'), 'utf8');

describe('Account Onboarding failure state', () => {
  it('clears stale queue state when the governed RPC fails', () => {
    expect(source).toContain('supabase.rpc("get_crm_onboarding_workspace")');
    expect(source).toContain('supabase.rpc("get_crm_onboarding_assignees")');
  });

  it('hides queue metrics and empty-state claims while data is unavailable', () => {
    expect(source).toContain('if (loadError)');
    expect(source).toContain('Onboarding data unavailable');
    expect(source).toContain('Queue totals');
    expect(source).toContain('account status are hidden until the service responds.');
    expect(source).toContain('"Retrying"');
    expect(source).toContain('"Retry"');
  });

  it('keeps governed action rejections inside the loaded workspace', () => {
    expect(source).toContain('if (actionError) setError(actionError.message)');
    expect(source).toContain('className="onboarding-message is-error"');
  });

  it('uses governed workflow ownership and immutable history RPCs', () => {
    expect(source).toContain('"manage_crm_onboarding_workflow"');
    expect(source).toContain('"get_crm_onboarding_history"');
    expect(source).toContain('aria-label="Workflow owner"');
    expect(source).toContain('aria-label="Stage note"');
    expect(source).not.toContain("supabase.from('crm_onboarding_events')");
  });
});
