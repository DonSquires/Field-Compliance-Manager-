import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260830143000_govern_crm_contacts_and_activities.sql'), 'utf8');

describe('governed CRM relationship workflows', () => {
  it('authorizes account management through hierarchy or accepted provider relationship', () => {
    expect(sql).toContain('account.parent_organization_id=actor.organization_id');
    expect(sql).toContain("agreement.invitation_status='accepted'");
    expect(sql).toContain('agreement.provider_organization_id=actor.organization_id');
    expect(sql).toContain('create policy crm_contacts_provider_select');
  });

  it('makes contact lifecycle retry-safe, race-checked, soft-deleted, and audited', () => {
    expect(sql).toContain('idx_crm_contacts_client_request');
    expect(sql).toContain('v_contact.updated_at<>p_expected_updated_at');
    expect(sql).toContain("p_action='deactivate'");
    expect(sql).toContain("'crm_contact_'||p_action");
  });

  it('records retry-safe account activity with follow-up and audit provenance', () => {
    expect(sql).toContain('unique(provider_organization_id,client_request_id)');
    expect(sql).toContain('Follow-up cannot be before the activity');
    expect(sql).toContain("'crm_account_activity_created'");
  });

  it('closes direct authenticated contact and activity mutations', () => {
    expect(sql).toContain('revoke insert,update,delete,truncate on public.crm_contacts from public,anon,authenticated');
    expect(sql).toContain('revoke insert,update,delete,truncate on public.crm_account_activities from public,anon,authenticated');
  });

  it('governs invoice send, payment, and void transitions', () => {
    expect(sql).toContain('for update;if not found then');
    expect(sql).toContain("p_action='mark_paid'");
    expect(sql).toContain('Invoice totals must be positive before sending');
    expect(sql).toContain('A void reason is required');
    expect(sql).toContain("'crm_invoice_'||p_action");
    expect(sql).toContain('revoke insert,update,delete,truncate on public.invoices from public,anon,authenticated');
  });
});