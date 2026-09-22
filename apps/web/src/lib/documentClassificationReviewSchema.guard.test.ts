import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Normalised to LF: this file's assertions embed literal '\n' for multi-line SQL, but git on
// Windows checks the migration out as CRLF - an exact substring match would otherwise fail even
// when every individual token it checks for is genuinely present.
const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260908100000_review_document_classification.sql'), 'utf8').replace(/\r\n/g, '\n');

describe('governed document classification review', () => {
  it('derives the reviewer from auth and validates the tenant boundary', () => {
    expect(migration).toContain('v_actor uuid := auth.uid()');
    expect(migration).toContain('public.is_admin_for_org(v_org_id)');
    expect(migration).toContain("classifier_source,\n    confidence, rationale, reviewed_by, reviewed_at");
  });

  it('requires reasoned review and emits an audit record', () => {
    expect(migration).toContain('Review reason is required');
    expect(migration).toContain("'document_classification_reviewed'");
    expect(migration).toContain('document_version_id');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.review_document_classification');
    expect(migration).toContain('REVOKE INSERT, UPDATE, DELETE ON TABLE public.document_classifications FROM anon, authenticated');
  });
});