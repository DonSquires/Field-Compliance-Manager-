import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/CRMPage.tsx'), 'utf8');

describe('CRM proposal package', () => {
  it('selects commercial modules before pricing and persists them through the governed RPC', () => {
    expect(page).toContain(".from('module_catalog')");
    expect(page).toContain(".from('rate_rules')");
    expect(page).toContain(".eq('rule_kind', 'billing')");
    expect(page).toContain("manage_crm_quote_proposal_module");
    expect(page).toContain('Quoted modules');
    expect(page).toContain('proposalModules.length === 0');
  });

  it('keeps provider-rule pricing explicit and blocks an unselected standard rate', () => {
    expect(page).toContain("value=\"standard_rate_rule\"");
    expect(page).toContain('Select provider rate');
    expect(page).toContain("module.pricingBasis === 'standard_rate_rule' && !module.rateRuleId");
    expect(page).toContain('p_rate_rule_id: module.rateRuleId || null');
  });
});