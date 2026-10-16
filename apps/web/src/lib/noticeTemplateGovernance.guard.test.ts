import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const local = resolve(process.cwd(), 'supabase/migrations/20261015073107_govern_notice_template_versioning.sql');
const sql = readFileSync(existsSync(local) ? local : resolve(process.cwd(), '../../supabase/migrations/20261015073107_govern_notice_template_versioning.sql'), 'utf8');
const constraintLocal = resolve(process.cwd(), 'supabase/migrations/20261015073725_enforce_notice_template_safe_html.sql');
const constraintSql = readFileSync(existsSync(constraintLocal) ? constraintLocal : resolve(process.cwd(), '../../supabase/migrations/20261015073725_enforce_notice_template_safe_html.sql'), 'utf8');

describe('governed notice template versioning', () => {
  it('removes direct authenticated writes and exposes one governed command', () => {
    expect(sql).toContain('DROP POLICY IF EXISTS notice_templates_insert');
    expect(sql).toContain('DROP POLICY IF EXISTS notice_templates_update');
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE ON public.notice_templates');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.manage_notice_template');
  });

  it('serializes versions and rejects stale or unsafe submissions', () => {
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toContain('notice_templates_one_active_version');
    expect(sql).toContain('Notice template changed since it was opened');
    expect(sql).toContain('Template body contains unsafe HTML');
    expect(sql).toContain('Source document location is required');
    expect(constraintSql).toContain('notice_templates_body_safe_html_check');
    expect(constraintSql).toContain('[[:space:]]*(script|iframe|object|embed)');
    expect(constraintSql).toContain('VALIDATE CONSTRAINT notice_templates_body_safe_html_check');
  });

  it('replays client requests and preserves full before-after evidence', () => {
    expect(sql).toContain('notice_templates_org_client_request_unique');
    expect(sql).toContain("'replayed', true");
    expect(sql).toContain("'previous'");
    expect(sql).toContain("'resulting'");
    expect(sql).toContain("'notice_template_version_created'");
  });
});
