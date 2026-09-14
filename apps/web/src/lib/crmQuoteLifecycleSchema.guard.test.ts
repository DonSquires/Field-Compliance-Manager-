import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260830140000_govern_crm_quote_lifecycle.sql'), 'utf8');
const schema = readFileSync(resolve(process.cwd(), '../../supabase/schema.sql'), 'utf8');

describe('governed CRM quote lifecycle', () => {
  it('locks and race-checks every transition', () => {
    expect(sql).toContain('where q.id=p_quote_id for update');
    expect(sql).toContain('v_quote.status<>p_expected_status');
    expect(sql).toContain('public.is_admin_for_org(v_quote.provider_org_id)');
  });

  it('requires commercially ready pricing before sending', () => {
    expect(sql).toContain("l.kind='labour'");
    expect(sql).toContain('Quote totals must be positive before sending');
    expect(sql).toContain('v_margin<v_quote.target_margin_pct');
    expect(sql).toContain('Expired quotes cannot be sent');
  });

  it('accepts only sent quotes and reasons declines', () => {
    expect(sql).toContain("v_quote.status<>'sent'");
    expect(sql).toContain('select public.accept_quote(v_quote.id)');
    expect(sql).toContain('Decline reason is required');
  });

  it('closes direct acceptance and audits lifecycle', () => {
    expect(sql).toContain('revoke all on function public.accept_quote(uuid) from public,anon,authenticated');
    expect(sql).toContain("'crm_quote_sent'");
    expect(sql).toContain("'crm_quote_accepted'");
    expect(sql).toContain("'crm_quote_declined'");
    expect(schema).toMatch(/CREATE (OR REPLACE )?FUNCTION "public"\."manage_crm_quote"/);
  });
});