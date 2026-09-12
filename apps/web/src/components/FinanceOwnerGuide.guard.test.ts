import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const guide = readFileSync(resolve(process.cwd(), 'src/components/FinanceOwnerGuide.tsx'), 'utf8');
const page = readFileSync(resolve(process.cwd(), 'src/pages/FinanceBureauPage.tsx'), 'utf8');
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
    expect(page).toContain('<FinanceOwnerGuide onOpenBob={onOpenBob} />');
    expect(shell).toContain("<FinanceBureauPage onOpenBob={() => setBobOpen(true)} />");
  });

  it('starts Bob from a live read-only owner brief', () => {
    expect(guide).toContain("supabase.rpc('get_finance_owner_brief')");
    expect(guide).toContain("Bob's quick check");
    expect(guide).toContain('Bob is checking your finance records');
    expect(guide).toContain('finance-owner-error');
  });
});
