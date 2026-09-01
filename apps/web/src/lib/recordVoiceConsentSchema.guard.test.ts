import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901024000_record_voice_consent.sql'), 'utf8');
const schema = readFileSync(resolve(process.cwd(), '../../supabase/schema.sql'), 'utf8');

describe('record_voice_consent schema', () => {
  it('is always self-scoped to the authenticated caller, not any other user', () => {
    expect(migration).toContain('v_user_id uuid := auth.uid()');
    expect(migration).toContain('where user_id = v_user_id and organization_id = v_org_id');
    expect(migration).not.toContain('p_user_id');
  });

  it('sets revoked_at when consent is withdrawn', () => {
    expect(migration).toContain("v_revoked_at := case when not p_consented then now() else null end;");
  });

  it('audits every consent grant/revoke', () => {
    expect(migration).toContain("case when p_consented then 'voice_consent_granted' else 'voice_consent_revoked' end");
  });

  it('is granted to authenticated callers and present in the generated schema dump', () => {
    expect(migration).toContain('grant execute on function public.record_voice_consent(boolean) to authenticated, service_role');
    expect(schema).toContain('CREATE OR REPLACE FUNCTION "public"."record_voice_consent"');
  });
});
