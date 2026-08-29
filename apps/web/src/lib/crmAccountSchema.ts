/**
 * CRM Account Schema Mapping
 *
 * SCHEMA GAP: crm_account_list view does not exist in supabase/schema.sql.
 * The CRMPage was querying .from('crm_account_list') which will always fail.
 *
 * Canonical source: organizations + client_sites for site_count
 * Note: primary_contact_name would require JOIN to crm_contacts, which also may not exist.
 * For now, compute site_count separately or via a two-query load.
 */

export interface CrmAccountRow {
  id: string;
  name: string;
  organization_type: string;
  active: boolean;
  parent_organization_id: string | null;
  // Computed fields (not in schema, need separate query)
  site_count?: number;
  primary_contact_name?: string | null;
}

export function buildCrmAccountListQuery() {
  return {
    table: 'organizations',
    select: 'id, name, organization_type, active, parent_organization_id',
    description: 'Canonical account query. Site count must be loaded separately via client_sites joins.',
  };
}

/**
 * Get site count for an organization.
 * Query pattern for Supabase:
 * supabase.from('client_sites')
 *   .select('id', { count: 'exact', head: true })
 *   .eq('organization_id', orgId)
 */
export function siteCountQuery(orgId: string) {
  return {
    table: 'client_sites',
    filter: `organization_id.eq.${orgId}`,
    description: 'Count all sites for the org (for site_count field)',
  };
}
