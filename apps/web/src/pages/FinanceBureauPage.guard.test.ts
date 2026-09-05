import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/FinanceBureauPage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');

describe('Finance Bureau', () => {
  it('uses governed discount schedule commands rather than direct browser writes', () => {
    expect(page).toContain(".from('commercial_discount_schedules')");
    expect(page).toContain(".from('commercial_discount_schedule_rules')");
    expect(page).toContain(".rpc('manage_commercial_discount_schedule'");
    expect(page).toContain(".rpc('manage_commercial_discount_schedule_rule'");
    expect(page).not.toMatch(/\.from\(['"]commercial_discount_schedules['"]\)\.insert/);
    expect(page).not.toMatch(/\.from\(['"]commercial_discount_schedule_rules['"]\)\.insert/);
  });

  it('is a dedicated provider workspace alongside the reusable rate book', () => {
    expect(page).toContain('Provider-owned commercial schedules');
    expect(page).toContain('Rate books remain in Rate Rules');
    expect(shell).toContain("'finance-bureau'");
    expect(shell).toContain('Pricing, Discounts & Tenders');
    expect(shell).toContain('<FinanceBureauPage />');
  });
});