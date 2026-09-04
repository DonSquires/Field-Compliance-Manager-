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

  it('aligns CRM management pages with server administrator roles', () => {
    expect(source).toContain('CRM_MANAGEMENT_PAGES');
    expect(source).toContain("'relationships', 'onboarding', 'handoffs', 'crm', 'sites'");
    expect(source).toContain("role === 'grand_master' || role === 'master' || role === 'admin'");
    expect(source).toContain('items.filter((item) => canAccessAdminPage(item.id as AdminPage, profile?.role))');
  });

  it('guards direct URLs and visible navigation', () => {
    expect(source).toContain('!canAccessAdminPage(page, profile?.role)');
    expect(source).toContain("group !== 'System' && group !== 'Platform'");
    expect(source).toContain('This area is not available for your current role.');
  });

  it('uses shared module access wording for configuration state instead of silently ignoring it', () => {
    expect(source).toContain('getModuleAccessMessage');
    expect(source).toContain('moduleAccessNotice');
    expect(source).toContain("if (modulesStatus === 'configured') return null");
    expect(source).not.toContain("const modulesLoading = modulesStatus === 'loading'");
  });

  it('exposes stateful accessible names and current-page semantics on shell controls', () => {
    expect(source).toContain("aria-current={active ? 'page' : undefined}");
    expect(source).toContain("aria-current={activePage === tab.id ? 'page' : undefined}");
    expect(source).toContain('aria-expanded={!sidebarCollapsed}');
    expect(source).toContain('aria-expanded={mobileMenuOpen}');
    expect(source).toContain('aria-expanded={bobOpen}');
    expect(source).toContain("label={item.label}");
    expect(source).not.toContain("label={sidebarCollapsed ? '' : item.label}");
  });

  it('persists field operations subareas in the URL', () => {
    expect(source).toContain('FIELD_OPS_AREAS');
    expect(source).toContain('new URLSearchParams(location.search)');
    expect(source).toContain('navigate(`/admin/field-ops?area=${area}`)');
    expect(source).toContain('<AdminHubPage onNavigate={navigateFromHub} />');
  });

  it('keeps people and HR accessible until the local roster workspace is consolidated', () => {
    expect(source).toContain("{ id: 'people-hr', label: 'People & HR'");
    expect(source).toContain('return <RosterHRPage />');
    expect(source).toContain("'roster_hr': { page: 'people-hr' }");
  });

  it('keeps specialist routes visible until their container pages exist locally', () => {
    expect(source).toContain("'Core': [");
    expect(source).toContain("{ id: 'crm', label: 'CRM & Finance'");
    expect(source).toContain("{ id: 'roster', label: 'Roster & HR'");
    expect(source).toContain("{ id: 'field-ops', label: 'Field Operations'");
    expect(source).toContain("{ id: 'reports', label: 'Reports'");
    expect(source).toContain("{ id: 'testing', label: 'E2E Testing'");
    expect(source).toContain("{ id: 'onboarding', label: 'Account Onboarding'");
  });
});