import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const guide = readFileSync(resolve(process.cwd(), 'src/components/FinanceOwnerGuide.tsx'), 'utf8');
const page = readFileSync(resolve(process.cwd(), 'src/pages/FinanceBureauPage.tsx'), 'utf8');
const moneyPage = readFileSync(resolve(process.cwd(), 'src/pages/FinanceMoneyPage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');

describe('finance owner guide', () => {
  it('frames Bob as the default operator in plain language', () => {
    expect(guide).toContain('You do not need to be an accountant');
    expect(guide).toContain('What needs my attention?');
    expect(guide).toContain('Prepare my month-end checklist');
    expect(guide).toContain('Explain my business finances');
  });

  it('keeps consequential finance decisions with the owner', () => {
    expect(guide).toContain('Human approval stays with you');
    expect(guide).toContain('never file tax, close a period, pay a bill, or change a number');
  });

  it('opens the existing governed Bob panel from Finance Bureau', () => {
    expect(page).toContain('<FinanceMoneyPage onOpenBob={onOpenBob}');
    expect(moneyPage).toContain("workflow === 'guide' && <FinanceOwnerGuide onOpenBob={onOpenBob} />");
    expect(shell).toContain("<FinanceBureauPage onOpenBob={(prompt) => { setBobLaunchPrompt(prompt); setBobOpen(true); }} onNavigate={navigateFinance} />");
  });

  it('starts Bob from a live read-only owner brief', () => {
    expect(guide).toContain("supabase.rpc('get_finance_owner_brief')");
    expect(guide).toContain("Bob's quick check");
    expect(guide).toContain('Bob is checking your finance records');
    expect(guide).toContain('finance-owner-error');
  });

  it('offers a six-area NZ finance readiness check without calling it compliance', () => {
    expect(guide).toContain("supabase.rpc('assess_bob_nz_finance_readiness')");
    expect(guide).toContain('How ready are we for NZ finance?');
    expect(guide).toContain('not a legal compliance certificate');
    expect(guide).toContain('readiness.overall_score');
  });
});
