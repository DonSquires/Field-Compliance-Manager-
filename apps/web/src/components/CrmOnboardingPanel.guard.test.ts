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
    expect(source).toContain("They will be the client's administrator in the client portal; when they set their password, 'Client logged in' ticks here. Service can start either way.");
    expect(source).toContain('invitation_status');
    expect(source).toContain('not invited');
    expect(source).toContain('canInvite');
    // the seat is the truthful 'invited' signal; acceptance is the seated user setting their password
    expect(source).toContain('const seated = clientUserCount > 0;');
    expect(source).toContain("const clientAccepted = seated && invitationStatus === 'accepted';");
    expect(source).toContain('const canInvite = !seated && (row.readiness ? row.readiness.ready : row.has_primary_contact);');
    expect(source).toContain('Waiting for the client to set their password');
    expect(source).toContain('Client logged in · ready to start service');
    expect(source).toContain('crm-handoff-timeline');
    expect(source).toContain('Our setup');
    expect(source).toContain('Service started');
    // Ruling 2026-09-21: the client's portal login is optional; activation does not wait for it
    expect(source).not.toContain("!confirming && invitationStatus === 'accepted' && <button");
    expect(source).toContain('Client login sent (optional)');
  });
});
