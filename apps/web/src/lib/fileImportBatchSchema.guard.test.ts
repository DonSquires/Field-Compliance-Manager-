import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260908110000_file_import_batches.sql'), 'utf8');

describe('file import batch governance', () => {
  it('persists review-only batches with tenant scope and audit provenance', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.file_import_batches');
    expect(migration).toContain('organization_id uuid NOT NULL');
    expect(migration).toContain('duplicate_of_batch_id uuid REFERENCES public.file_import_batches');
    expect(migration).toContain('file_import_batches_source_hash');
    expect(migration).toContain('public.is_admin_for_org(organization_id) OR public.is_grand_master()');
    expect(migration).toContain("status IN ('preview','needs_review','approved','rejected','applied','failed')");
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.create_file_import_batch');
    expect(migration).toContain("'file_import_batch_created'");
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.review_file_import_batch');
    expect(migration).toContain("'file_import_batch_reviewed'");
    expect(migration).toContain('Review reason is required');
  });

  it('blocks browser table writes and exposes only the governed RPC', () => {
    expect(migration).toContain('REVOKE INSERT, UPDATE, DELETE ON public.file_import_batches FROM anon, authenticated');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.create_file_import_batch');
  });
});