import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Normalised to LF: a negative assertion below embeds a literal '\n' for a multi-line pattern.
// Without normalising, git's CRLF checkout on Windows would make that pattern never match
// regardless of whether the bad code is genuinely absent - a silent false pass, not a real check.
const source = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8').replace(/\r\n/g, '\n');

describe('AdminShell access and routing boundaries', () => {
  it('never redirects a page to itself, which trapped users on Reports in a replace loop', () => {
    expect(source).toContain('if (redirectTarget.page !== page) navigate(');
  });

  it('treats module subscriptions that are still loading as unknown, not denied, for navigation clicks', () => {
    expect(source).toContain("modulesStatus === 'loading' ? () => true : isModuleEnabled");
  });

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
    expect(source).toContain("'relationships', 'onboarding', 'handoffs', 'crm', 'client-setup', 'finance-bureau', 'finance-connections', 'finance-money', 'finance-costing', 'finance-pricing', 'sites'");
    expect(source).toContain("if ((CRM_MANAGEMENT_PAGES.has(page) || ROSTER_MANAGEMENT_PAGES.has(page) || page === 'approvals' || page === 'nzta-register') && !isAdminTierRole(role)) return false;");
    expect(source).toContain('items.filter((item) => isPageEnabled(item.id as AdminPage) && (!item.area || isFieldOpsAreaEnabled(item.area)))');
  });

  it('shows approvals and roster planning to every admin-tier role, including admin_officer', () => {
    expect(source).toContain("import { isAdminTierRole } from '../lib/roles';");
    expect(source).not.toContain('APPROVAL_DECISION_ROLES');
    expect(source).not.toContain('ROSTER_MANAGEMENT_ROLES');
  });

  it('shows roster planning only to workforce-management roles', () => {
    expect(source).toContain("const ROSTER_MANAGEMENT_PAGES = new Set<AdminPage>(['roster', 'roster-targets'])");
  });

  it('gates platform module pages (crm, rostering, hr, finance) by organisation subscription', () => {
    expect(source).toContain('PAGE_PLATFORM_MODULE');
    expect(source).toContain("crm: 'crm'");
    expect(source).toContain("roster: 'rostering'");
    expect(source).toContain("'people-hr': 'hr'");
    expect(source).toContain('if (requiredModule && !isModuleEnabled(requiredModule)) return false;');
  });

  it('guards direct URLs and visible navigation', () => {
    expect(source).toContain('!canAccessAdminPage(page, profile?.role, isModuleEnabled)');
    expect(source).toContain("group !== 'System' && group !== 'Platform'");
    expect(source).toContain('This area is not available for your current role.');
  });

  it('evaluates the module gate only once the subscription state is known, so a deep link is never bounced while loading', () => {
    const effect = source.slice(source.indexOf('// The module gate is evaluated only once'), source.indexOf("navigate('/admin/hub', { replace: true });"));
    expect(effect).toContain("if (modulesStatus === 'loading') return;");
    expect(source).toContain("modulesStatus === 'error'");
    expect(source).toContain('Module subscriptions for this organisation could not be loaded');
    expect(source).toContain('isModuleEnabled, modulesStatus]);');
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
    expect(source).toContain("label={section.label}");
    expect(source).toContain('aria-label="Workspace sections"');
    expect(source).toContain('<NotificationCenter onNavigate={navigateFromNotification} />');
    expect(source).toContain('aria-label="Open Bob command center"');
    expect(source).not.toContain("label={sidebarCollapsed ? '' : item.label}");
  });

  it('keeps the working page mounted with live source context beside Bob', () => {
    expect(source).toContain("actionId: routeSearch.get('actionId')");
    expect(source).toContain('context={bobContext}');
    expect(source).toContain('className="bob-page-layout"');
    expect(source).toContain('presentation="docked"');
    expect(source).toContain('setBobOpen(true)');
    expect(source).not.toContain("navigate('/admin/bob',");
    expect(source).toContain('onClick={openBobCommandCenter}');
    expect(source).toContain("if (item.id === 'bob') openBobCommandCenter()");
  });

  it('persists field operations subareas in the URL', () => {
    expect(source).toContain('FIELD_OPS_AREAS');
    expect(source).toContain('new URLSearchParams(location.search)');
    expect(source).toContain('navigate(`/admin/field-ops?area=${area}`)');
    expect(source).toContain('<AdminHubPage onNavigate={navigateFromHub} />');
  });

  it('uses the same module entitlement for direct routes, desktop and mobile navigation, and shortcuts', () => {
    expect(source).toContain('canAccessFieldOpsArea(requestedArea, moduleCheck, profile?.role)');
    expect(source).toContain('(!item.area || isFieldOpsAreaEnabled(item.area))');
    expect(source).toContain("isFieldOpsAreaEnabled('vehicle-search')");
    expect(source).toContain("isFieldOpsAreaEnabled('person-search')");
    expect(source).toContain("case 'person-search':");
    expect(source).toContain('.filter((tab) => isPageEnabled(tab.id as AdminPage))');
  });

  it('normalizes retired page routes and preserves the canonical platform billing destination', () => {
    expect(source).toContain('...Object.values(NAVIGATION_MAP).flatMap((items) => items.map((item) => item.id))');
    expect(source).toContain("'bob', 'document-studio'");
    expect(source).toContain("'platform-billing': { page: 'platform-subscriptions' }");
    expect(source).toContain('!NAVIGABLE_ADMIN_PAGES.has(page)');
    expect(source).not.toContain("'site-ownership' | 'locations'");
  });

  it('recovers from stale lazy page chunks instead of leaving a blank workspace', () => {
    expect(source).toContain('class LazyPageRecovery extends React.Component');
    expect(source).toContain('fcm:lazy-page-reload:');
    expect(source).toContain('window.location.reload()');
    expect(source).toContain('Retry page');
  });

  it('keeps people and HR accessible until the local roster workspace is consolidated', () => {
    expect(source).toContain("{ id: 'people-hr', label: 'People, Pay & HR'");
    expect(source).toContain("new URLSearchParams(location.search).has('profile') ? <StaffProfilePage /> : <RosterHRPage />");
    expect(source).toContain("'roster_hr': { page: 'people-hr' }");
  });

  it('keeps specialist routes visible until their container pages exist locally', () => {
    expect(source).toContain("'Clients & Delivery': [");
    expect(source).toContain('Finance: [');
    expect(source).toContain("{ id: 'crm', label: 'Client Portfolios'");
    expect(source).toContain("{ id: 'finance-bureau', label: 'Finance home'");
    expect(source).toContain("{ id: 'finance-connections', label: 'Connect ANZ & IRD'");
    expect(source).toContain("{ id: 'finance-money', label: 'Business money check'");
    expect(source).toContain("'Field Operations': [");
    expect(source).toContain("{ id: 'roster', label: 'Schedules & Rosters'");
    expect(source).toContain("{ id: 'field-ops', label: 'Field Operations'");
    expect(source).toContain("'Reports & Analytics': [");
    expect(source).toContain("{ id: 'reports', label: 'Reports'");
    expect(source).toContain("{ id: 'testing', label: 'E2E Testing'");
    expect(source).toContain("{ id: 'client-setup', label: 'Set up a new client'");
    expect(source).toContain("{ id: 'onboarding', label: 'Clients being set up'");
    expect(source).toContain("{ id: 'handoffs', label: 'Start delivery'");
  });

  it('consolidates duplicate admin menu entries and landing shortcuts', () => {
    expect(source).toContain("{ id: 'crm', label: 'Client Portfolios', icon: DollarSign }");
    expect(source).not.toContain("{ id: 'relationships', label: 'Client Portfolios', icon: Network }");
    expect(source).toContain("label: 'People & Access'");
    expect(source).not.toContain("label: 'Client Portfolios', icon: Network");
  });

  it('passes portfolio workflow identifiers into Bob context', () => {
    expect(source).toContain('accountId: workflowContext.accountId');
    expect(source).toContain('agreementId: workflowContext.agreementId');
    expect(source).toContain('locationId: workflowContext.locationId');
    expect(source).toContain('workUnitId: workflowContext.workUnitId');
  });

  it('scopes telemetry to the operating organisation and selected zones without inventing missing counts', () => {
    expect(source).toContain("contextMatchesOrganization ? selectedAgreementZones.map((zone) => zone.id) : []");
    expect(source).toContain("loadedOrganizationId === activeOrganizationId");
    expect(source.match(/\.eq\('organization_id', organizationId\)/g)?.length).toBeGreaterThanOrEqual(4);
    expect(source).toContain('value: result.error ? null : result.count');
    expect(source).toContain("isModuleEnabled('welfare', { safetyRelevant: true })");
    expect(source).toContain('telemetry.welfareEnabled ?');
    expect(source).toContain('Organisation-wide; welfare alerts have no zone field.');
    expect(source).toContain('cancelled = true; window.clearInterval(interval)');
  });

  it('keeps grouped operational navigation and global service context outside the scrolling canvas', () => {
    expect(source).toContain("label: 'Live Ops'");
    expect(source).toContain("label: 'Evidence & Reports'");
    expect(source).toContain("label: 'Site & Spatial Setup'");
    expect(source).toContain('aria-label="Workspace destination"');
    expect(source).toContain('<PlaceContextBanner compact organizationWide={isOrgWideCctvWorkspace} organizationId={activeOrganizationId} />');
    expect(source).toContain('className="admin-shell-page"');
  });

  it('lets the CRM matrix replace rather than duplicate shell workflow controls', () => {
    expect(source).toContain("const showWorkflowNavigation = !['crm', 'client-setup', 'finance-bureau', 'finance-money'].includes(activePage)");
    expect(source).toContain("['hub', 'crm', 'client-setup', 'finance-bureau', 'finance-money', 'roster'].includes(activePage)");
    expect(source.match(/activeWorkspace && showWorkflowNavigation && <WorkspaceToolbar/g)).toHaveLength(2);
    expect(source.match(/showWorkflowNavigation && <WorkflowRail/g)).toHaveLength(2);
  });

  it('contains the HR workbench without locking ordinary staff-profile pages', () => {
    expect(source).toContain("(activePage === 'people-hr' && !new URLSearchParams(location.search).has('profile'))");
  });
});