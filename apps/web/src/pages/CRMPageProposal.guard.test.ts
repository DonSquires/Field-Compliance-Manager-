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

  it('records the accountable provider branch instead of inferring the root provider', () => {
    expect(page).toContain("create_crm_draft_quote_for_provider");
    expect(page).toContain('p_operating_provider_organization_id: quoteOperatingProviderId');
    expect(page).toContain('Operating provider');
    expect(page).toContain('operating branch');
  });

  it('lets a quote vary an existing operational agreement instead of spawning a second one', () => {
    expect(page).toContain(".from('service_agreements').select('id,name,starts_on,ends_on,invitation_status,agreement_type').eq('client_organization_id', client.id).eq('agreement_type', 'operational')");
    expect(page).toContain('p_service_agreement_id: variedAgreement?.id ?? null');
    expect(page).toContain('What is this quote for?');
    expect(page).toContain('A change to an existing agreement (variation)');
    expect(page).toContain('Nothing changes until the variation is accepted.');
    expect(page).toContain('quoteAgreements.length > 0 && (');
    expect(page).toContain('Draft variation created for ${variedAgreement.name}');
  });

  it('uses the selected branch rate book before an explicit parent template', () => {
    expect(page).toContain(".in('organization_id', providerOrgIds)");
    expect(page).toContain('rule.organization_id === quoteOperatingProviderId || rule.organization_id === state.ownOrg?.id');
    expect(page).toContain("'Operating rate'");
    expect(page).toContain("'Parent template'");
  });

  it('keeps provider-rule pricing explicit and blocks an unselected standard rate', () => {
    expect(page).toContain("value=\"standard_rate_rule\"");
    expect(page).toContain('Choose rate for this work');
    expect(page).toContain("module.pricingBasis === 'standard_rate_rule' && !module.rateRuleId");
    expect(page).toContain('p_rate_rule_id: module.rateRuleId || null');
  });

  it('renders a readable responsive proposal register instead of raw module keys', () => {
    expect(page).toContain('const formatModuleLabel');
    expect(page).toContain("access_control: 'Access Control'");
    expect(page).toContain("bob_assistant: 'Bob Assistant'");
    expect(page).toContain('crm-proposal-module-register');
    expect(page).toContain('Set charges from requirements');
    expect(page).toContain('Service commitment');
    expect(page).toContain('Work and charging');
    expect(page).toContain('Scheduled patrol visits');
    expect(page).toContain('Response target (minutes)');
    expect(page).toContain("set_crm_quote_proposal_work_model");
  });
});