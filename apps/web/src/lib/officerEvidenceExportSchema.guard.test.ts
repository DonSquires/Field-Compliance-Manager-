import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260830121000_officer_activity_evidence_exports.sql'), 'utf8');
const schema = readFileSync(resolve(process.cwd(), '../../supabase/schema.sql'), 'utf8');

describe('officer activity evidence exports', () => {
  it('creates an append-only admin-scoped evidence snapshot', () => {
    expect(migration).toContain('create table if not exists public.officer_activity_evidence_exports');
    expect(migration).toContain('using (public.is_admin_for_org(organization_id))');
    expect(migration).not.toContain('create policy officer_activity_evidence_exports_update');
    expect(migration).not.toContain('create policy officer_activity_evidence_exports_delete');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS "public"."officer_activity_evidence_exports"');
    expect(schema).toContain('CREATE OR REPLACE FUNCTION "public"."generate_officer_activity_evidence_export"');
  });

  it('hashes the exact package text returned to the caller', () => {
    expect(migration).toContain('v_package_text := v_payload::text');
    expect(migration).toContain("extensions.digest(pg_catalog.convert_to(v_package_text, 'UTF8'), 'sha256')");
    expect(migration).toContain('return query select v_export_id, v_generated_at, v_sha256, v_event_count, v_package_text');
  });

  it('requires admin authorization and audits export issuance', () => {
    expect(migration).toContain('if not public.is_admin_for_org(v_org_id)');
    expect(migration).toContain("'officer_activity_evidence_exported'");
    expect(migration).toContain("'sha256', v_sha256");
  });
});