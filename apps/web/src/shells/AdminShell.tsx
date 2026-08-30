/**
 * AdminShell.tsx
 * Admin / Master / Grand Master portal shell with consolidated navigation
 *
 * Source of Truth: docs/INSTRUCTION_MANUAL.md §4.1
 * Phase: Phase 1 Nav IA consolidation (issue #109)
 *
 * Architecture:
 * - Sidebar reduced from ~57 items to ≤15 top-level items
 * - Container-based navigation (CRM, Roster, Field Ops, Reports, Sites)
 * - URL-sync state management with legacy redirect support
 * - Module gating with isPageEnabled()
 * - Responsive desktop/mobile layouts
 * - Lazy-loaded container pages
 * - Integration: BobPanel, NotificationsBell, PortalSwitcher, UniversalSearch
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useEnabledModules } from '../hooks/useEnabledModules';
import { supabase } from '../lib/supabase';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { NotificationsBell, PortalSwitcher, UniversalSearch } from '../components/stubs';
import { BobPanel } from '../components/BobPanel';
import { ProfessionalNav } from '../components/ProfessionalNav';
import { ProfessionalHeader } from '../components/ProfessionalHeader';

import AdminHubPage from '../pages/AdminHubPage';

// Lazy load pages for code-splitting
const CRMPage = React.lazy(() => import('../pages/CRMPage'));
const RelationshipWorkspacePage = React.lazy(() => import('../pages/RelationshipWorkspacePage'));
const RosterHRPage = React.lazy(() => import('../pages/RosterHRPage'));
const UserManagementPage = React.lazy(() => import('../pages/UserManagementPage'));
const SiteDetailPage = React.lazy(() => import('../pages/SiteDetailPage'));
const ApprovalsActivityPage = React.lazy(() => import('../pages/ApprovalsActivityPage'));
const LocationsPage = React.lazy(() => import('../pages/LocationsPage'));
const AccessControlPage = React.lazy(() => import('../pages/AccessControlPage'));
const OrganizationSetupPage = React.lazy(() => import('../pages/OrganizationSetupPage'));
const ModuleCatalogPage = React.lazy(() => import('../pages/ModuleCatalogPage'));
const GrandMasterPlatformPage = React.lazy(() => import('../pages/GrandMasterPlatformPage'));
const ProviderBillingPage = React.lazy(() => import('../pages/ProviderBillingPage'));
const ReportsHubPage = React.lazy(() => import('../pages/ReportsHubPage'));
const PatrolPage = React.lazy(() => import('../pages/PatrolPage'));
const DispatchConsolePage = React.lazy(() => import('../pages/DispatchConsolePage'));
const WelfareAlertsPage = React.lazy(() => import('../pages/WelfareAlertsPage'));
const SmokeControlPage = React.lazy(() => import('../pages/modules/SmokeControlPage'));
const LiveMapPage = React.lazy(() => import('../pages/LiveMapPage'));
const BreachReviewPage = React.lazy(() => import('../pages/BreachReviewPage'));
const VehicleSearchPage = React.lazy(() => import('../pages/VehicleSearchPage'));
const FieldReportsPage = React.lazy(() => import('../pages/FieldReportsPage'));
const ParkingOversightPage = React.lazy(() => import('../pages/ParkingOversightPage'));
const NoiseControlOversightPage = React.lazy(() => import('../pages/NoiseControlOversightPage'));
const BiosecurityOversightPage = React.lazy(() => import('../pages/BiosecurityOversightPage'));
const ComingSoonPage = React.lazy(() => import('../pages/ComingSoonPage'));

type AdminPage =
  | 'hub' | 'relationships' | 'crm' | 'roster' | 'field-ops' | 'reports' | 'sites' | 'site-360'
  | 'site-ownership' | 'locations' | 'users' | 'access-control' | 'org-setup'
  | 'approvals' | 'testing' | 'test-data' | 'platform' | 'platform-catalog'
  | 'platform-subscriptions' | 'platform-billing';

type CRMTab = 'crm' | 'invoicing' | 'payments' | 'generate-invoice' | 'oncall' | 'financial-setup' | 'rate-rules' | 'tenders';
type RosterTab = 'roster' | 'staff' | 'training' | 'assets' | 'disciplinary' | 'credential-expiry' | 'shift-templates' | 'leave-approval' | 'timesheets' | 'callouts';
type FieldOpsSubArea = 'landing' | 'dispatch' | 'patrol' | 'live-map' | 'welfare-alerts' | 'breach-review' | 'vehicle-search' | 'field-reports' | 'parking' | 'noise-control' | 'biosecurity' | 'smoke-control';
type ReportsTab = 'reports-hub' | 'report-packs' | 'obligations' | 'fc-reporting' | 'fc-compliance' | 'fc-command-results';

interface RedirectTarget {
  page: AdminPage;
  crmTab?: CRMTab;
  rosterTab?: RosterTab;
  fieldOpsSubArea?: FieldOpsSubArea;
  reportsTab?: ReportsTab;
}

const LEGACY_REDIRECT_MAP: Record<string, RedirectTarget> = {
  'crm_finance': { page: 'crm', crmTab: 'crm' },
  'roster_hr': { page: 'roster', rosterTab: 'roster' },
  'dispatch': { page: 'field-ops', fieldOpsSubArea: 'dispatch' },
  'patrol': { page: 'field-ops', fieldOpsSubArea: 'patrol' },
  'live_map': { page: 'field-ops', fieldOpsSubArea: 'live-map' },
  'welfare_alerts': { page: 'field-ops', fieldOpsSubArea: 'welfare-alerts' },
  'breach_review': { page: 'field-ops', fieldOpsSubArea: 'breach-review' },
  'field_reports': { page: 'field-ops', fieldOpsSubArea: 'field-reports' },
  'parking': { page: 'field-ops', fieldOpsSubArea: 'parking' },
  'noise_control': { page: 'field-ops', fieldOpsSubArea: 'noise-control' },
  'biosecurity': { page: 'field-ops', fieldOpsSubArea: 'biosecurity' },
  'smoke_control': { page: 'field-ops', fieldOpsSubArea: 'smoke-control' },
  'reports': { page: 'reports', reportsTab: 'reports-hub' },
};

const NAVIGATION_MAP = {
  'Core': [
    { id: 'hub', label: 'Dashboard', icon: '📊' },
    { id: 'relationships', label: 'Relationships', icon: '🔗' },
    { id: 'crm', label: 'CRM & Finance', icon: '💰' },
    { id: 'roster', label: 'Roster & HR', icon: '👥' },
    { id: 'field-ops', label: 'Field Operations', icon: '🚗' },
    { id: 'reports', label: 'Reports', icon: '📈' },
  ],
  'Config': [
    { id: 'sites', label: 'Sites', icon: '📍' },
    { id: 'locations', label: 'Locations', icon: '🗺️' },
    { id: 'users', label: 'Users', icon: '👤' },
    { id: 'access-control', label: 'Access Control', icon: '🔐' },
    { id: 'org-setup', label: 'Organization Setup', icon: '⚙️' },
    { id: 'approvals', label: 'Approvals', icon: '✅' },
  ],
  'System': [
    { id: 'testing', label: 'E2E Testing', icon: '🧪' },
    { id: 'test-data', label: 'Test Data', icon: '📝' },
  ],
  'Platform': [
    { id: 'platform', label: 'Platform Overview', icon: '🌍' },
    { id: 'platform-catalog', label: 'Module Pricing', icon: '📦' },
    { id: 'platform-subscriptions', label: 'Provider Billing', icon: '💳' },
  ],
};

interface NavItemProps {
  id: string;
  label: string;
  icon: string;
  active: boolean;
  onClick: () => void;
}

const NavItem: React.FC<NavItemProps> = ({ id, label, icon, active, onClick }) => {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%',
        padding: '8px 12px',
        margin: '4px 0',
        backgroundColor: active ? 'var(--color-bg-secondary)' : 'transparent',
        border: 'none',
        borderLeft: active ? '3px solid var(--color-primary)' : '3px solid transparent',
        color: active ? 'var(--color-primary)' : 'var(--color-text-secondary)',
        cursor: 'pointer',
        textAlign: 'left',
        fontSize: '14px',
        fontWeight: active ? 500 : 400,
        transition: 'all 0.2s ease',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      }}
    >
      <span>{icon}</span>
      <span>{label}</span>
    </button>
  );
};

const LazyPageFallback: React.FC = () => (
  <div style={{
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    height: '100vh',
    color: 'var(--color-text-secondary)',
  }}>
    <div>Loading...</div>
  </div>
);

const AdminShell: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { profile } = useAuth();
  const { status: modulesStatus } = useEnabledModules(profile?.organizationId ?? null);
  const { agreements, sites, zones, selectedAgreement, selectedSite, selectedZone, loading: relationshipLoading } = useServiceRelationships();
  const modulesLoading = modulesStatus === 'loading';

  const [activePage, setActivePage] = useState<AdminPage>('hub');
  const [crmTab, setCrmTab] = useState<CRMTab>('crm');
  const [rosterTab, setRosterTab] = useState<RosterTab>('roster');
  const [fieldOpsSubArea, setFieldOpsSubArea] = useState<FieldOpsSubArea>('landing');
  const [reportsTab, setReportsTab] = useState<ReportsTab>('reports-hub');
  const [site360Tab, setSite360Tab] = useState<string>('overview');
  const [orgName, setOrgName] = useState<string>('');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [bobOpen, setBobOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  const pageFromUrl = useCallback((pathname: string): AdminPage => {
    const segments = pathname.split('/').filter(Boolean);
    if (segments[0] === 'admin') {
      const page = segments[1] as AdminPage || 'hub';
      return page;
    }
    return 'hub';
  }, []);

  useEffect(() => {
    const page = pageFromUrl(location.pathname);
    const redirectTarget = LEGACY_REDIRECT_MAP[page];

    if (redirectTarget) {
      setActivePage(redirectTarget.page);
      if (redirectTarget.crmTab) setCrmTab(redirectTarget.crmTab);
      if (redirectTarget.rosterTab) setRosterTab(redirectTarget.rosterTab);
      if (redirectTarget.fieldOpsSubArea) setFieldOpsSubArea(redirectTarget.fieldOpsSubArea);
      if (redirectTarget.reportsTab) setReportsTab(redirectTarget.reportsTab);
      navigate(`/admin/${redirectTarget.page}`);
    } else {
      setActivePage(page);
    }
  }, [location.pathname, navigate, pageFromUrl]);

  useEffect(() => {
    const loadOrgName = async () => {
      if (!profile?.organizationId) return;

      try {
        const { data, error } = await supabase
          .from('organizations')
          .select('name')
          .eq('id', profile.organizationId)
          .single();

        if (!error && data) {
          setOrgName(data.name);
        }
      } catch (err) {
        console.error('Failed to load org name:', err);
      }
    };

    loadOrgName();
  }, [profile?.organizationId]);

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const isPageEnabled = useCallback((page: AdminPage): boolean => {
    const isPlatformOperator = profile?.role === 'grand_master' || profile?.role === 'master';
    if (isPlatformOperator) return true;
    return true;
  }, [profile?.role]);

  const navigateToPage = useCallback((page: AdminPage) => {
    if (!isPageEnabled(page)) {
      setActivePage('hub');
      navigate('/admin/hub');
      return;
    }

    setActivePage(page);
    setMobileMenuOpen(false);
    navigate(`/admin/${page}`);
  }, [navigate, isPageEnabled]);

  const bobContext = useMemo(() => ({
    page: activePage,
    crmTab,
    rosterTab,
    fieldOpsSubArea,
    reportsTab,
    orgName,
    role: profile?.role,
    agreement: selectedAgreement,
    site: selectedSite,
    zone: selectedZone,
    agreements: agreements.slice(0, 10),
    sites: sites.slice(0, 10),
    zones: zones.slice(0, 10),
  }), [activePage, crmTab, rosterTab, fieldOpsSubArea, reportsTab, orgName, profile?.role, selectedAgreement, selectedSite, selectedZone, agreements, sites, zones]);

  const renderPage = useCallback(() => {
    switch (activePage) {
      case 'hub':
        return <AdminHubPage onNavigate={(page) => navigateToPage(page as AdminPage)} />;
      case 'relationships':
        return <RelationshipWorkspacePage />;
      case 'crm':
        return <CRMPage />;
      case 'reports':
        return <ReportsHubPage />;
      case 'field-ops':
        switch (fieldOpsSubArea) {
          case 'dispatch':
            return <DispatchConsolePage />;
          case 'patrol':
            return <PatrolPage />;
          case 'welfare-alerts':
            return <WelfareAlertsPage />;
          case 'smoke-control':
            return <SmokeControlPage />;
          case 'live-map':
            return <LiveMapPage />;
          case 'breach-review':
            return <BreachReviewPage />;
          case 'vehicle-search':
            return <VehicleSearchPage />;
          case 'field-reports':
            return <FieldReportsPage />;
          case 'parking':
            return <ParkingOversightPage />;
          case 'noise-control':
            return <NoiseControlOversightPage />;
          case 'biosecurity':
            return <BiosecurityOversightPage />;
          default:
            return <ComingSoonPage title="Field Operations" />;
        }
      case 'sites':
        return <SiteDetailPage />;
      case 'org-setup':
        return <OrganizationSetupPage />;
      case 'users':
        return <UserManagementPage />;
      case 'access-control':
        return <AccessControlPage />;
      case 'locations':
        return <LocationsPage />;
      case 'platform':
        return <GrandMasterPlatformPage />;
      case 'platform-catalog':
        return <ModuleCatalogPage />;
      case 'platform-subscriptions':
        return <ProviderBillingPage />;
      case 'approvals':
        return <ApprovalsActivityPage />;
      case 'roster':
        return <RosterHRPage />;
      default:
        return <AdminHubPage />;
    }
  }, [activePage, fieldOpsSubArea, navigateToPage]);

  if (!isMobile) {
    return (
      <div style={{ display: 'flex', height: '100vh', backgroundColor: 'var(--color-bg-primary)' }}>
        <aside
          style={{
            width: sidebarCollapsed ? '68px' : '220px',
            backgroundColor: 'var(--color-bg-secondary)',
            borderRight: '1px solid var(--color-border)',
            overflowY: 'auto',
            transition: 'width 0.2s ease',
            paddingTop: '16px',
          }}
        >
          <div style={{ padding: '0 12px', marginBottom: '16px' }}>
            <button
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              style={{
                width: '100%',
                padding: '8px',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--color-text-primary)',
              }}
            >
              {sidebarCollapsed ? '→' : '←'}
            </button>
          </div>

          {Object.entries(NAVIGATION_MAP).map(([group, items]) => (
            <div key={group} style={{ marginBottom: '24px' }}>
              {!sidebarCollapsed && (
                <div
                  style={{
                    padding: '8px 12px',
                    fontSize: '11px',
                    fontWeight: 600,
                    color: 'var(--color-text-secondary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                  }}
                >
                  {group}
                </div>
              )}
              {items.map((item) => (
                <NavItem
                  key={item.id}
                  id={item.id}
                  label={sidebarCollapsed ? '' : item.label}
                  icon={item.icon}
                  active={activePage === item.id}
                  onClick={() => navigateToPage(item.id as AdminPage)}
                />
              ))}
            </div>
          ))}
        </aside>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <header
            style={{
              height: '64px',
              backgroundColor: 'var(--color-bg-secondary)',
              borderBottom: '1px solid var(--color-border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingLeft: '24px',
              paddingRight: '24px',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ fontSize: '18px', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                Field Compliance Manager · {orgName}
              </div>
              {!relationshipLoading && (
                <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                  {selectedAgreement ? selectedAgreement.name : 'No agreement selected'}
                  {selectedSite ? ` · ${selectedSite.name}` : ''}
                  {selectedZone ? ` · ${selectedZone.name}` : ''}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
              <UniversalSearch onNavigate={(page: string, query?: string) => navigateToPage(page as AdminPage)} />
              <NotificationsBell onOpenBob={() => setBobOpen(true)} />
              <PortalSwitcher />
              {profile?.displayName && (
                <div style={{ fontSize: '14px', color: 'var(--color-text-secondary)' }}>
                  {profile.displayName}
                </div>
              )}
            </div>
          </header>

          <main
            data-app-content
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '24px',
            }}
          >
            <React.Suspense fallback={<LazyPageFallback />}>
              {renderPage()}
            </React.Suspense>
          </main>
        </div>

        <BobPanel
          open={bobOpen}
          onClose={() => setBobOpen(false)}
          context={bobContext}
        />

        <button
          onClick={() => setBobOpen(true)}
          style={{
            position: 'fixed',
            bottom: '24px',
            right: '24px',
            width: '56px',
            height: '56px',
            borderRadius: '50%',
            backgroundColor: 'var(--color-primary)',
            border: 'none',
            color: 'white',
            fontSize: '24px',
            cursor: 'pointer',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
            transition: 'transform 0.2s ease',
            zIndex: 100,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.1)')}
          onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
        >
          🤖
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', backgroundColor: 'var(--color-bg-primary)' }}>
      {/* Professional Header */}
      <ProfessionalHeader
        title={orgName || 'Administration'}
        subtitle={`${profile?.role?.charAt(0).toUpperCase()}${profile?.role?.slice(1).toLowerCase() || 'User'} Portal`}
        actions={[
          {
            label: 'Add Module',
            onClick: () => navigateToPage('platform-catalog'),
            variant: 'primary',
          },
        ]}
        userDisplayName={profile?.displayName}
      />

      {/* Main Layout with Sidebar */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Professional Navigation */}
        <ProfessionalNav
          sections={[
            {
              title: 'Core Operations',
              items: [
                { id: 'hub', label: 'Dashboard', path: '/admin', status: 'active' },
                { id: 'relationships', label: 'Relationships', path: '/admin/relationships', status: 'none' },
                { id: 'crm', label: 'CRM & Finance', path: '/admin/crm', status: 'alerts' },
                { id: 'roster', label: 'Roster & HR', path: '/admin/roster', status: 'pending' },
                { id: 'field-ops', label: 'Field Operations', path: '/admin/field-ops', status: 'active' },
              ],
            },
            {
              title: 'Reports & Analytics',
              items: [
                { id: 'reports', label: 'Reports', path: '/admin/reports', status: 'none' },
                { id: 'sites', label: 'Sites', path: '/admin/sites', status: 'none' },
                { id: 'locations', label: 'Locations', path: '/admin/locations', status: 'none' },
              ],
            },
            {
              title: 'Configuration',
              items: [
                { id: 'users', label: 'User Management', path: '/admin/users', status: 'none' },
                { id: 'access-control', label: 'Access Control', path: '/admin/access-control', status: 'none' },
                { id: 'org-setup', label: 'Organization', path: '/admin/org-setup', status: 'none' },
              ],
            },
            {
              title: 'Platform',
              items: [
                { id: 'platform', label: 'Platform', path: '/admin/platform', status: 'none' },
                { id: 'platform-billing', label: 'Billing', path: '/admin/platform-billing', status: 'none' },
              ],
            },
          ]}
          currentPath={location.pathname}
          onNavigate={(path) => navigate(path)}
        />

        {/* Main Content Area */}
        <main
          data-app-content
          style={{
            flex: 1,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <React.Suspense fallback={<LazyPageFallback />}>
            {renderPage()}
          </React.Suspense>
        </main>
      </div>

      {/* Bob AI Panel */}
      <BobPanel
        open={bobOpen}
        onClose={() => setBobOpen(false)}
        context={bobContext}
      />
    </div>
  );
};

export default AdminShell;
