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
  BarChart3,
  Bot,
    Calculator,
  Building2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  CreditCard,
  DollarSign,
  Download,
  FileBarChart,
  FolderOpen,
  FlaskConical,
  Grid3X3,
  Handshake,
  KeyRound,
  Landmark,
  LogOut,
  MapPin,
  Menu,
  Network,
  Package,
  Radio,
  Route,
  Search,
  Settings,
    Tags,
  Shield,
  Users,
  Wrench,
  WalletCards,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useEnabledModules } from '../hooks/useEnabledModules';
import { getModuleAccessMessage } from '../lib/moduleAccessMessage';
import { supabase } from '../lib/supabase';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { BobPanel } from '../components/BobPanel';
import { WorkflowRail } from '../components/WorkflowRail';
import { OperatingSpineRibbon } from '../components/OperatingSpineRibbon';
import { HelpInstructions } from '../components/HelpInstructions';
import { PlaceContextBanner } from '../components/PlaceContextBanner';
import { readWorkflowContext, workflowContextQuery, type WorkflowContext } from '../lib/workflowNavigation';
import { canAccessFieldOpsArea, FIELD_OPS_AREAS, isFieldOpsSubArea, type FieldOpsSubArea } from '../lib/fieldOpsAreaAccess';
import './AdminShell.css';

import AdminHubPage from '../pages/AdminHubPage';
import { DESKTOP_V2_DOWNLOAD_URL, DESKTOP_V2_FILENAME, DESKTOP_V2_VERSION } from '../lib/desktopReleases';

// Lazy load pages for code-splitting
const CRMPage = React.lazy(() => import('../pages/CRMPage'));
const ClientSetupPage = React.lazy(() => import('../pages/ClientSetupPage'));
const AccountOnboardingPage = React.lazy(() => import('../pages/AccountOnboardingPage'));
const ActivationHandoffsPage = React.lazy(() => import('../pages/ActivationHandoffsPage'));
const RelationshipWorkspacePage = React.lazy(() => import('../pages/RelationshipWorkspacePage'));
const RosterOperationsPage = React.lazy(() => import('../pages/RosterOperationsPage'));
const RosterHRPage = React.lazy(() => import('../pages/RosterHRPage'));
const RateRulesPage = React.lazy(() => import('../pages/RateRulesPage'));
const WorkshopPage = React.lazy(() => import('../pages/WorkshopPage'));
const FinanceBureauPage = React.lazy(() => import('../pages/FinanceBureauPage'));
const FinanceConnectionsPage = React.lazy(() => import('../pages/FinanceConnectionsPage'));
const FinanceMoneyPage = React.lazy(() => import('../pages/FinanceMoneyPage'));
const FinanceCostingPage = React.lazy(() => import('../pages/FinanceCostingPage'));
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
const ModuleSubscriptionsPage = React.lazy(() => import('../pages/ModuleSubscriptionsPage'));
const GrandMasterPlatformPage = React.lazy(() => import('../pages/GrandMasterPlatformPage'));
const ProviderBillingPage = React.lazy(() => import('../pages/ProviderBillingPage'));
const PlatformSubscribersPage = React.lazy(() => import('../pages/PlatformSubscribersPage'));
const BuilderControlRoomPage = React.lazy(() => import('../pages/BuilderControlRoomPage'));
const BobWorkspacePage = React.lazy(() => import('../pages/BobWorkspacePage'));
const BobDocumentStudioPage = React.lazy(() => import('../pages/BobDocumentStudioPage'));
const ReportsHubPage = React.lazy(() => import('../pages/ReportsHubPage'));
const FileSystemPage = React.lazy(() => import('../pages/FileSystemPage'));
const PatrolOversightPage = React.lazy(() => import('../pages/PatrolOversightPage'));
const DispatchConsolePage = React.lazy(() => import('../pages/DispatchConsolePage'));
const WelfareAlertsPage = React.lazy(() => import('../pages/WelfareAlertsPage'));
const SmokeControlPage = React.lazy(() => import('../pages/modules/SmokeControlPage'));
const LiveMapPage = React.lazy(() => import('../pages/LiveMapPage'));
const OfficerActivityTimelinePage = React.lazy(() => import('../pages/OfficerActivityTimelinePage'));
const BreachReviewPage = React.lazy(() => import('../pages/BreachReviewPage'));
const VehicleSearchPage = React.lazy(() => import('../pages/VehicleSearchPage'));
const FieldReportsPage = React.lazy(() => import('../pages/FieldReportsPage'));
const InvestigationPage = React.lazy(() => import('../pages/InvestigationPage'));
const FieldOperationsPage = React.lazy(() => import('../pages/FieldOperationsPage'));
const ParkingOversightPage = React.lazy(() => import('../pages/ParkingOversightPage'));
const NoiseControlOversightPage = React.lazy(() => import('../pages/NoiseControlOversightPage'));
const BiosecurityOversightPage = React.lazy(() => import('../pages/BiosecurityOversightPage'));
const DebriefFollowupPage = React.lazy(() => import('../pages/DebriefFollowupPage'));
const CCTVReviewPage = React.lazy(() => import('../pages/CCTVReviewPage'));
const CCTVVideoLibraryPage = React.lazy(() => import('../pages/CCTVVideoLibraryPage'));
const CCTVImportPage = React.lazy(() => import('../pages/CCTVImportPage'));
const CCTVConsolePage = React.lazy(() => import('../pages/CCTVConsolePage'));
const CCTVTriagePage = React.lazy(() => import('../pages/CCTVTriagePage'));
const ObservationSearchPage = React.lazy(() => import('../pages/ObservationSearchPage'));

