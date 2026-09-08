import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260908130000_onboarding_invitation_state.sql'), 'utf8');

describe('onboarding invitation state contract', () => {
  it('returns invitation state from the governed onboarding workspace read', () => {
    expect(migration).toContain('invitation_status text');
    expect(migration).toContain('sa.invitation_status');
    expect(migration).toContain('get_crm_onboarding_workspace');
  });
});