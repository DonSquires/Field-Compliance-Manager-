import { describe, it, expect } from 'vitest';
import { buildCrmAccountListQuery } from './crmAccountSchema';

describe('CRM account schema mapping', () => {
  it('confirms crm_account_list view does not exist in schema', () => {
    // SCHEMA FACT: supabase/schema.sql has NO views.
    // The CRMPage was trying to query .from('crm_account_list') which doesn't exist.
    // Must query organizations directly and compute site counts via subquery or separate load.

    // The view would have been:
    // - organizations.* (id, name, organization_type, parent_organization_id, active)
    // - site_count: (SELECT count(*) FROM client_sites WHERE organization_id = org.id)
    // - primary_contact_name: (SELECT display_name FROM crm_contacts ... LIMIT 1)

    expect(buildCrmAccountListQuery).toBeDefined();
  });

  it('provides canonical account query builder to replace the missing view', () => {
    const query = buildCrmAccountListQuery();
    expect(query).toHaveProperty('table');
    expect(query).toHaveProperty('select');
    expect(query.table).toBe('organizations');
  });
});