type AdminPage =
  | 'hub' | 'bob' | 'document-studio' | 'files' | 'relationships' | 'onboarding' | 'handoffs' | 'crm' | 'client-setup' | 'finance-bureau' | 'finance-connections' | 'finance-money' | 'finance-costing' | 'finance-pricing' | 'rate-rules' | 'roster' | 'people-hr' | 'roster-targets' | 'field-ops' | 'investigations' | 'reports' | 'sites' | 'site-360' | 'zones'
  | 'locations' | 'users' | 'access-control' | 'org-setup' | 'module-subscriptions'
  | 'approvals' | 'testing' | 'test-data' | 'platform' | 'platform-catalog'
  | 'platform-subscriptions' | 'platform-subscribers' | 'builder' | 'workshop';

type CRMTab = 'crm' | 'invoicing' | 'payments' | 'generate-invoice' | 'oncall' | 'financial-setup' | 'rate-rules' | 'tenders';
type RosterTab = 'roster' | 'staff' | 'training' | 'assets' | 'disciplinary' | 'credential-expiry' | 'shift-templates' | 'leave-approval' | 'timesheets' | 'callouts';
type ReportsTab = 'reports-hub' | 'report-packs' | 'obligations' | 'fc-reporting' | 'fc-compliance' | 'fc-command-results';

const PLATFORM_ONLY_PAGES = new Set<AdminPage>([
  'testing', 'test-data', 'platform', 'platform-catalog', 'platform-subscriptions', 'platform-subscribers', 'builder',
]);

const CRM_MANAGEMENT_PAGES = new Set<AdminPage>([
  'relationships', 'onboarding', 'handoffs', 'crm', 'client-setup', 'finance-bureau', 'finance-connections', 'finance-money', 'finance-costing', 'finance-pricing', 'sites',
]);

const APPROVAL_DECISION_ROLES = new Set(['grand_master', 'master', 'admin']);
const ROSTER_MANAGEMENT_ROLES = new Set(['grand_master', 'master', 'admin', 'admin_officer']);
const ROSTER_MANAGEMENT_PAGES = new Set<AdminPage>(['roster', 'roster-targets']);

const FIELD_CONTEXT_PAGES = new Set<AdminPage>(['field-ops', 'site-360', 'locations', 'zones', 'sites', 'workshop', 'investigations']);

// Maps an AdminPage to the platform module (see platformModuleManifest.ts)
// that must be enabled for the caller's org to reach it. Pages absent here
// have no module gate (role checks below still apply).
const PAGE_PLATFORM_MODULE: Partial<Record<AdminPage, string>> = {
  crm: 'crm', relationships: 'crm', onboarding: 'crm', handoffs: 'crm', 'client-setup': 'crm',
  roster: 'rostering', 'roster-targets': 'rostering',
  'people-hr': 'hr',
  'finance-bureau': 'finance', 'finance-connections': 'finance', 'finance-money': 'finance', 'finance-costing': 'finance', 'finance-pricing': 'finance', 'rate-rules': 'finance',
  workshop: 'workshop',
};

function canAccessAdminPage(page: AdminPage, role: string | undefined, isModuleEnabled: (moduleKey: string) => boolean): boolean {
  if (PLATFORM_ONLY_PAGES.has(page)) return role === 'grand_master' || role === 'master';
  if (CRM_MANAGEMENT_PAGES.has(page) && !(role === 'grand_master' || role === 'master' || role === 'admin')) return false;
  if (page === 'approvals' && (!role || !APPROVAL_DECISION_ROLES.has(role))) return false;
  if (ROSTER_MANAGEMENT_PAGES.has(page) && (!role || !ROSTER_MANAGEMENT_ROLES.has(role))) return false;
  const requiredModule = PAGE_PLATFORM_MODULE[page];
  if (requiredModule && !isModuleEnabled(requiredModule)) return false;
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
  'platform-billing': { page: 'platform-subscriptions' },
};

interface WorkspaceItem {
  id: AdminPage;
  label: string;
  icon: LucideIcon;
  area?: FieldOpsSubArea;
}

