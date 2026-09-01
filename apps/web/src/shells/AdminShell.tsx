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
import { NotificationCenter, type NotificationRecord } from '../components/NotificationCenter';
import { resolveNotificationDestination } from '../lib/notificationNavigation';
import {
  Bot,
  Building2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  CreditCard,
  DollarSign,
  FileBarChart,
  FlaskConical,
  Grid3X3,
  KeyRound,
  MapPin,
  Menu,
  Network,
  Package,
  Radio,
  Route,
  Search,
  Settings,
  Shield,
  Users,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useEnabledModules } from '../hooks/useEnabledModules';
import { supabase } from '../lib/supabase';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { BobPanel } from '../components/BobPanel';
import { WorkflowRail } from '../components/WorkflowRail';
import { readWorkflowContext, workflowContextQuery, type WorkflowContext } from '../lib/workflowNavigation';
import './AdminShell.css';

import AdminHubPage from '../pages/AdminHubPage';

// Lazy load pages for code-splitting
const CRMPage = React.lazy(() => import('../pages/CRMPage'));
const AccountOnboardingPage = React.lazy(() => import('../pages/AccountOnboardingPage'));
const ActivationHandoffsPage = React.lazy(() => import('../pages/ActivationHandoffsPage'));
const RelationshipWorkspacePage = React.lazy(() => import('../pages/RelationshipWorkspacePage'));
const RosterOperationsPage = React.lazy(() => import('../pages/RosterOperationsPage'));
const RosterHRPage = React.lazy(() => import('../pages/RosterHRPage'));
const RosterTargetsPage = React.lazy(() => import('../pages/RosterTargetsPage'));
const UserManagementPage = React.lazy(() => import('../pages/UserManagementPage'));
const SiteBoundaryReviewPage = React.lazy(() => import('../pages/SiteBoundaryReviewPage'));
const SiteDetailPage = React.lazy(() => import('../pages/SiteDetailPage'));
const ZoneDetailPage = React.lazy(() => import('../pages/ZoneDetailPage'));
const ApprovalsActivityPage = React.lazy(() => import('../pages/ApprovalsActivityPage'));
const LocationsPage = React.lazy(() => import('../pages/LocationsPage'));
const AccessControlPage = React.lazy(() => import('../pages/AccessControlPage'));
const OrganizationSetupPage = React.lazy(() => import('../pages/OrganizationSetupPage'));
const ModuleCatalogPage = React.lazy(() => import('../pages/ModuleCatalogPage'));
const GrandMasterPlatformPage = React.lazy(() => import('../pages/GrandMasterPlatformPage'));
const ProviderBillingPage = React.lazy(() => import('../pages/ProviderBillingPage'));
const BuilderControlRoomPage = React.lazy(() => import('../pages/BuilderControlRoomPage'));
const ReportsHubPage = React.lazy(() => import('../pages/ReportsHubPage'));
const PatrolOversightPage = React.lazy(() => import('../pages/PatrolOversightPage'));
const DispatchConsolePage = React.lazy(() => import('../pages/DispatchConsolePage'));
const WelfareAlertsPage = React.lazy(() => import('../pages/WelfareAlertsPage'));
const SmokeControlPage = React.lazy(() => import('../pages/modules/SmokeControlPage'));
const LiveMapPage = React.lazy(() => import('../pages/LiveMapPage'));
const OfficerActivityTimelinePage = React.lazy(() => import('../pages/OfficerActivityTimelinePage'));
const BreachReviewPage = React.lazy(() => import('../pages/BreachReviewPage'));
const VehicleSearchPage = React.lazy(() => import('../pages/VehicleSearchPage'));
const FieldReportsPage = React.lazy(() => import('../pages/FieldReportsPage'));
const FieldOperationsPage = React.lazy(() => import('../pages/FieldOperationsPage'));
const ParkingOversightPage = React.lazy(() => import('../pages/ParkingOversightPage'));
const NoiseControlOversightPage = React.lazy(() => import('../pages/NoiseControlOversightPage'));
const BiosecurityOversightPage = React.lazy(() => import('../pages/BiosecurityOversightPage'));
const EmsOversightPage = React.lazy(() => import('../pages/EmsOversightPage'));
const OnCallPeriodsPage = React.lazy(() => import('../pages/OnCallPeriodsPage'));
const PttChannelsPage = React.lazy(() => import('../pages/PttChannelsPage'));
const DebriefFollowupPage = React.lazy(() => import('../pages/DebriefFollowupPage'));

