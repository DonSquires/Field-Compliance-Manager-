import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const relPath = resolve(process.cwd(), 'supabase/migrations/20260903210000_crm_enterprise_enhancements.sql');
const path = existsSync(relPath) ? relPath : resolve(process.cwd(), '../../supabase/migrations/20260903210000_crm_enterprise_enhancements.sql');
const sql = readFileSync(path, 'utf8');

describe('governed CRM enterprise enhancements', () => {
  it('defines quote line removal and modification RPCs', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION "public"."remove_crm_quote_line"');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION "public"."update_crm_quote_line"');
    expect(sql).toContain('Only draft quotes can be modified');
    expect(sql).toContain("'crm_quote_line_removed'");
    expect(sql).toContain("'crm_quote_line_updated'");
  });

  it('defines follow-up task completion engine', () => {
    expect(sql).toContain('ALTER TABLE "public"."crm_account_activities"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "completed_at" timestamptz');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION "public"."complete_crm_follow_up"');
    expect(sql).toContain("'crm_follow_up_completed'");
  });

  it('defines account owner assignment on organizations', () => {
    expect(sql).toContain('ALTER TABLE "public"."organizations"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "account_owner_user_id" uuid');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION "public"."manage_crm_organization"');
    expect(sql).toContain('p_account_owner_user_id uuid DEFAULT NULL');
  });

  it('defines invoice line item management and generation from agreement', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION "public"."add_crm_invoice_line"');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION "public"."remove_crm_invoice_line"');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION "public"."generate_crm_invoice_from_agreement"');
    expect(sql).toContain("'crm_invoice_generated_from_agreement'");
  });

  it('revokes public/anon access and grants to authenticated/service_role', () => {
    expect(sql).toContain('REVOKE ALL ON FUNCTION "public"."remove_crm_quote_line"');
    expect(sql).toContain('REVOKE ALL ON FUNCTION "public"."update_crm_quote_line"');
    expect(sql).toContain('REVOKE ALL ON FUNCTION "public"."complete_crm_follow_up"');
    expect(sql).toContain('REVOKE ALL ON FUNCTION "public"."add_crm_invoice_line"');
    expect(sql).toContain('REVOKE ALL ON FUNCTION "public"."remove_crm_invoice_line"');
    expect(sql).toContain('REVOKE ALL ON FUNCTION "public"."generate_crm_invoice_from_agreement"');
  });
});
