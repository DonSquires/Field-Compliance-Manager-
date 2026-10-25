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

  it('per request jobs carry the client reference through the audited RPC', () => {
    expect(billing).toContain("supabase.rpc('set_dispatch_job_client_reference', { p_job_id: jobId, p_reference: reference, p_reason: reason })");
    expect(consolePage).toContain("selectedCommercialModel === 'per_request' && formClientReference.trim()");
    expect(billing).toContain('Why is the reference changing?');
    expect(billing).toContain('the job cannot be invoiced without it');
  });

  it('agreement billing terms are written only through set_agreement_commercial_terms, with every state shown', () => {
    expect(terms).toContain("supabase.rpc('set_agreement_commercial_terms'");
    expect(terms).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    for (const text of ['Loading billing terms', 'Billing terms could not be loaded', 'No billing model is set', 'Why is the billing model changing?', 'The change is in the audit log', 'role="alert"', 'aria-busy']) {
      expect(terms).toContain(text);
    }
  });
});
