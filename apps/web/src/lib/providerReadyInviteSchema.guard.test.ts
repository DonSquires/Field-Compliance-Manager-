import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260908121000_provider_ready_client_invite.sql'), 'utf8');

describe('provider-ready client invitation governance', () => {
  it('allows provider-owned locations before client authentication exists', () => {
    expect(migration).toContain('l.organization_id = actor.organization_id');
    expect(migration).toContain('l.organization_id = ANY(public.get_descendant_organizations');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.crm_actor_can_manage_location');
  });

  it('requires contact, site, and zone evidence before preparing an invite', () => {
    expect(migration).toContain('A primary client contact email is required');
    expect(migration).toContain('Add at least one active site before inviting the client');
    expect(migration).toContain('Add at least one active zone before inviting the client');
    expect(migration).toContain("'operational', 'not_invited'");
    expect(migration).toContain("'crm_client_invitation_prepared'");
  });
});