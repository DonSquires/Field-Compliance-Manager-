import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20261015002606_govern_cctv_export_lifecycle.sql'), 'utf8');

describe('governed CCTV export lifecycle', () => {
  it('separates author submission from administrator decisions', () => {
    expect(migration).toContain("IF p_approval_state = 'submitted' THEN");
    expect(migration).toContain("previous_state <> 'draft'");
    expect(migration).toContain('export_row.generated_by <> actor_id');
    expect(migration).toContain('NOT public.is_admin_for_org(export_row.organization_id)');
    expect(migration).toContain("previous_state <> 'submitted'");
    expect(migration).toContain('Organization administrator authority is required to approve or reject CCTV exports');
  });

  it('requires administrator authority and the exact lifecycle state for sealing and issue', () => {
    expect(migration).toContain("export_row.approval_state <> 'approved'");
    expect(migration).toContain("export_row.approval_state <> 'sealed'");
    expect(migration.match(/NOT public\.is_admin_for_org\(export_row\.organization_id\)/g)).toHaveLength(4);
  });

  it('issues only the uploaded manifest at the governed private path', () => {
    expect(migration).toContain("'cctv-exports/%s/%s/manifest-%s.json'");
    expect(migration).toContain("p_artifact_bucket <> 'bob-uploads'");
    expect(migration).toContain('FROM storage.objects object');
    expect(migration).toContain('object.bucket_id = p_artifact_bucket');
    expect(migration).toContain('object.name = p_artifact_path');
  });

  it('records previous state and manifest provenance in audit receipts', () => {
    expect(migration).toContain("'previous_state', previous_state");
    expect(migration).toContain("'previous_state', 'approved'");
    expect(migration).toContain("'previous_state', 'sealed'");
    expect(migration.match(/'manifest_sha256'/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
