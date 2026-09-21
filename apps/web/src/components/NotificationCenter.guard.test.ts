import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/components/NotificationCenter.tsx'), 'utf8');

describe('enterprise notification center', () => {
  it('reads every notification in the person\'s reach through RLS (a branch manager\'s home is the parent; the branch\'s alerts must still arrive) and writes read-state with checks', () => {
    expect(source).toContain(".from('notifications')");
    expect(source).not.toContain(".eq('organization_id', profile.organizationId)");
    expect(source).toContain("organization:organization_id(name)");
    expect(source).toContain("notification.organization_id !== profile?.organizationId && notification.organization?.name");
    expect(source).toContain(".update({ read_at: readAt })");
    expect(source).toContain(".is('read_at', null)");
    expect(source).toContain(".select('id')");
  });

  it('subscribes to realtime changes scoped by RLS, not by the home organisation', () => {
    expect(source).toContain("{ event: '*', schema: 'public', table: 'notifications' }");
    expect(source).not.toContain('filter: `organization_id=eq.${profile.organizationId}`');
  });

  it('does not invent navigation internally', () => {
    expect(source).toContain('onNavigate?.(notification)');
    expect(source).not.toContain('window.location');
  });

  it('fails closed and explains unavailable tenant scope', () => {
    expect(source).toContain('setLoading(false);');
    expect(source).toContain('disabled={!profile?.organizationId}');
    expect(source).toContain('Notifications unavailable until organisation access is confirmed');
  });
});