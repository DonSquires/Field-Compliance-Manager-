/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260831080000_govern_crm_site_creation.sql'), 'utf8');

describe('governed CRM site creation', () => {
  it('scopes candidate review to a manageable CRM account', () => {
    expect(sql).toContain('find_crm_site_candidates');
    expect(sql).toContain('crm_actor_can_manage_account(p_account_organization_id)');
    expect(sql).toContain("s.client_organization_id=p_account_organization_id");
  });

  it('normalizes addresses and refuses duplicate account sites', () => {
    expect(sql).toContain("regexp_replace(lower(v_address),'[^a-z0-9]+','','g')");
    expect(sql).toContain('idx_client_sites_org_client_request');
    expect(sql).toContain('where id=p_account_organization_id for update');
    expect(sql).toContain('A site with this address already exists for the account');
  });

  it('creates retry-safe sites with an explicit boundary review handoff', () => {
    expect(sql).toContain('p_client_request_id is null');
    expect(sql).toContain("'contracted','provisional','unverified'");
    expect(sql).toContain("'crm_site_created'");
  });

  it('closes direct browser inserts and exposes only governed RPCs', () => {
    expect(sql).toContain('revoke insert on public.client_sites from public,anon,authenticated');
    expect(sql).toContain('grant execute on function public.find_crm_site_candidates');
    expect(sql).toContain('public.create_crm_site');
  });
});