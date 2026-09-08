import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/components/CrmOnboardingPanel.tsx'), 'utf8');

describe('client portfolio activation handoff', () => {
  it('keeps the provider invite inside the portfolio readiness panel', () => {
    expect(source).toContain('prepare_crm_client_invitation');
    expect(source).toContain("functions.invoke('invite-org'");
    expect(source).toContain('Invite client');
    expect(source).toContain('Confirm and invite');
    expect(source).toContain('Client access begins after acceptance.');
    expect(source).toContain('invitation_status');
    expect(source).toContain('not invited');
  });
});
