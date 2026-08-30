import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');

describe('AdminShell access and routing boundaries', () => {
  it('integrates tenant-scoped role-aware notifications', () => {
    expect(source).toContain('<NotificationCenter onNavigate={navigateFromNotification} />');
    expect(source).toContain('resolveNotificationDestination');
  });

  it('restricts platform and testing pages to platform operators', () => {
    expect(source).toContain('PLATFORM_ONLY_PAGES');
    expect(source).toContain("role === 'grand_master' || role === 'master'");
    expect(source).not.toContain('if (isPlatformOperator) return true;\n    return true;');
  });

  it('guards direct URLs and visible navigation', () => {
    expect(source).toContain('!canAccessAdminPage(page, profile?.role)');
    expect(source).toContain("group !== 'System' && group !== 'Platform'");
    expect(source).toContain('This area is restricted to platform operators.');
  });

  it('persists field operations subareas in the URL', () => {
    expect(source).toContain('FIELD_OPS_AREAS');
    expect(source).toContain('new URLSearchParams(location.search)');
    expect(source).toContain('navigate(`/admin/field-ops?area=${area}`)');
    expect(source).toContain('<AdminHubPage onNavigate={navigateFromHub} />');
  });

  it('exposes governed people and HR separately from roster operations', () => {
    expect(source).toContain("{ id: 'people-hr', label: 'People & HR'");
    expect(source).toContain('return <RosterHRPage />');
    expect(source).toContain("'roster_hr': { page: 'people-hr' }");
  });
});