import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../../supabase/migrations/20260905003300_allow_quote_to_discovered_organization.sql'),
  'utf8',
);

describe('discovered organization service proposals', () => {
  it('allows a CRM administrator to propose service to any active existing organization', () => {
    expect(migration).toContain('An active organization is required for a service proposal');
    expect(migration).toContain("v_client.status <> 'active'");
    expect(migration).toContain('A provider cannot create a service proposal for itself');
  });

  it('records proposal-only commercial intent without creating service authority', () => {
    expect(migration).toContain("'relationship_state','proposal_only'");
    expect(migration).not.toMatch(/insert\s+into\s+public\.service_agreements\b/i);
    expect(migration).not.toMatch(/insert\s+into\s+public\.service_agreement_locations\b/i);
    expect(migration).not.toMatch(/insert\s+into\s+public\.service_agreement_modules\b/i);
  });

  it('keeps quote creation authenticated, idempotent, and audited', () => {
    expect(migration).toContain('Active CRM administrator required');
    expect(migration).toContain('client_request_id is required');
    expect(migration).toContain('quote.client_request_id = p_client_request_id');
    expect(migration).toContain("'crm_draft_quote_created'");
  });
});
