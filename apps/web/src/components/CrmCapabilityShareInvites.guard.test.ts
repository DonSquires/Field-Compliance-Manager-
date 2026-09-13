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

  it('sends scoped invites via the governed edge function, not a direct table write', () => {
    expect(invites).toContain("supabase.functions.invoke('send-capability-share-invite'");
    expect(invites).not.toMatch(/\.from\('onboarding_invites'\)\.insert/);
  });

  it('shows a success receipt distinguishing emailed delivery from manual link sharing', () => {
    expect(invites).toContain('Delivered by email to');
    expect(invites).toContain('Copy link');
    expect(invites).toContain('navigator.clipboard.writeText');
  });

  it('keeps its message and heading styles in the stylesheet it imports', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/components/CrmAgreementReportingPanel.css'), 'utf8');
    expect(invites).toContain("import './CrmAgreementReportingPanel.css';");
    expect(invites).toContain('className="agreement-section-heading"');
    expect(invites).toContain('className="agreement-setup-message is-error"');
    expect(invites).toContain('className="agreement-setup-message is-success"');
    expect(css).toContain('.agreement-section-heading');
    expect(css).toContain('.agreement-setup-message');
    expect(css).toContain('.agreement-setup-message.is-error');
    expect(css).toContain('.agreement-setup-message.is-success');
  });
});
