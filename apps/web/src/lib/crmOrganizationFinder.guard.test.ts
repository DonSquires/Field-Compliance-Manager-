import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../../supabase/migrations/20260905003000_expand_crm_organization_finder.sql'),
  'utf8',
);

describe('CRM organization finder', () => {
  it('keeps organization discovery limited to organizations visible to the CRM actor', () => {
    expect(migration).toContain('Active CRM administrator required');
    expect(migration).toContain('with visible_organizations as');
    expect(migration).toContain('organization.discoverable');
    expect(migration).toContain('limit 20;');
  });

  it('finds records through names, spelling-tolerant names, company identifiers, places, and contacts', () => {
    expect(migration).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions');
    expect(migration).toContain('extensions.similarity(lower(organization.name), v_query) >= 0.35');
    expect(migration).toContain('organization.company_registration_number');
    expect(migration).toContain('Exact Companies Office number');
    expect(migration).toContain('site.address');
    expect(migration).toContain('site.external_ref');
    expect(migration).toContain('site.internal_client_ref');
    expect(migration).toContain('location.address');
    expect(migration).toContain("contact.first_name || ' ' || contact.last_name");
    expect(migration).toContain('Exact NZBN');
  });

  it('does not broaden discovery into financial or staff-sensitive records', () => {
    expect(migration).not.toMatch(/(invoices|payroll|bank_account|staff_profiles)/i);
  });
});
