import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
const page = readFileSync(resolve(process.cwd(), 'src/pages/AcceptCapabilityShareInvitePage.tsx'), 'utf8');

describe('capability share invite acceptance route', () => {
  it('mounts the accept page at a token-addressable route', () => {
    expect(app).toContain('<Route path="/invite/capability/:token" element={<AcceptCapabilityShareInvitePage />} />');
  });

  it('requires sign-in before accepting and calls the governed RPC', () => {
    expect(page).toContain('if (!hasSession) return <LoginPage />;');
    expect(page).toContain("supabase.rpc('accept_client_capability_share', { p_token: token }");
  });

  it('imports a dedicated stylesheet with classes that actually exist, not a borrowed unmatched one', () => {
    expect(page).toContain("import './AcceptCapabilityShareInvitePage.css';");
    expect(page).toContain('className="accept-capability-share"');
    expect(page).not.toContain('className="dispute-page"');
  });
});
