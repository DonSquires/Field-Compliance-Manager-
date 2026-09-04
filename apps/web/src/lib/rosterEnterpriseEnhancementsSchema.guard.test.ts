import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const relPath = resolve(process.cwd(), 'supabase/migrations/20260903220000_roster_enterprise_enhancements.sql');
const path = existsSync(relPath) ? relPath : resolve(process.cwd(), '../../supabase/migrations/20260903220000_roster_enterprise_enhancements.sql');
const sql = readFileSync(path, 'utf8');

describe('governed Rostering enterprise enhancements', () => {
  it('defines batch publish roster slots RPC', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION "public"."batch_publish_roster_slots"');
    expect(sql).toContain('status = \'published\'');
    expect(sql).toContain('materialize_roster_slot');
    expect(sql).toContain('\'roster_period_batch_published\'');
  });

  it('defines unpublish / recall roster slot RPC', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION "public"."unpublish_roster_slot"');
    expect(sql).toContain('status = \'draft\'');
    expect(sql).toContain('\'roster_slot_unpublished\'');
  });

  it('defines staff availability management RPC', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION "public"."manage_staff_availability"');
    expect(sql).toContain('\'staff_availability_created\'');
    expect(sql).toContain('\'staff_availability_deleted\'');
  });

  it('defines shift template management and generation RPCs', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION "public"."manage_shift_template"');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION "public"."generate_roster_from_templates"');
    expect(sql).toContain('\'shift_template_created\'');
    expect(sql).toContain('\'roster_generated_from_templates\'');
  });

  it('defines shift swap review RPC', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION "public"."review_shift_swap"');
    expect(sql).toContain('\'shift_swap_reviewed\'');
  });

  it('revokes public/anon access and grants execution to authenticated and service_role', () => {
    expect(sql).toContain('REVOKE ALL ON FUNCTION "public"."batch_publish_roster_slots"');
    expect(sql).toContain('REVOKE ALL ON FUNCTION "public"."unpublish_roster_slot"');
    expect(sql).toContain('REVOKE ALL ON FUNCTION "public"."manage_staff_availability"');
    expect(sql).toContain('REVOKE ALL ON FUNCTION "public"."manage_shift_template"');
    expect(sql).toContain('REVOKE ALL ON FUNCTION "public"."generate_roster_from_templates"');
    expect(sql).toContain('REVOKE ALL ON FUNCTION "public"."review_shift_swap"');
  });
});
