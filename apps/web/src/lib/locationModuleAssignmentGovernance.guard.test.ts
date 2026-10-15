import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../../supabase/migrations/20261015041500_govern_location_module_assignment.sql'),
  'utf8',
);
const panel = readFileSync(resolve(process.cwd(), 'src/components/CrmOperationalWorkPanel.tsx'), 'utf8');
const css = readFileSync(resolve(process.cwd(), 'src/components/CrmAccountWorkspace.css'), 'utf8');

describe('governed per-place toolset assignment', () => {
  it('retires the unguarded signature and keeps every containment check', () => {
    expect(migration).toContain('DROP FUNCTION public.manage_location_module_assignment(uuid, uuid, text, boolean, date, date)');
    expect(migration).toContain('Accepted active service agreement required');
    expect(migration).toContain('Provider administrator required');
    expect(migration).toContain('Module is not enabled on the service agreement');
    expect(migration).toContain('Location house is outside the service agreement client organization');
    expect(migration).toContain('Service agreement has no active Site or Zone facet under this Location house');
  });

  it('serializes retries, rejects stale edits, and records before and after evidence', () => {
    expect(migration).toContain('idx_audit_location_module_assignment_request');
    expect(migration).toContain("hashtextextended('location-module-assignment:' || p_client_request_id::text, 0)");
    expect(migration).toContain('v_existing.updated_at IS DISTINCT FROM p_expected_updated_at');
    expect(migration).toContain('This module was changed at this place after the screen was opened. Reload before saving.');
    expect(migration).toContain('This module is no longer set at this place. Reload before saving.');
    expect(migration).toContain("'previous_enabled', v_existing.enabled");
    expect(migration).toContain("'record', to_jsonb(v_assignment)");
    expect(migration).toContain('client_request_id has already been used for a different place or module');
  });

  it('keeps the authority least-privilege and never grants anon', () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.manage_location_module_assignment\([\s\S]*?\) FROM PUBLIC, anon, authenticated, service_role;/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.manage_location_module_assignment\([\s\S]*?\) TO postgres, authenticated, service_role;/);
  });

  it('wires one accountable path from the operational work panel', () => {
    expect(panel).toContain("supabase.rpc('manage_location_module_assignment'");
    expect(panel).toContain('p_expected_updated_at: toolsetForm.expectedUpdatedAt');
    expect(panel).toContain('Keep current setting');
    expect(panel).toContain('An audit receipt was recorded. Next: officers at this place see this toolset on their next shift.');
    expect(panel).not.toMatch(/from\('location_module_assignments'\)[\s\S]{0,300}\.(insert|update|upsert|delete)\(/);
  });

  it('keeps the per-place grid usable on narrow screens', () => {
    expect(css).toContain('.crm-place-toolset-list');
    expect(css).toContain('.crm-place-toolset-form');
    expect(css).toMatch(/@media\(max-width:800px\)\{[^}]*\.crm-place-toolset-list ul>li\{grid-template-columns:1fr\}/);
  });
});
