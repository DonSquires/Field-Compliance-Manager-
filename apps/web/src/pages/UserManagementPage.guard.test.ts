import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/UserManagementPage.tsx'), 'utf8');

describe('enterprise identity console', () => {
  it('uses governed lifecycle edge functions and reads the audit trail', () => {
    expect(source).toContain("functions.invoke('create-user'");
    expect(source).toContain("functions.invoke('deactivate-user'");
    expect(source).toContain("functions.invoke('resend-invite'");
    expect(source).toContain(".from('user_management_audit')");
  });

  it('does not expose routine hard deletion and requires deactivation reason', () => {
    expect(source).not.toContain("functions.invoke('delete-user'");
    expect(source).toContain('A deactivation reason is required');
    expect(source).toContain('self || busyId === user.id');
  });

  it('filters invite roles through the non-escalating presentation policy', () => {
    expect(source).toContain('getAssignableRoles');
    expect(source).toContain('directInviteRoles.map');
    expect(source).toContain('const directInviteRoles = assignableRoles;');
    expect(source).toContain('linkHR: false, linkRoster: false');
    expect(source).toContain('isFieldInvite && inviteForm.linkHR');
    expect(source).toContain('isFieldInvite && inviteForm.linkRoster');
    expect(source).toContain('can_be_rostered: false');
    expect(source).toContain('data.invitation_sent === false');
  });

  it('names the row action for what it edits, so changing a person is discoverable', () => {
    expect(source).toContain('Edit user');
    expect(source).not.toContain('<span>Manage access</span>');
  });
});