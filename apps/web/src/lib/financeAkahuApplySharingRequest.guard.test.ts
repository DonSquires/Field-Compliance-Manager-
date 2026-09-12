import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260912146000_akahu_apply_sharing_requests.sql'), 'utf8');
const edge = readFileSync(resolve(process.cwd(), '../../supabase/functions/finance-akahu-apply-sharing-request/index.ts'), 'utf8');

describe('Akahu Apply sharing requests', () => {
  it('keeps sharing requests tenant-scoped and linked to a local application', () => {
    expect(migration).toContain('finance_akahu_apply_sharing_requests');
    expect(migration).toContain('REFERENCES public.finance_akahu_apply_applications(id)');
    expect(migration).toContain('^sharing_request_[a-z0-9]{24,27}$');
    expect(edge).toContain(".eq('id', applicationId).eq('organization_id', profile.organization_id)");
  });

  it('requests historical data and optional manual uploads through Apply', () => {
    expect(edge).toContain('/sharing-request');
    expect(edge).toContain('requested_days');
    expect(edge).toContain('allow_manual_uploads');
    expect(edge).toContain('allow_multiple_ob_connections');
    expect(edge).toContain('finance_akahu_apply_sharing_request_created');
    expect(edge).not.toContain('AKAHU_APPLY_API_KEY` }');
  });
});
