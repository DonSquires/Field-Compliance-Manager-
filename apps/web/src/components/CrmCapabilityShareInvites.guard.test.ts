import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dialog = readFileSync(resolve(process.cwd(), 'src/components/CrmAgreementSetupDialog.tsx'), 'utf8');
const invites = readFileSync(resolve(process.cwd(), 'src/components/CrmCapabilityShareInvites.tsx'), 'utf8');

describe('client capability share UI wiring', () => {
  it('exposes a client sharing tab independent of the accept flow', () => {
    expect(dialog).toContain("'sharing'");
    expect(dialog).toContain('CrmCapabilityShareInvites');
  });

  it('sends scoped invites via the governed RPC, not a direct table write', () => {
    expect(invites).toContain("supabase.rpc('invite_client_capability_share'");
    expect(invites).not.toMatch(/\.from\('onboarding_invites'\)\.insert/);
  });
});
