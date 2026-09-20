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
    expect(source).toContain("They will be the client's administrator in the client portal; when they set their password, 'Client accepted' ticks here and you can activate.");
    expect(source).toContain('invitation_status');
    expect(source).toContain('not invited');
    expect(source).toContain('canInvite');
    // the seat is the truthful 'invited' signal; acceptance is the seated user setting their password
    expect(source).toContain('const seated = clientUserCount > 0;');
    expect(source).toContain("const clientAccepted = seated && invitationStatus === 'accepted';");
    expect(source).toContain('const canInvite = !seated && (row.readiness ? row.readiness.ready : row.has_primary_contact);');
    expect(source).toContain('Waiting for the client to set their password');
    expect(source).toContain('Client accepted · ready for activation');
    expect(source).toContain('crm-handoff-timeline');
    expect(source).toContain('Provider setup');
    expect(source).toContain('Operational handoff');
  });
});
