/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260902001000_govern_agreement_obligations.sql'), 'utf8');

describe('governed agreement obligations', () => {
  it('loads obligation codes through the agreement setup boundary', () => {
    expect(sql).toContain("'obligations'");
    expect(sql).toContain("'obligation_code',ao.obligation_code");
    expect(sql).toContain('ao.service_agreement_id=v_agreement.id');
  });

  it('requires provider authority and accepted operational ownership', () => {
    expect(sql).toContain('is_admin_for_org(v_agreement.provider_organization_id)');
    expect(sql).toContain("v_agreement.agreement_type<>'operational'");
    expect(sql).toContain("v_agreement.invitation_status<>'accepted'");
    expect(sql).toContain("sal.service_agreement_id=v_agreement.id and sal.site_id=p_site_id and sal.status='active'");
  });

  it('uses stable unique codes and optimistic locking', () => {
    expect(sql).toContain('agreement_obligations_agreement_code_key');
    expect(sql).toContain('v_obligation.updated_at is distinct from p_expected_updated_at');
    expect(sql).toContain("v_code!~'^[A-Z0-9][A-Z0-9._-]{1,63}$'");
    expect(sql).toContain("p_action is null or p_action not in('save','deactivate')");
    expect(sql).toContain('coalesce(p_requires_proof,false)');
  });

  it('audits mutations and closes direct browser writes', () => {
    expect(sql).toContain("'crm_agreement_obligation_'||p_action");
    expect(sql).toContain('revoke insert,update,delete,truncate on public.agreement_obligations');
  });
});