const NAVIGATION_MAP: Record<string, WorkspaceItem[]> = {
  'Mission Control': [
    { id: 'hub', label: 'Overview', icon: Grid3X3 },
    { id: 'approvals', label: 'Approvals', icon: ClipboardCheck },
  ],
  'Field Operations': [
    { id: 'field-ops', label: 'Field Operations', icon: Radio },
    { id: 'field-ops', label: 'Dispatch console', icon: Radio, area: 'dispatch' },
    { id: 'field-ops', label: 'Patrol operations', icon: Route, area: 'patrol' },
    { id: 'field-ops', label: 'Live map', icon: MapPin, area: 'live-map' },
    { id: 'field-ops', label: 'Field reports', icon: ClipboardCheck, area: 'field-reports' },
    { id: 'field-ops', label: 'Video evidence', icon: FolderOpen, area: 'cctv-console' },
    { id: 'site-360', label: 'Site Workspaces', icon: Building2 },
    { id: 'locations', label: 'Location Houses', icon: MapPin },
    { id: 'zones', label: 'Zone Facets', icon: MapPin },
    { id: 'sites', label: 'Geofence Workbench', icon: ClipboardCheck },
    { id: 'workshop', label: 'Workshop', icon: Wrench },
  ],
  Workforce: [
    { id: 'roster', label: 'Schedules & Rosters', icon: Users },
    { id: 'people-hr', label: 'People, Pay & HR', icon: Users },
    { id: 'roster-targets', label: 'Work Units & Coverage', icon: Route },
    { id: 'users', label: 'People & Access', icon: Users },
  ],
  'Clients & Delivery': [
    { id: 'crm', label: 'Client Portfolios', icon: DollarSign },
    { id: 'relationships', label: 'Agreements & services', icon: Handshake },
    { id: 'client-setup', label: 'Set up a new client', icon: ClipboardCheck },
    { id: 'onboarding', label: 'Clients being set up', icon: ClipboardCheck },
    { id: 'handoffs', label: 'Start delivery', icon: ClipboardCheck },
  ],
  Finance: [
    { id: 'finance-bureau', label: 'Finance home', icon: DollarSign },
    { id: 'finance-money', label: 'Business money check', icon: BarChart3 },
    { id: 'finance-connections', label: 'Connect ANZ & IRD', icon: Landmark },
    { id: 'finance-costing', label: 'What should a job cost?', icon: Calculator },
    { id: 'finance-pricing', label: 'Prices & discounts', icon: Tags },
    { id: 'rate-rules', label: 'Pay & charge rules', icon: DollarSign },
  ],
  'Reports & Analytics': [
    { id: 'reports', label: 'Reports', icon: FileBarChart },
  ],
  'Intelligence & Records': [
    { id: 'files', label: 'File System', icon: FolderOpen },
    { id: 'investigations', label: 'Investigations', icon: Search },
  ],
  'Platform & Settings': [
    { id: 'access-control', label: 'Access Rules', icon: KeyRound },
    { id: 'org-setup', label: 'Organisation settings', icon: Settings },
    { id: 'module-subscriptions', label: 'Modules & Subscriptions', icon: Package },
    { id: 'testing', label: 'E2E Testing', icon: FlaskConical },
    { id: 'test-data', label: 'Test Data', icon: Package },
    { id: 'platform', label: 'Platform Overview', icon: Shield },
    { id: 'platform-subscribers', label: 'Subscribers', icon: Building2 },
    { id: 'builder', label: 'Builder', icon: Bot },
    { id: 'platform-catalog', label: 'Module Pricing', icon: Package },
    { id: 'platform-subscriptions', label: 'Provider Billing', icon: CreditCard },
  ],
};

const NAVIGABLE_ADMIN_PAGES = new Set<AdminPage>([
  ...Object.values(NAVIGATION_MAP).flatMap((items) => items.map((item) => item.id)),
  'bob', 'document-studio',
]);

const WORKSPACE_LABELS: Record<string, { label: string; icon: LucideIcon }> = {
  'Mission Control': { label: 'Overview & approvals', icon: Grid3X3 },
  'Field Operations': { label: 'Guarding & Patrol', icon: Shield },
  Workforce: { label: 'HR & Rostering', icon: Users },
  'Clients & Delivery': { label: 'CRM & Clients', icon: Handshake },
  Finance: { label: 'Finance', icon: WalletCards },
  'Reports & Analytics': { label: 'Reports & Accountability', icon: FileBarChart },
  'Intelligence & Records': { label: 'Investigations & Evidence', icon: FolderOpen },
  'Platform & Settings': { label: 'Organisation & Settings', icon: Settings },
};

interface NavItemProps {
  id: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}

const NavItem: React.FC<NavItemProps> = ({ label, icon: Icon, active, disabled = false, onClick }) => {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`admin-nav-item ${active ? 'is-active' : ''}`} title={disabled ? `${label} is not enabled for this organisation` : label} aria-label={label} aria-current={active ? 'page' : undefined}>
      <span><Icon size={17} aria-hidden="true" /></span>
      <span>{label}{disabled && <small className="admin-workspace-unavailable">Not enabled</small>}</span>
    </button>
  );
};

const LazyPageFallback: React.FC = () => (
  <div className="admin-page-loading">
    <div>Loading...</div>
  </div>
);

class LazyPageRecovery extends React.Component<{ pageKey: string; children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    const isChunkFailure = /failed to fetch dynamically imported module|importing a module script failed|chunkloaderror/i.test(error.message);
    const reloadKey = `fcm:lazy-page-reload:${window.location.pathname}${window.location.search}`;
    if (isChunkFailure && !window.sessionStorage.getItem(reloadKey)) {
      window.sessionStorage.setItem(reloadKey, '1');
      window.location.reload();
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <section className="admin-page-loading" role="alert"><strong>This page could not load.</strong><span>{this.state.error.message}</span><button type="button" onClick={() => this.setState({ error: null })}>Retry page</button></section>;
  }
}

