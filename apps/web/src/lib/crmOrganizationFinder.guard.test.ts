import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../../supabase/migrations/20260905003000_expand_crm_organization_finder.sql'),
  'utf8',
);
const wordSimilarityMigration = readFileSync(
  resolve(process.cwd(), '../../supabase/migrations/20260905003100_crm_organization_finder_word_similarity.sql'),
  'utf8',
);
const manageableBooleanMigration = readFileSync(
  resolve(process.cwd(), '../../supabase/migrations/20260905003200_crm_organization_finder_manageable_boolean.sql'),
  'utf8',
);

describe('CRM organization finder', () => {
  it('allows active CRM administrators to discover all organization identities for duplicate prevention', () => {
    expect(migration).toContain('Active CRM administrator required');
    expect(migration).toContain('from public.organizations organization');
    expect(migration).not.toContain('organization.discoverable');
    expect(migration).toContain('limit 20;');
  });

  it('finds records through names, spelling-tolerant names, NZBN, and owned-place addresses only', () => {
    expect(migration).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions');
    expect(migration).toContain('extensions.similarity(lower(organization.name), v_query) >= 0.35');
    expect(migration).toContain('site.address');
    expect(migration).toContain('location.address');
    expect(migration).toContain('Exact NZBN');
  });

  it('does not expose contacts, client identifiers, finance, or staff-sensitive records', () => {
    expect(migration).not.toMatch(/(crm_contacts|external_ref|internal_client_ref|company_registration_number|invoices|payroll|bank_account|staff_profiles)/i);
  });

  it('matches typo-tolerant terms inside multi-word organization names', () => {
    expect(wordSimilarityMigration).toContain("extensions.word_similarity(v_query, lower(organization.name)) >= 0.5");
    expect(wordSimilarityMigration).toContain("case when match.match_rank = 5 then extensions.word_similarity(v_query, lower(match.name))");
    expect(wordSimilarityMigration).not.toMatch(/crm_contacts|external_ref|internal_client_ref|company_registration_number/i);
  });

  it('returns an explicit manageability result from the caller and relationship data', () => {
    expect(manageableBooleanMigration).toContain('coalesce(match.id = v_provider or match.parent_organization_id = v_provider or public.crm_actor_can_manage_account(match.id), false)');
    expect(manageableBooleanMigration).not.toContain('First Security');
    expect(manageableBooleanMigration).not.toContain('LINZ');
  });
});
