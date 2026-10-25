import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const billing = read('src/components/DispatchBillingBasis.tsx');
const consolePage = read('src/pages/DispatchConsolePage.tsx');
const terms = read('src/components/CrmAgreementCommercialTermsPanel.tsx');

describe('billing follows each client agreement commercial model', () => {
  it('Dispatch asks for Contracted work / Extra only on fixed price + Extra agreements', () => {
    expect(consolePage).toContain('if (formUsesContractExtra && !formBilling)');
    expect(consolePage).toContain('loadCommercialModels(formatted.map((job) => job.serviceAgreementId');
    expect(consolePage).toContain("clientOrderReference: j.client_order_reference ?? null");
    expect(consolePage).toContain('The agreement billing model could not be loaded');
    expect(billing).toContain('if (!usesContractExtra(job.commercialModel)) return <DispatchJobRatedBillingPanel');
  });

  it('per request and do-and-invoice jobs carry the client reference through the audited RPC', () => {
    expect(billing).toContain("supabase.rpc('set_dispatch_job_client_reference', { p_job_id: jobId, p_reference: reference, p_reason: reason })");
    expect(consolePage).toContain('takesClientReference(selectedCommercialModel) && formClientReference.trim()');
    expect(consolePage).toContain('model={selectedCommercialModel} limit={selectedStandingAuthorityLimit}');
    expect(consolePage).toContain('job.standingAuthorityLimit = job.serviceAgreementId ? jobLimits.get(job.serviceAgreementId) ?? null : null;');
    expect(billing).toContain("export const takesClientReference = (model: CommercialModel | null | undefined) => model === 'per_request' || model === 'do_and_invoice';");
    expect(billing).toContain('Why is the reference changing?');
    expect(billing).toContain('the job cannot be invoiced without it');
  });

  it('do and invoice reads as standing authority at actuals, never as agreed rates', () => {
    expect(billing).toContain('Client approval reference');
    expect(billing).toContain('Record client approval');
    expect(billing).toContain('without it a job over the limit cannot be invoiced');
    expect(billing).toContain('No standing authority limit is set for this client');
    expect(terms).toContain('standing_authority_limit,updated_at');
    expect(terms).toContain("form.model === 'do_and_invoice' && <label");
    expect(terms).toContain('Standing authority limit per job');
    expect(terms).toContain('Leave blank if the client has not set a cap.');
  });

  it('agreement billing terms are written only through set_agreement_commercial_terms, with every state shown', () => {
    expect(terms).toContain("supabase.rpc('set_agreement_commercial_terms'");
    expect(terms).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    for (const text of ['Loading billing terms', 'Billing terms could not be loaded', 'No billing model is set', 'Why is the billing model changing?', 'The change is in the audit log', 'role="alert"', 'aria-busy']) {
      expect(terms).toContain(text);
    }
  });
});
