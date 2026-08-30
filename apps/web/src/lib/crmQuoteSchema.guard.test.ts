import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260830138000_govern_crm_quote_creation.sql'), 'utf8');
const schema = readFileSync(resolve(process.cwd(), '../../supabase/schema.sql'), 'utf8');

describe('governed CRM quote creation', () => {
  it('derives provider identity and limits eligible counterparties', () => {
    expect(sql).toContain('v_actor uuid:=auth.uid()');
    expect(sql).toContain('o.parent_organization_id=v_provider');
    expect(sql).toContain("a.agreement_type='operational'");
  });

  it('is retry-safe and validates commercial inputs', () => {
    expect(sql).toContain('idx_quotes_client_request');
    expect(sql).toContain('Target margin must be between zero and 100');
    expect(sql).toContain('Quote validity date cannot be in the past');
  });

  it('creates only a draft and audits provenance', () => {
    expect(sql).toContain("v_title,'draft','NZD'");
    expect(sql).toContain("'crm_draft_quote_created'");
    expect(sql).toContain('revoke all on function public.accept_quote(uuid) from public,anon');
    expect(sql).toContain('revoke insert,update,delete on public.quotes');
    expect(schema).toContain('CREATE FUNCTION "public"."create_crm_draft_quote"');
  });
});