import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const component = readFileSync(resolve(process.cwd(), 'src/components/FinanceApplyWorkspace.tsx'), 'utf8');
const page = readFileSync(resolve(process.cwd(), 'src/pages/FinanceConnectionsPage.tsx'), 'utf8');

describe('Finance Apply workspace', () => {
  it('uses the governed server functions and keeps provider credentials out of the UI', () => {
    expect(component).toContain("supabase.functions.invoke('finance-akahu-apply-application'");
    expect(component).toContain("supabase.functions.invoke('finance-akahu-apply-sharing-request'");
    expect(component).toContain("supabase.functions.invoke('finance-akahu-apply-report'");
    expect(component).toContain("action: 'data'");
    expect(component).toContain('No bank credentials were collected by FCM');
    expect(component).toContain('finance administrator access is required'.replace('finance', 'Finance'));
  });

  it('makes the review boundary explicit', () => {
    expect(component).toContain('do not post transactions, make payments, or submit IRD filings');
    expect(component).toContain('Create report');
    expect(component).toContain('Load review summary');
    expect(component).toContain('Approve selected');
    expect(component).toContain('Promote to reconciliation');
    expect(component).toContain("supabase.functions.invoke('finance-akahu-apply-promote'");
    expect(component).toContain('Finance administrator');
    expect(page).toContain('<FinanceApplyWorkspace />');
  });
});
