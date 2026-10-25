import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const panel = readFileSync(resolve(process.cwd(), 'src/components/CrmAgreementBillingPanel.tsx'), 'utf8');
const dialog = readFileSync(resolve(process.cwd(), 'src/components/CrmAgreementSetupDialog.tsx'), 'utf8');

describe('agreement Contract and Extra view', () => {
  it('reads the governed summary RPC and never writes', () => {
    expect(panel).toContain("supabase.rpc('get_agreement_billing_basis_summary'");
    expect(panel).not.toMatch(/\.(insert|update|upsert|delete)\(/);
  });

  it('has loading, error with retry, permission, empty and all-clear states', () => {
    expect(panel).toContain('Loading contract and Extra totals');
    expect(panel).toContain('onClick={() => void load()}>Retry</button>');
    expect(panel).toContain('Only finance administrators for the provider');
    expect(panel).toContain('No contracted or Extra work recorded for');
    expect(panel).toContain('Every callout has a billing decision');
  });

  it('is reachable from the agreement setup dialog', () => {
    expect(dialog).toContain("view === 'billing' ? <CrmAgreementBillingPanel agreementId={agreement.id} />");
  });
});