type AdminPage =
  | 'hub' | 'relationships' | 'onboarding' | 'handoffs' | 'crm' | 'roster' | 'people-hr' | 'roster-targets' | 'field-ops' | 'reports' | 'sites' | 'site-360' | 'zones'
  | 'site-ownership' | 'locations' | 'users' | 'access-control' | 'org-setup'
  | 'approvals' | 'testing' | 'test-data' | 'platform' | 'platform-catalog'
  | 'platform-subscriptions' | 'platform-billing' | 'builder';

type CRMTab = 'crm' | 'invoicing' | 'payments' | 'generate-invoice' | 'oncall' | 'financial-setup' | 'rate-rules' | 'tenders';
type RosterTab = 'roster' | 'staff' | 'training' | 'assets' | 'disciplinary' | 'credential-expiry' | 'shift-templates' | 'leave-approval' | 'timesheets' | 'callouts';
type FieldOpsSubArea = 'landing' | 'dispatch' | 'patrol' | 'live-map' | 'officer-activity' | 'welfare-alerts' | 'breach-review' | 'vehicle-search' | 'field-reports' | 'debrief-followup' | 'parking' | 'noise-control' | 'biosecurity' | 'smoke-control' | 'ems-alerts' | 'on-call' | 'ptt-channels';
type ReportsTab = 'reports-hub' | 'report-packs' | 'obligations' | 'fc-reporting' | 'fc-compliance' | 'fc-command-results';

const PLATFORM_ONLY_PAGES = new Set<AdminPage>([
  'testing', 'test-data', 'platform', 'platform-catalog', 'platform-subscriptions', 'platform-billing', 'builder',
]);

const CRM_MANAGEMENT_PAGES = new Set<AdminPage>([
  'relationships', 'onboarding', 'handoffs', 'crm', 'sites',
]);

const FIELD_OPS_AREAS = new Set<FieldOpsSubArea>([
  'landing', 'dispatch', 'patrol', 'live-map', 'officer-activity', 'welfare-alerts', 'breach-review', 'vehicle-search',
  'field-reports', 'parking', 'noise-control', 'biosecurity', 'smoke-control',
  'debrief-followup', 'ems-alerts', 'on-call', 'ptt-channels',
]);

function canAccessAdminPage(page: AdminPage, role: string | undefined): boolean {
  if (PLATFORM_ONLY_PAGES.has(page)) return role === 'grand_master' || role === 'master';
  if (CRM_MANAGEMENT_PAGES.has(page)) return role === 'grand_master' || role === 'master' || role === 'admin';
  return true;
}

interface RedirectTarget {
  page: AdminPage;
  crmTab?: CRMTab;
  rosterTab?: RosterTab;
  fieldOpsSubArea?: FieldOpsSubArea;
  reportsTab?: ReportsTab;
}

const LEGACY_REDIRECT_MAP: Record<string, RedirectTarget> = {
  'crm_finance': { page: 'crm', crmTab: 'crm' },
  'roster_hr': { page: 'people-hr' },
  'dispatch': { page: 'field-ops', fieldOpsSubArea: 'dispatch' },
  'patrol': { page: 'field-ops', fieldOpsSubArea: 'patrol' },
  'live_map': { page: 'field-ops', fieldOpsSubArea: 'live-map' },
  'officer_activity': { page: 'field-ops', fieldOpsSubArea: 'officer-activity' },
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
    { id: 'hub', label: 'Overview', icon: Grid3X3 },
    { id: 'relationships', label: 'Relationships', icon: Network },
    { id: 'onboarding', label: 'Account Onboarding', icon: ClipboardCheck },
    { id: 'handoffs', label: 'Activation Handoffs', icon: ClipboardCheck },
    { id: 'crm', label: 'CRM & Finance', icon: DollarSign },
    { id: 'roster', label: 'Roster', icon: Users },
    { id: 'people-hr', label: 'People & HR', icon: Users },
    { id: 'roster-targets', label: 'Work Units', icon: Route },
    { id: 'field-ops', label: 'Field Operations', icon: Radio },
    { id: 'reports', label: 'Reports', icon: FileBarChart },
  ],
  'Config': [
    { id: 'locations', label: 'Locations', icon: MapPin },
    { id: 'site-360', label: 'Sites', icon: Building2 },
    { id: 'zones', label: 'Zones', icon: MapPin },
    { id: 'sites', label: 'Boundary Review', icon: ClipboardCheck },
    { id: 'users', label: 'Users', icon: Users },
    { id: 'access-control', label: 'Access Control', icon: KeyRound },
    { id: 'org-setup', label: 'Organization Setup', icon: Settings },
    { id: 'approvals', label: 'Approvals', icon: ClipboardCheck },
  ],
  'System': [
    { id: 'testing', label: 'E2E Testing', icon: FlaskConical },
    { id: 'test-data', label: 'Test Data', icon: Package },
  ],
  'Platform': [
    { id: 'platform', label: 'Platform Overview', icon: Shield },
    { id: 'builder', label: 'Builder', icon: Bot },
    { id: 'platform-catalog', label: 'Module Pricing', icon: Package },
    { id: 'platform-subscriptions', label: 'Provider Billing', icon: CreditCard },
  ],
};