const AdminShell: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { profile, signOut, operatingOrganizationId, operatingOrganizations, setOperatingOrganization } = useAuth();
  const activeOrganizationId = operatingOrganizationId ?? profile?.organizationId ?? null;
  const { status: modulesStatus, isModuleEnabled } = useEnabledModules(activeOrganizationId);
  const { agreements, sites, zones, selectedAgreement, selectedSite, selectedZone, setLocationMode, loading: relationshipLoading } = useServiceRelationships();

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
  const [bobLaunchPrompt, setBobLaunchPrompt] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [accessNotice, setAccessNotice] = useState<string | null>(null);
  const [showDesktopDownload, setShowDesktopDownload] = useState(false);
  useEffect(() => { setLocationMode('manual'); }, [setLocationMode]);
  const dismissDesktopDownload = () => {
    if (profile?.id) window.localStorage.setItem(`fcm:desktop-download-prompt-v2-dismissed:${profile.id}`, '1');
    setShowDesktopDownload(false);
  };

  const pageFromUrl = useCallback((pathname: string): AdminPage => {
    const segments = pathname.split('/').filter(Boolean);
    if (segments[0] === 'admin') {
      const page = segments[1] as AdminPage || 'hub';
      return page;
    }
    return 'hub';
  }, []);

  const isFieldOpsAreaEnabled = useCallback((area: FieldOpsSubArea) => {
    if (modulesStatus === 'loading') return area !== 'welfare-alerts';
    return canAccessFieldOpsArea(area, isModuleEnabled);
  }, [isModuleEnabled, modulesStatus]);

  useEffect(() => {
    // The module gate is evaluated only once the tenant's subscription state is known. While it is
    // loading, isModuleEnabled() answers false, and redirecting on that answer would silently throw
    // away every deep link / refresh on a gated page (a "loading" is not a "denied").
    if (modulesStatus === 'loading') return;
    const routeSegment = location.pathname.split('/').filter(Boolean)[1];
    const page = pageFromUrl(location.pathname);
    const redirectTarget = LEGACY_REDIRECT_MAP[page];
    const moduleCheck = isModuleEnabled;
    const deniedNotice = modulesStatus === 'error'
      ? 'Module subscriptions for this organisation could not be loaded, so gated areas are unavailable until they load.'
      : 'This area is not available for your current role.';

    if (routeSegment && !redirectTarget && !NAVIGABLE_ADMIN_PAGES.has(page)) {
      const unavailableNotice = 'This page is unavailable. Choose an available workspace destination.';
      setActivePage('hub');
      navigate('/admin/hub', { replace: true, state: { adminAccessNotice: unavailableNotice } });
      return;
    }

    if (redirectTarget) {
      if (redirectTarget.fieldOpsSubArea && !canAccessFieldOpsArea(redirectTarget.fieldOpsSubArea, moduleCheck)) {
        const areaNotice = modulesStatus === 'error'
          ? deniedNotice
          : 'This operational area is not enabled for your current organisation.';
        setActivePage('field-ops');
        setFieldOpsSubArea('landing');
        navigate('/admin/field-ops', { replace: true, state: { adminAccessNotice: areaNotice } });
        return;
      }
      if (!canAccessAdminPage(redirectTarget.page, profile?.role, isModuleEnabled)) {
        setAccessNotice(deniedNotice);
        setActivePage('hub');
        navigate('/admin/hub', { replace: true, state: { adminAccessNotice: deniedNotice } });
        return;
      }
      setActivePage(redirectTarget.page);
      if (redirectTarget.crmTab) setCrmTab(redirectTarget.crmTab);
      if (redirectTarget.rosterTab) setRosterTab(redirectTarget.rosterTab);
      if (redirectTarget.fieldOpsSubArea) setFieldOpsSubArea(redirectTarget.fieldOpsSubArea);
      if (redirectTarget.reportsTab) setReportsTab(redirectTarget.reportsTab);
      const areaQuery = redirectTarget.fieldOpsSubArea ? `?area=${redirectTarget.fieldOpsSubArea}` : '';
      // A self-redirect (reports -> reports) re-fires this effect on every navigation and traps the user on the page.
      if (redirectTarget.page !== page) navigate(`/admin/${redirectTarget.page}${areaQuery}`, { replace: true });
    } else if (!canAccessAdminPage(page, profile?.role, isModuleEnabled)) {
      setAccessNotice(deniedNotice);
      setActivePage('hub');
      navigate('/admin/hub', { replace: true, state: { adminAccessNotice: deniedNotice } });
    } else {
      const carriedNotice = (location.state as { adminAccessNotice?: unknown } | null)?.adminAccessNotice;
      setAccessNotice(typeof carriedNotice === 'string' ? carriedNotice : null);
      setActivePage(page);
      if (page === 'field-ops') {
        const requestedArea = new URLSearchParams(location.search).get('area');
        if (!isFieldOpsSubArea(requestedArea)) {
          setFieldOpsSubArea('landing');
          if (requestedArea) navigate('/admin/field-ops', { replace: true });
          return;
        }
        if (!canAccessFieldOpsArea(requestedArea, moduleCheck)) {
          const areaNotice = modulesStatus === 'error'
            ? deniedNotice
            : 'This operational area is not enabled for your current organisation.';
          setFieldOpsSubArea('landing');
          navigate('/admin/field-ops', { replace: true, state: { adminAccessNotice: areaNotice } });
          return;
        }
        setFieldOpsSubArea(requestedArea);
      }
    }
  }, [location.pathname, location.search, location.state, navigate, pageFromUrl, profile?.role, isModuleEnabled, modulesStatus]);

  useEffect(() => {
    const loadOrgName = async () => {
      if (!profile?.organizationId) return;

      try {
        const { data, error } = await supabase
          .from('organizations')
          .select('name')
          .eq('id', activeOrganizationId)
          .single();

        if (!error && data) {
          setOrgName(data.name);
        }
      } catch (err) {
        console.error('Failed to load org name:', err);
      }
    };

    loadOrgName();
  }, [activeOrganizationId]);

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // GPS / geofence evidence belongs to field pages; on a desk page (clients, finance, roster, settings) it only confuses.
  const showPlaceContext = FIELD_CONTEXT_PAGES.has(activePage);
  const isPageEnabled = useCallback((page: AdminPage): boolean => {
    // While subscriptions are still loading, isModuleEnabled() answers false for everything; that is "unknown", not "denied".
    // Role checks still apply, and the route effect re-evaluates the module gate once loading finishes.
    return canAccessAdminPage(page, profile?.role, modulesStatus === 'loading' ? () => true : isModuleEnabled);
  }, [profile?.role, isModuleEnabled, modulesStatus]);

  const navigateToPage = useCallback((page: AdminPage, context?: WorkflowContext) => {
    if (!isPageEnabled(page)) {
      const deniedNotice = 'This area is not available for your current role.';
      setAccessNotice(deniedNotice);
      setActivePage('hub');
      navigate('/admin/hub', { state: { adminAccessNotice: deniedNotice } });
      return;
    }

    setActivePage(page);
    setMobileMenuOpen(false);
    navigate(`/admin/${page}${workflowContextQuery(context)}`);
  }, [navigate, isPageEnabled]);

  const navigateToFieldOps = useCallback((area: FieldOpsSubArea) => {
    if (!isFieldOpsAreaEnabled(area)) {
      const areaNotice = modulesStatus === 'error'
        ? 'Module subscriptions for this organisation could not be loaded, so gated areas are unavailable until they load.'
        : 'This operational area is not enabled for your current organisation.';
      setActivePage('field-ops');
      setFieldOpsSubArea('landing');
      setMobileMenuOpen(false);
      navigate('/admin/field-ops', { state: { adminAccessNotice: areaNotice } });
      return;
    }
    setAccessNotice(null);
    setFieldOpsSubArea(area);
    setActivePage('field-ops');
    setMobileMenuOpen(false);
    navigate(`/admin/field-ops?area=${area}`);
  }, [isFieldOpsAreaEnabled, modulesStatus, navigate]);

  const navigateFinance = useCallback((page: Extract<AdminPage, 'finance-bureau' | 'finance-connections' | 'finance-money' | 'finance-costing' | 'finance-pricing'>) => {
    window.scrollTo({ top: 0 });
    document.querySelector<HTMLElement>('[data-app-content]')?.scrollTo({ top: 0 });
    navigateToPage(page);
  }, [navigateToPage]);

  const navigateFromHub = useCallback((destination: string) => {
    if (destination.startsWith('dispatch?')) {
      setFieldOpsSubArea('dispatch');
      setActivePage('field-ops');
      navigate(`/admin/field-ops?area=dispatch&${destination.slice('dispatch?'.length)}`);
      return;
    }
    if (FIELD_OPS_AREAS.has(destination as FieldOpsSubArea)) {
      navigateToFieldOps(destination as FieldOpsSubArea);
      return;
    }
    navigateToPage(destination as AdminPage);
  }, [navigateToFieldOps, navigateToPage]);

  const workflowContext = useMemo(() => readWorkflowContext(location.search), [location.search]);

  const visibleWorkspaces = Object.entries(NAVIGATION_MAP)
    .filter(([, items]) => items.some((item) => canAccessAdminPage(item.id, profile?.role, () => true)))
    .map(([group, items]) => ({ group, items: items.filter((item) => isPageEnabled(item.id as AdminPage) && (!item.area || isFieldOpsAreaEnabled(item.area))) }));
  const activeWorkspace = visibleWorkspaces.find((workspace) => workspace.items.some((item) => item.id === activePage))
    ?? visibleWorkspaces.find((workspace) => workspace.items.length > 0);
  const openWorkspaceItem = (item: WorkspaceItem) => {
    if (item.area) navigateToFieldOps(item.area);
    else navigateToPage(item.id, workflowContext);
  };
  const isWorkspaceItemActive = (item: WorkspaceItem) => item.id === activePage
    && (item.id !== 'field-ops' || (item.area ?? 'landing') === fieldOpsSubArea);

  const moduleAccessNotice = useMemo(() => {
    if (modulesStatus === 'configured') return null;
    return getModuleAccessMessage(modulesStatus, false, { moduleLabel: 'Module' });
  }, [modulesStatus]);

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
    if (destination.kind === 'admin_crm_account') {
      // /admin/crm?account=<id> opens that Client Portfolio
      setActivePage('crm');
      setMobileMenuOpen(false);
      navigate(destination.accountId ? `/admin/crm?account=${encodeURIComponent(destination.accountId)}` : '/admin/crm');
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
    accountId: workflowContext.accountId,
    agreementId: workflowContext.agreementId,
    ledgerId: workflowContext.ledgerId,
    locationId: workflowContext.locationId,
    siteId: workflowContext.siteId,
    zoneId: workflowContext.zoneId,
    workUnitId: workflowContext.workUnitId,
    handoffId: workflowContext.handoffId,
    agreement: selectedAgreement,
    site: selectedSite,
    zone: selectedZone,
    agreements: agreements.slice(0, 10),
    sites: sites.slice(0, 10),
    zones: zones.slice(0, 10),
  }), [activePage, crmTab, rosterTab, fieldOpsSubArea, reportsTab, orgName, profile?.role, workflowContext, selectedAgreement, selectedSite, selectedZone, agreements, sites, zones]);

  const renderPage = useCallback(() => {
    switch (activePage) {
      case 'hub':
        return <AdminHubPage onNavigate={navigateFromHub} />;
      case 'bob':
        return <BobWorkspacePage />;
      case 'document-studio':
        return <BobDocumentStudioPage />;
      case 'files':
        return <FileSystemPage />;
      case 'relationships':
        return <RelationshipWorkspacePage onNavigate={(destination, context) => navigateToPage(destination as AdminPage, context)} />;
      case 'onboarding':
        return <AccountOnboardingPage onNavigate={(destination, context) => navigateToPage(destination as AdminPage, context)} />;
      case 'handoffs':
        return <ActivationHandoffsPage onNavigate={(destination, context) => navigateToPage(destination as AdminPage, context)} />;
      case 'crm':
        return <CRMPage onNavigate={(destination, context) => navigateToPage(destination as AdminPage, context)} />;
      case 'client-setup':
        return <ClientSetupPage onNavigate={(destination, context) => navigateToPage(destination as AdminPage, context)} />;
      case 'reports':
        return <ReportsHubPage />;
      case 'investigations':
        return <InvestigationPage />;
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
          case 'observation-search':
            return <ObservationSearchPage />;
          case 'field-reports':
            return <FieldReportsPage />;
          case 'cctv-console':
            return <CCTVConsolePage />;
          case 'cctv-triage':
            return <CCTVTriagePage />;
          case 'cctv-review':
            return <CCTVReviewPage />;
          case 'cctv-library':
            return <CCTVVideoLibraryPage />;
          case 'cctv-import':
            return <CCTVImportPage />;
          case 'debrief-followup':
            return <DebriefFollowupPage />;
          case 'parking':
            return <ParkingOversightPage />;
          case 'noise-control':
            return <NoiseControlOversightPage />;
          case 'biosecurity':
            return <BiosecurityOversightPage />;
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
      case 'module-subscriptions':
        return <ModuleSubscriptionsPage />;
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
      case 'platform-subscribers':
        return <PlatformSubscribersPage />;
      case 'approvals':
        return <ApprovalsActivityPage />;
      case 'roster':
        return <RosterOperationsPage />;
      case 'rate-rules':
        return <RateRulesPage />;
      case 'workshop':
        return <WorkshopPage onNavigate={(destination) => navigateToPage(destination as AdminPage)} />;
      case 'finance-bureau':
        return <FinanceBureauPage onOpenBob={(prompt) => { setBobLaunchPrompt(prompt); setBobOpen(true); }} onNavigate={navigateFinance} />;
      case 'finance-connections':
        return <FinanceConnectionsPage onBack={() => navigateFinance('finance-bureau')} />;
      case 'finance-money':
        return <FinanceMoneyPage onBack={() => navigateFinance('finance-bureau')} />;
      case 'finance-costing':
        return <FinanceCostingPage onBack={() => navigateFinance('finance-bureau')} />;
      case 'finance-pricing':
        return <FinanceBureauPage view="pricing" onOpenBob={(prompt) => { setBobLaunchPrompt(prompt); setBobOpen(true); }} onNavigate={navigateFinance} />;
      case 'people-hr':
        return <RosterHRPage />;
      case 'roster-targets':
        return <RosterTargetsPage />;
      default:
        return <AdminHubPage />;
    }
  }, [activePage, fieldOpsSubArea, navigateFinance, navigateFromHub, navigateToFieldOps, setBobOpen]);

  // A popped-out CCTV wall is a second-monitor surface: the console alone, no navigation or banners.
  const isVideoWall = activePage === 'field-ops' && fieldOpsSubArea === 'cctv-console' && new URLSearchParams(location.search).get('popout') === '1';
  if (isVideoWall) {
    return (
      <div className="admin-shell admin-shell-video-wall">
        <main data-app-content className="admin-shell-main is-video-wall">
          <LazyPageRecovery key={`${activePage}:${fieldOpsSubArea}`} pageKey={`${activePage}:${fieldOpsSubArea}`}>
            <React.Suspense fallback={<LazyPageFallback />}>{renderPage()}</React.Suspense>
          </LazyPageRecovery>
        </main>
      </div>
    );
  }

  if (!isMobile) {
    return (
      <div className="admin-shell admin-shell-desktop" data-theme="light">
        <aside className={`admin-sidebar ${sidebarCollapsed ? 'is-collapsed' : ''}`}>
          <div className="admin-sidebar-brand">
            <img
              src="https://dotczcyyzgabmtmnglqj.supabase.co/storage/v1/object/public/Logo/IES%20Logo.jpg"
              alt="Iron Eagle Security"
              className="admin-brand-logo"
            />
            {!sidebarCollapsed && <div><strong>FCM</strong><small>Administration</small></div>}
            <button type="button" onClick={() => setSidebarCollapsed(!sidebarCollapsed)} title={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'} aria-label={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'} aria-expanded={!sidebarCollapsed}>
              {sidebarCollapsed ? <ChevronRight size={17} aria-hidden="true" /> : <ChevronLeft size={17} aria-hidden="true" />}
            </button>
          </div>

          <nav className="admin-workspace-selector" aria-label="Admin workspaces">
            {!sidebarCollapsed && <div className="admin-nav-group-label">Workspaces</div>}
            {visibleWorkspaces.map((workspace) => {
              const section = WORKSPACE_LABELS[workspace.group];
              return (
                <NavItem
                  key={workspace.group}
                  id={workspace.group}
                  label={section.label}
                  icon={section.icon}
                  active={activeWorkspace?.group === workspace.group}
                  disabled={workspace.items.length === 0}
                  onClick={() => { if (workspace.items[0]) openWorkspaceItem(workspace.items[0]); }}
                />
              );
            })}
          </nav>
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
              {operatingOrganizations.length > 0 && <label className="admin-operating-selector"><span>Working in</span><select value={operatingOrganizationId ?? ''} onChange={(event) => setOperatingOrganization(event.target.value)} aria-label="Working in">{operatingOrganizations.map((context) => <option value={context.organizationId} key={context.organizationId}>{context.organizationName}{context.authorityBasis === 'organisation_home' ? ' (organisation)' : context.authorityBasis === 'corporate_oversight' ? ' (branch)' : ''}</option>)}</select></label>}
              <NotificationCenter onNavigate={navigateFromNotification} />
              <HelpInstructions context={activePage} role={profile?.role} />
              <button type="button" className="admin-shell-icon admin-desktop-download" onClick={() => setShowDesktopDownload(true)} title="Download FCM desktop app" aria-label="Download FCM desktop app"><Download size={19} aria-hidden="true" /></button>
              {isFieldOpsAreaEnabled('vehicle-search') && <button type="button" className="admin-top-search" onClick={() => navigateToFieldOps('vehicle-search')} aria-label="Open vehicle search">
                <Search size={17} aria-hidden="true" /><span>Vehicle search</span>
              </button>}
              <button type="button" className="admin-shell-icon" onClick={() => navigateToPage('bob')} title="Open Bob command center" aria-label="Open Bob command center" aria-expanded={bobOpen}>
                <Bot size={19} aria-hidden="true" /><span className="sr-only">{bobOpen ? 'Bob assistant is open' : 'Open Bob assistant'}</span>
              </button>
              <button type="button" className="admin-shell-icon" onClick={() => void signOut()} title="Sign out" aria-label="Sign out"><LogOut size={19} aria-hidden="true" /></button>
              <div className="admin-profile-chip">{profile?.displayName ?? profile?.role ?? 'Administrator'}</div>
            </div>
          </header>

          {activeWorkspace && <div className="admin-workspace-bar">
            <span className="admin-workspace-title">{WORKSPACE_LABELS[activeWorkspace.group].label}</span>
            <nav aria-label="Workspace sections">
              {activeWorkspace.items.map((item) => <button type="button" key={`${item.id}:${item.area ?? ''}`} aria-current={isWorkspaceItemActive(item) ? 'page' : undefined} onClick={() => openWorkspaceItem(item)}>{item.label}</button>)}
            </nav>
          </div>}
          <main data-app-content className={`admin-shell-main ${activePage === 'hub' ? 'is-overview' : ''}`}>
            {showPlaceContext && <PlaceContextBanner />}
            {accessNotice && <div role="alert" className="admin-access-notice">{accessNotice}</div>}
            {moduleAccessNotice && <div role="status" className="admin-access-notice"><strong>{moduleAccessNotice.title}</strong><span>{moduleAccessNotice.description}</span></div>}
            <WorkflowRail activePage={activePage} context={workflowContext} onNavigate={(destination, context) => navigateToPage(destination as AdminPage, context)} />
            <LazyPageRecovery key={`${activePage}:${fieldOpsSubArea}`} pageKey={`${activePage}:${fieldOpsSubArea}`}>
              <React.Suspense fallback={<LazyPageFallback />}>{renderPage()}</React.Suspense>
            </LazyPageRecovery>
          </main>
        </div>

        <BobPanel
          open={bobOpen}
          onClose={() => setBobOpen(false)}
          context={bobContext}
          launchPrompt={bobLaunchPrompt}
        />
        {showDesktopDownload && <div className="desktop-download-overlay" role="presentation"><section className="desktop-download-prompt" role="dialog" aria-modal="true" aria-labelledby="desktop-download-title"><Download size={24} aria-hidden="true" /><div><span>FCM Desktop</span><h2 id="desktop-download-title">Download the evidence workstation</h2><p>FCM Desktop reads Dahua camera cards directly, lets you review photos and videos on your own computer, and sends only what you choose. Its installer is signed and its SHA-256 is published beside it.</p></div><div className="desktop-download-options"><a href={DESKTOP_V2_DOWNLOAD_URL} download={DESKTOP_V2_FILENAME} onClick={dismissDesktopDownload}><span><strong>FCM Desktop · v{DESKTOP_V2_VERSION}</strong><small>Reads Dahua hidden DHFS partitions straight from the card · preview here, then send or skip each photo or video · asks for administrator rights once at start · signed by Iron Eagle Security Ltd with our own certificate; SmartScreen may still warn until that certificate is trusted on your machine</small></span><Download size={16} aria-hidden="true" /></a></div><div className="desktop-download-actions"><button type="button" onClick={dismissDesktopDownload}>Not now</button></div></section></div>}

      </div>
    );
  }

  return (
    <div className="admin-shell admin-shell-mobile" data-theme="light">
      <header className="admin-mobile-header">
        <div className="admin-mobile-brand">
          <img
            src="https://dotczcyyzgabmtmnglqj.supabase.co/storage/v1/object/public/Logo/IES%20Logo.jpg"
            alt="Iron Eagle Security"
            className="admin-brand-logo"
          />
          <strong>{orgName || 'Field Compliance Manager'}</strong>
        </div>
        <div className="admin-shell-tools">
          {operatingOrganizations.length > 0 && <label className="admin-operating-selector"><span>Working in</span><select value={operatingOrganizationId ?? ''} onChange={(event) => setOperatingOrganization(event.target.value)} aria-label="Working in">{operatingOrganizations.map((context) => <option value={context.organizationId} key={context.organizationId}>{context.organizationName}{context.authorityBasis === 'organisation_home' ? ' (organisation)' : context.authorityBasis === 'corporate_oversight' ? ' (branch)' : ''}</option>)}</select></label>}
          <NotificationCenter onNavigate={navigateFromNotification} />
          <HelpInstructions context={activePage} role={profile?.role} />
          <button type="button" className="admin-shell-icon" onClick={() => navigateToPage('bob')} title="Open Bob command center" aria-label="Open Bob command center" aria-expanded={bobOpen}>
            <Bot size={19} aria-hidden="true" /><span className="sr-only">{bobOpen ? 'Bob assistant is open' : 'Open Bob assistant'}</span>
          </button>
          <button type="button" className="admin-shell-icon" onClick={() => void signOut()} title="Sign out" aria-label="Sign out"><LogOut size={19} aria-hidden="true" /></button>
          <button type="button" className="admin-shell-icon" onClick={() => setMobileMenuOpen(!mobileMenuOpen)} title={mobileMenuOpen ? 'Close navigation' : 'Open navigation'} aria-label={mobileMenuOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={mobileMenuOpen}>
            {mobileMenuOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
            <span className="sr-only">{mobileMenuOpen ? 'Close navigation' : 'Open navigation'}</span>
          </button>
        </div>
      </header>

      {mobileMenuOpen && (
        <div className="admin-mobile-overlay" onClick={() => setMobileMenuOpen(false)}>
          <nav className="admin-mobile-drawer" onClick={(e) => e.stopPropagation()}>
            {Object.entries(NAVIGATION_MAP).filter(([group]) => (group !== 'System' && group !== 'Platform') || isPageEnabled('platform')).map(([group, items]) => (
              <div key={group} className="admin-mobile-nav-group">
                <div>{group}</div>
                {items.filter((item) => isPageEnabled(item.id as AdminPage) && (!item.area || isFieldOpsAreaEnabled(item.area))).map((item) => {
                  const Icon = item.icon;
                  return (
                    <button key={`${item.id}:${item.area ?? ''}`} onClick={() => openWorkspaceItem(item)} className={`admin-mobile-nav-item ${isWorkspaceItemActive(item) ? 'is-active' : ''}`} aria-current={isWorkspaceItemActive(item) ? 'page' : undefined}>
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
        {showPlaceContext && <PlaceContextBanner />}
        {accessNotice && <div role="alert" className="admin-access-notice">{accessNotice}</div>}
        {moduleAccessNotice && <div role="status" className="admin-access-notice"><strong>{moduleAccessNotice.title}</strong><span>{moduleAccessNotice.description}</span></div>}
        <OperatingSpineRibbon organizationName={orgName || 'Your organisation'} agreementName={selectedAgreement?.name ?? null} placeName={selectedZone?.name ?? selectedSite?.name ?? null} activePage={activePage} onNavigate={(page) => navigateToPage(page as AdminPage)} />
        <WorkflowRail activePage={activePage} context={workflowContext} onNavigate={(destination, context) => navigateToPage(destination as AdminPage, context)} />
        <LazyPageRecovery key={`${activePage}:${fieldOpsSubArea}`} pageKey={`${activePage}:${fieldOpsSubArea}`}>
          <React.Suspense fallback={<LazyPageFallback />}>{renderPage()}</React.Suspense>
        </LazyPageRecovery>
      </main>

      <nav className="admin-mobile-tabs" aria-label="Admin navigation">
        {[
          { id: 'hub', label: 'Home', icon: Grid3X3 },
          { id: 'field-ops', label: 'Field Ops', icon: Radio },
          { id: 'roster', label: 'Roster', icon: Users },
          { id: 'crm', label: 'CRM', icon: DollarSign },
          { id: 'reports', label: 'Reports', icon: FileBarChart },
        ].filter((tab) => isPageEnabled(tab.id as AdminPage)).map((tab) => {
          const Icon = tab.icon;
          return (
            <button key={tab.id} onClick={() => navigateToPage(tab.id as AdminPage)} className={activePage === tab.id ? 'is-active' : ''} aria-current={activePage === tab.id ? 'page' : undefined}>
              <Icon size={19} aria-hidden="true" /><span>{tab.label}</span>
            </button>
          );
        })}
      </nav>

      <BobPanel
        open={bobOpen}
        onClose={() => setBobOpen(false)}
        context={bobContext}
        launchPrompt={bobLaunchPrompt}
      />

    </div>
  );
};

export default AdminShell;
