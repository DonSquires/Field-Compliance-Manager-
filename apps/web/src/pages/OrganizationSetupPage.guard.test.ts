import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/OrganizationSetupPage.tsx'), 'utf8');

describe('governed organization profile setup', () => {
  it('saves the provider profile through the expected-state RPC', () => {
    expect(source).toContain("supabase.rpc('update_operating_branch_profile'");
    expect(source).toContain('p_expected_updated_at: org.updated_at');
    expect(source).not.toMatch(/\.from\(['"]organizations['"]\)[\s\S]{0,200}\.update\(/);
  });

  it('uses selected operating branch RPCs for operational module and geofence settings', () => {
    expect(source).toContain('operatingOrganizationId ?? profile?.organizationId');
    expect(source).toContain("supabase.rpc('set_operating_branch_module'");
    expect(source).toContain("supabase.rpc('manage_operating_branch_geofence_config'");
    expect(source).not.toMatch(/from\(['"]organization_modules['"]\)[\s\S]{0,200}\.(update|insert|delete)/);
    expect(source).not.toMatch(/from\(['"]org_geofence_config['"]\)[\s\S]{0,200}\.(update|insert|delete)/);
  });

  it('resolves geofence defaults through the canonical fallback RPC', () => {
    expect(source).toContain("supabase.rpc('get_org_geofence_config'");
    expect(source).toContain('p_org_id: orgId');
    expect(source).toContain('resolvedGeofenceDefaults');
  });

  it('reads and saves branch-scoped printer defaults through the governed RPC', () => {
    expect(source).toContain(".from('org_printer_settings')");
    expect(source).toContain(".select('paper_width, connection_type')");
    expect(source).toContain("supabase.rpc('manage_org_printer_settings'");
    expect(source).toContain('p_organization_id: org.id');
    expect(source).toContain("throw new Error('Printer settings were not confirmed after saving.')");
    expect(source).toContain('A4 page');
    expect(source).toContain("option.value === 'a4' ? 'browser_print'");
    expect(source).not.toMatch(/from\(['"]org_printer_settings['"]\)[\s\S]{0,300}\.(insert|update|delete)\(/);
  });

  it('clears loading state when no operating organization is available', () => {
    expect(source).toContain('if (!orgId) {');
    expect(source).toContain('setLoading(false);');
    expect(source).toContain('setError(null);');
  });

  it('adds and archives branches only through the governed provider-branch RPCs', () => {
    expect(source).toContain("supabase.rpc('create_provider_branch'");
    expect(source).toContain('p_client_request_id: branchRequestId');
    expect(source).toContain("supabase.rpc('archive_provider_branch'");
    expect(source).toContain('p_expected_updated_at: branch.updated_at');
    expect(source).not.toMatch(/from\(['"]organizations['"]\)[\s\S]{0,200}\.insert\(/);
    // A new or archived branch must show up in (or leave) the "Working in" selector without a reload.
    expect(source).toContain('await refreshOperatingOrganizations();');
    // Branch management is an organisation-level act; a branch does not nest branches from this page.
    expect(source).toContain("const isBranch = org?.organization_type === 'branch';");
    expect(source).toContain('{!isBranch && (');
  });

  it('explains modules and distances in plain language instead of raw keys', () => {
    expect(source).toContain('function moduleLabel(key: string)');
    expect(source).toContain("label: 'On site', help: 'How close (metres)");
    expect(source).toContain("Turn on {missing.map((dep) => moduleLabel(dep).label).join(', ')} first.");
  });

  it('keeps a boundary-source outage distinct from a valid unmatched council name', () => {
    expect(source).toContain('const unavailable = (data?.unavailable ?? []).join');
    expect(source).toContain('Boundary source unavailable for: ${unavailable}');
    expect(source).toContain('No council boundary matched: ${unmatched}');
  });

  it('loads canonical council names and sends the preview through the governed approval producer', () => {
    expect(source).toContain(".from('canonical_ta_names')");
    expect(source).toContain(".select('ta_name')");
    expect(source).not.toContain('const TERRITORIAL_AUTHORITIES =');
    expect(source).toContain("supabase.functions.invoke('bob-propose-org-jurisdiction'");
    expect(source).toContain('Send to Approvals');
    expect(source).toContain('disabled={jurisdictionProposalLoading || !jurisdictionPreview}');
  });

  it('keeps root-organization legal and compliance evidence on a governed shared surface', () => {
    expect(source).toContain('<OrganizationComplianceSection org={org} onOrgChange={setOrg} />');
    expect(source).toContain("org.corporate_profile_verification_status === 'verified'");
    expect(source).toContain('{!isBranch && <OrganizationComplianceSection');
  });

  it('creates sourced notice-template versions through the governed RPC', () => {
    expect(source).toContain("supabase.rpc('manage_notice_template'");
    expect(source).toContain('p_client_request_id: templateRequestId');
    expect(source).toContain('p_expected_current_id: editingTemplate?.id ?? null');
    expect(source).toContain('Source document location');
    expect(source).toContain('I checked this version against the source document.');
    expect(source).toContain('Keep current template');
    expect(source).not.toMatch(/\.from\(['"]notice_templates['"]\)[\s\S]{0,300}\.(insert|update|delete)\(/);
  });
});