interface NavItemProps {
  id: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  onClick: () => void;
}

const NavItem: React.FC<NavItemProps> = ({ label, icon: Icon, active, onClick }) => {
  return (
    <button type="button" onClick={onClick} className={`admin-nav-item ${active ? 'is-active' : ''}`} title={label}>
      <span><Icon size={17} aria-hidden="true" /></span>
      <span>{label}</span>
    </button>
  );
};

const LazyPageFallback: React.FC = () => (
  <div className="admin-page-loading">
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
  const [accessNotice, setAccessNotice] = useState<string | null>(null);

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
      if (!canAccessAdminPage(redirectTarget.page, profile?.role)) {
        setAccessNotice('This area is not available for your current role.');
        setActivePage('hub');
        navigate('/admin/hub', { replace: true });
        return;
      }
      setActivePage(redirectTarget.page);
      if (redirectTarget.crmTab) setCrmTab(redirectTarget.crmTab);
      if (redirectTarget.rosterTab) setRosterTab(redirectTarget.rosterTab);
      if (redirectTarget.fieldOpsSubArea) setFieldOpsSubArea(redirectTarget.fieldOpsSubArea);
      if (redirectTarget.reportsTab) setReportsTab(redirectTarget.reportsTab);
      const areaQuery = redirectTarget.fieldOpsSubArea ? `?area=${redirectTarget.fieldOpsSubArea}` : '';
      navigate(`/admin/${redirectTarget.page}${areaQuery}`, { replace: true });
    } else if (!canAccessAdminPage(page, profile?.role)) {
      setAccessNotice('This area is not available for your current role.');
      setActivePage('hub');
      navigate('/admin/hub', { replace: true });
    } else {
      setAccessNotice(null);
      setActivePage(page);
      if (page === 'field-ops') {
        const requestedArea = new URLSearchParams(location.search).get('area') as FieldOpsSubArea | null;
        setFieldOpsSubArea(requestedArea && FIELD_OPS_AREAS.has(requestedArea) ? requestedArea : 'landing');
      }
    }
  }, [location.pathname, location.search, navigate, pageFromUrl, profile?.role]);

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
    return canAccessAdminPage(page, profile?.role);
  }, [profile?.role]);

  const navigateToPage = useCallback((page: AdminPage, context?: WorkflowContext) => {
    if (!isPageEnabled(page)) {
      setAccessNotice('This area is not available for your current role.');
      setActivePage('hub');
      navigate('/admin/hub');
      return;
    }

    setActivePage(page);
    setMobileMenuOpen(false);
    navigate(`/admin/${page}${workflowContextQuery(context)}`);
  }, [navigate, isPageEnabled]);

  const navigateToFieldOps = useCallback((area: FieldOpsSubArea) => {
    setFieldOpsSubArea(area);
    setActivePage('field-ops');
    setMobileMenuOpen(false);
    navigate(`/admin/field-ops?area=${area}`);
  }, [navigate]);

  const navigateFromHub = useCallback((destination: string) => {
    if (FIELD_OPS_AREAS.has(destination as FieldOpsSubArea)) {
      navigateToFieldOps(destination as FieldOpsSubArea);
      return;
    }
    navigateToPage(destination as AdminPage);
  }, [navigateToFieldOps, navigateToPage]);

  const workflowContext = useMemo(() => readWorkflowContext(location.search), [location.search]);

  const navigateFromNotification = useCallback((notification: NotificationRecord) => {
    const destination = resolveNotificationDestination(profile?.role ?? 'unknown', notification);
    if (!destination) return false;
    if (destination.kind === 'bob') {
      setBobOpen(true);
      return true;
    }
    if (destination.kind === 'admin_field_ops') {
      navigateToFieldOps(destination.area as FieldOpsSubArea);
      return true;
    }
    if (destination.kind === 'admin_hr_credential') {
      const credential = destination.credentialId ? `&credential=${encodeURIComponent(destination.credentialId)}` : '';
      navigate(`/admin/people-hr?tab=credentials${credential}`);
      return true;
    }
    if (destination.kind === 'admin_page') {
      navigateToPage(destination.page as AdminPage);
      return true;
    }
    return false;
  }, [navigate, navigateToFieldOps, navigateToPage, profile?.role]);

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
        return <AdminHubPage onNavigate={navigateFromHub} />;
      case 'relationships':
        return <RelationshipWorkspacePage onNavigate={(destination, context) => navigateToPage(destination as AdminPage, context)} />;
      case 'onboarding':
        return <AccountOnboardingPage onNavigate={(destination, context) => navigateToPage(destination as AdminPage, context)} />;
      case 'handoffs':
        return <ActivationHandoffsPage onNavigate={(destination, context) => navigateToPage(destination as AdminPage, context)} />;
      case 'crm':
        return <CRMPage onNavigate={(destination, context) => navigateToPage(destination as AdminPage, context)} />;
      case 'reports':
        return <ReportsHubPage />;
      case 'field-ops':
        switch (fieldOpsSubArea) {
          case 'landing':
            return <FieldOperationsPage onNavigate={navigateToFieldOps} />;
          case 'dispatch':
            return <DispatchConsolePage />;
          case 'patrol':
            return <PatrolOversightPage />;
          case 'welfare-alerts':
            return <WelfareAlertsPage />;
          case 'smoke-control':
            return <SmokeControlPage />;
          case 'live-map':
            return <LiveMapPage />;
          case 'officer-activity':
            return <OfficerActivityTimelinePage />;
          case 'breach-review':
            return <BreachReviewPage />;
          case 'vehicle-search':
            return <VehicleSearchPage />;
          case 'field-reports':
            return <FieldReportsPage />;
          case 'debrief-followup':
            return <DebriefFollowupPage />;
          case 'parking':
            return <ParkingOversightPage />;
          case 'noise-control':
            return <NoiseControlOversightPage />;
          case 'biosecurity':
            return <BiosecurityOversightPage />;
          case 'ems-alerts':
            return <EmsOversightPage />;
          case 'on-call':
            return <OnCallPeriodsPage />;
          case 'ptt-channels':
            return <PttChannelsPage />;
          default:
            return <FieldOperationsPage onNavigate={navigateToFieldOps} />;
        }
      case 'sites':
        return <SiteBoundaryReviewPage />;
      case 'site-360':
        return <SiteDetailPage />;
      case 'zones':
        return <ZoneDetailPage />;
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
      case 'builder':
        return <BuilderControlRoomPage />;
      case 'platform-catalog':
        return <ModuleCatalogPage />;
      case 'platform-subscriptions':
        return <ProviderBillingPage />;
      case 'approvals':
        return <ApprovalsActivityPage />;
      case 'roster':
        return <RosterOperationsPage />;
      case 'people-hr':
        return <RosterHRPage />;
      case 'roster-targets':
        return <RosterTargetsPage />;
      default:
        return <AdminHubPage />;
    }
  }, [activePage, fieldOpsSubArea, navigateFromHub, navigateToFieldOps]);

  if (!isMobile) {
    return (
      <div className="admin-shell admin-shell-desktop">
        <aside className={`admin-sidebar ${sidebarCollapsed ? 'is-collapsed' : ''}`}>
          <div className="admin-sidebar-brand">
            <span><Shield size={18} aria-hidden="true" /></span>
            {!sidebarCollapsed && <div><strong>FCM</strong><small>Administration</small></div>}
            <button type="button" onClick={() => setSidebarCollapsed(!sidebarCollapsed)} title={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'}>
              {sidebarCollapsed ? <ChevronRight size={17} aria-hidden="true" /> : <ChevronLeft size={17} aria-hidden="true" />}
            </button>
          </div>

          {Object.entries(NAVIGATION_MAP).filter(([group]) => (group !== 'System' && group !== 'Platform') || canAccessAdminPage('platform', profile?.role)).map(([group, items]) => (
            <div key={group} className="admin-nav-group">
              {!sidebarCollapsed && (
                <div className="admin-nav-group-label">{group}</div>
              )}
              {items.filter((item) => canAccessAdminPage(item.id as AdminPage, profile?.role)).map((item) => (
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

        <div className="admin-shell-workspace">
          <header className="admin-shell-header">
            <div className="admin-shell-context">
              <strong>{orgName || 'Field Compliance Manager'}</strong>
              {!relationshipLoading && (
                <span>
                  {selectedAgreement ? selectedAgreement.name : 'No agreement selected'}
                  {selectedSite ? ` · ${selectedSite.name}` : ''}
                  {selectedZone ? ` · ${selectedZone.name}` : ''}
                </span>
              )}
            </div>
            <div className="admin-shell-tools">
              <NotificationCenter onNavigate={navigateFromNotification} />
              <button type="button" className="admin-top-search" onClick={() => navigateToFieldOps('vehicle-search')}>
                <Search size={17} aria-hidden="true" /><span>Vehicle search</span>
              </button>
              <button type="button" className="admin-shell-icon" onClick={() => setBobOpen(true)} title="Open Bob assistant">
                <Bot size={19} aria-hidden="true" /><span className="sr-only">Open Bob assistant</span>
              </button>
              <div className="admin-profile-chip">{profile?.displayName ?? profile?.role ?? 'Administrator'}</div>
            </div>
          </header>

          <main data-app-content className={`admin-shell-main ${activePage === 'hub' ? 'is-overview' : ''}`}>
            {accessNotice && <div role="alert" className="admin-access-notice">{accessNotice}</div>}
            <WorkflowRail activePage={activePage} context={workflowContext} onNavigate={(destination, context) => navigateToPage(destination as AdminPage, context)} />
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

      </div>
    );
  }

  return (
    <div className="admin-shell admin-shell-mobile">
      <header className="admin-mobile-header">
        <div className="admin-mobile-brand">
          <span><Shield size={17} aria-hidden="true" /></span><strong>{orgName || 'Field Compliance Manager'}</strong>
        </div>
        <div className="admin-shell-tools">
          <NotificationCenter onNavigate={navigateFromNotification} />
          <button type="button" className="admin-shell-icon" onClick={() => setBobOpen(true)} title="Open Bob assistant">
            <Bot size={19} aria-hidden="true" /><span className="sr-only">Open Bob assistant</span>
          </button>
          <button type="button" className="admin-shell-icon" onClick={() => setMobileMenuOpen(!mobileMenuOpen)} title={mobileMenuOpen ? 'Close navigation' : 'Open navigation'}>
            {mobileMenuOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
            <span className="sr-only">{mobileMenuOpen ? 'Close navigation' : 'Open navigation'}</span>
          </button>
        </div>
      </header>

      {mobileMenuOpen && (
        <div className="admin-mobile-overlay" onClick={() => setMobileMenuOpen(false)}>
          <nav className="admin-mobile-drawer" onClick={(e) => e.stopPropagation()}>
            {Object.entries(NAVIGATION_MAP).filter(([group]) => (group !== 'System' && group !== 'Platform') || canAccessAdminPage('platform', profile?.role)).map(([group, items]) => (
              <div key={group} className="admin-mobile-nav-group">
                <div>{group}</div>
                {items.filter((item) => canAccessAdminPage(item.id as AdminPage, profile?.role)).map((item) => {
                  const Icon = item.icon;
                  return (
                    <button key={item.id} onClick={() => navigateToPage(item.id as AdminPage)} className={`admin-mobile-nav-item ${activePage === item.id ? 'is-active' : ''}`}>
                      <Icon size={17} aria-hidden="true" /><span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>
        </div>
      )}

      <main data-app-content className={`admin-shell-main ${activePage === 'hub' ? 'is-overview' : ''}`}>
        {accessNotice && <div role="alert" className="admin-access-notice">{accessNotice}</div>}
        <WorkflowRail activePage={activePage} context={workflowContext} onNavigate={(destination, context) => navigateToPage(destination as AdminPage, context)} />
        <React.Suspense fallback={<LazyPageFallback />}>
          {renderPage()}
        </React.Suspense>
      </main>

      <nav className="admin-mobile-tabs" aria-label="Admin navigation">
        {[
          { id: 'hub', label: 'Home', icon: Grid3X3 },
          { id: 'field-ops', label: 'Field Ops', icon: Radio },
          { id: 'roster', label: 'Roster', icon: Users },
          { id: 'crm', label: 'CRM', icon: DollarSign },
          { id: 'reports', label: 'Reports', icon: FileBarChart },
        ].map((tab) => {
          const Icon = tab.icon;
          return (
            <button key={tab.id} onClick={() => navigateToPage(tab.id as AdminPage)} className={activePage === tab.id ? 'is-active' : ''}>
              <Icon size={19} aria-hidden="true" /><span>{tab.label}</span>
            </button>
          );
        })}
      </nav>

      <BobPanel
        open={bobOpen}
        onClose={() => setBobOpen(false)}
        context={bobContext}
      />

    </div>
  );
};

export default AdminShell;
