import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(process.cwd(), '../..');
const retirement = readFileSync(
  resolve(root, 'supabase/migrations/20261014205149_retire_implicit_draft_quote_creation.sql'),
  'utf8',
);
const schema = readFileSync(resolve(root, 'supabase/schema.sql'), 'utf8');
const databaseTypes = readFileSync(resolve(root, 'src/types/database.ts'), 'utf8');
const crmPage = readFileSync(resolve(root, 'apps/web/src/pages/CRMPage.tsx'), 'utf8');
const fixtures = readFileSync(resolve(root, 'apps/web/e2e/fixtures.ts'), 'utf8');

describe('implicit draft quote creation retirement', () => {
  it('removes the home-provider quote authority', () => {
    expect(retirement).toContain(
      'DROP FUNCTION IF EXISTS public.create_crm_draft_quote(',
    );
    expect(schema).not.toMatch(
      /CREATE (OR REPLACE )?FUNCTION "public"\."create_crm_draft_quote"/,
    );
    expect(databaseTypes).not.toMatch(/\n      create_crm_draft_quote:/);
    expect(fixtures).not.toContain("table === 'create_crm_draft_quote'");
  });

  it('keeps selected operating-provider quote creation wired', () => {
    expect(schema).toMatch(
      /CREATE (OR REPLACE )?FUNCTION "public"\."create_crm_draft_quote_for_provider"/,
    );
    expect(databaseTypes).toMatch(/\n      create_crm_draft_quote_for_provider:/);
    expect(crmPage).toContain("supabase.rpc('create_crm_draft_quote_for_provider'");
    expect(crmPage).toContain(
      'p_operating_provider_organization_id: quoteOperatingProviderId',
    );
    expect(fixtures).toContain("table === 'create_crm_draft_quote_for_provider'");
  });

  it('preserves retry identity, prospect and variation governance', () => {
    expect(schema).toContain('p_client_request_id is null');
    expect(schema).toContain('crm_onboarding_ledgers');
    expect(schema).toContain('p_service_agreement_id is not null');
    expect(schema).toContain("'variation_of_agreement'");
    expect(crmPage).toContain('quoteRequestId.current');
  });
});
