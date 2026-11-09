/**
 * OfficerShell.tsx
 * Field officer portal shell with four entry states and persistent safety chrome
 *
 * Source of Truth: docs/PRODUCT_DESIGN.md §3.1, §4
 *
 * Four States:
 * 1. WELFARE_STANDBY: No shift, no direct access; SOS/welfare check-in always available
 * 2. OFFICER_HOME: Has active/upcoming shift (roster-first landing)
 * 3. MODULE_SELECTOR: Admin granted multiple direct modules (standalone access)
 * 4. MODULE_PORTAL: Inside a specific module
 *
 * Architecture:
 * - Persistent FCM chrome: safety header and field action bar
 * - Four-state machine for navigation
 * - One unified welfare, SOS, and GPS-evidence state model
 * - Module gating based on profile + org enablement
 * - Responsive mobile-first design
 */

import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { OfficerAppInstall } from '../components/OfficerAppInstall';
import {
  Activity,
  BadgeCheck,
  Bot,
  Building2,
  CalendarDays,
  Car,
  ClipboardList,
  Clock3,
  FilePlus2,
  FileText,
  Grid3X3,
  Home,
  KeyRound,
  LogOut,
  MoreHorizontal,
  Map,
  MapPin,
  MessageSquare,
  Moon,
  Radio,
  Route,
  Siren,
  UserRound,
  Wrench,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useActiveShift } from '../hooks/useActiveShift';
import { useOfficerSafety } from '../hooks/useOfficerSafety';
import { useEnabledModules } from '../hooks/useEnabledModules';
import { canUseModule, officerRouteModuleKey } from '../lib/moduleAccess';
import { isAdminTierRole } from '../lib/roles';
import { serviceTypeLabel } from '../lib/officerServiceLabels';
import { supabase } from '../lib/supabase';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { OfficerUnsavedWorkContext } from '../context/OfficerUnsavedWorkContext';
import { BobPanel } from '../components/BobPanel';
import { NotificationCenter, type NotificationRecord } from '../components/NotificationCenter';
import { HelpInstructions } from '../components/HelpInstructions';
import { ChangeRequestButton } from '../components/ChangeRequestButton';
import { OfficerLocationAdvisory } from '../components/OfficerLocationAdvisory';
import { OfficerLocationPill } from '../components/OfficerLocationPill';
import { OfficerSafetyBriefingBanner } from '../components/ShiftSafetyBriefing';
import { OfficerJobAlertBanner } from '../components/OfficerJobAlertBanner';
import { useNewDispatchJobAlerts } from '../hooks/useNewDispatchJobAlerts';
import { unlockAudioOnFirstGesture } from '../lib/officerJobAlerts';
import { resolveNotificationDestination } from '../lib/notificationNavigation';
import { SPECIALTY_MODULES } from '../config/specialtyModules';
import {
  buildOfficerBreadcrumb,
  captureOfficerBreadcrumb,
  canRecordOfficerBreadcrumbs,
  flushOfficerBreadcrumbs,
  isBreadcrumbDue,
} from '../lib/officerBreadcrumb';
import { resolveAddressForCoordinates } from '../lib/locationAddress';
import './OfficerShell.css';
import './OfficerUsability.css';

const PatrolPage = React.lazy(() => import('../pages/PatrolPage'));
const SmokeControlPage = React.lazy(() => import('../pages/modules/SmokeControlPage'));
const OfficerFieldReportPage = React.lazy(() => import('../pages/OfficerFieldReportPage'));
const OfficerLeavePage = React.lazy(() => import('../pages/OfficerLeavePage'));
const OfficerTimesheetPage = React.lazy(() => import('../pages/OfficerTimesheetPage'));
const OfficerCredentialsPage = React.lazy(() => import('../pages/OfficerCredentialsPage'));
const OfficerVehicleLookupPage = React.lazy(() => import('../pages/OfficerVehicleLookupPage'));
const OfficerPersonSearchPage = React.lazy(() => import('../pages/OfficerPersonSearchPage'));
const OfficerWorkshopPage = React.lazy(() => import('../pages/OfficerWorkshopPage'));
const OfficerNoiseControlPage = React.lazy(() => import('../pages/OfficerNoiseControlPage'));
const OfficerParkingPage = React.lazy(() => import('../pages/OfficerParkingPage'));
const OfficerDispatchPage = React.lazy(() => import('../pages/OfficerDispatchPage'));
const OfficerBiosecurityPage = React.lazy(() => import('../pages/OfficerBiosecurityPage'));
const OfficerFreedomCampingPage = React.lazy(() => import('../pages/OfficerFreedomCampingPage'));
const OfficerOvernightVerificationPage = React.lazy(() => import('../pages/OfficerOvernightVerificationPage'));
const ComingSoonPage = React.lazy(() => import('../pages/ComingSoonPage'));
const OfficerMapPage = React.lazy(() => import('../pages/OfficerMapPage'));
const OfficerPlacesPage = React.lazy(() => import('../pages/OfficerPlacesPage'));
const OfficerHomePage = React.lazy(() => import('../pages/OfficerHomePage').then((module) => ({ default: module.OfficerHomePage })));
const OfficerSchedulePage = React.lazy(() => import('../pages/OfficerSchedulePage'));
const OfficerDebriefPage = React.lazy(() => import('../pages/OfficerDebriefPage'));
const OfficerStaticGuardPage = React.lazy(() => import('../pages/OfficerStaticGuardPage'));
const OfficerAccessControlPage = React.lazy(() => import('../pages/OfficerAccessControlPage'));
const BobWorkspacePage = React.lazy(() => import('../pages/BobWorkspacePage'));

type ActiveModule =
  | 'freedom_camping' | 'parking' | 'noise_control' | 'biosecurity' | 'smoke_control'
  | 'site_guard' | 'access_control' | 'ems' | 'patrol' | 'report' | 'leave' | 'timesheet' | 'schedule'
  | 'overnight_verification' | 'checkpoint_scan' | 'map' | 'places' | 'dispatch' | 'debrief'
  | 'vehicle_lookup' | 'person_search' | 'credentials' | 'bob' | 'modules' | 'workshop' | null;

type WelfareStatus = 'ok' | 'due' | 'overdue' | 'man_down' | 'sos';

type OfficerState = 'standby' | 'home' | 'selector' | 'portal';

// Module metadata
const SPECIALTY_METADATA = Object.fromEntries(SPECIALTY_MODULES.flatMap((module) => [
  [module.key, { label: module.label, description: module.description, icon: module.icon }],
  [module.integratedKey, { label: module.label, description: module.description, icon: module.icon }],
])) as Record<string, { label: string; description: string; icon: LucideIcon }>;

const MODULE_METADATA: Record<string, { label: string; description: string; icon: LucideIcon }> = {
  ...SPECIALTY_METADATA,
  ems: { label: 'EMS', description: 'Emergency response reporting', icon: Activity },
  patrol: { label: 'Patrol', description: 'Routes, stops, and checkpoints', icon: Route },
  report: { label: 'Reports', description: 'Submit a field report', icon: FileText },
  leave: { label: 'Leave', description: 'Request and review leave', icon: CalendarDays },
  timesheet: { label: 'Timesheet', description: 'Record worked time', icon: Clock3 },
  schedule: { label: 'Schedule', description: 'View shifts and coverage', icon: ClipboardList },
  overnight_verification: { label: 'Overnight', description: 'Verify overnight activity', icon: Moon },
  checkpoint_scan: { label: 'Checkpoints', description: 'Scan assigned checkpoints', icon: MapPin },
  map: { label: 'Map', description: 'View operational places', icon: Map },
  places: { label: 'Places', description: 'Add or verify a location with GPS', icon: MapPin },
  dispatch: { label: 'Dispatch', description: 'Live jobs and response', icon: Radio },
  debrief: { label: 'Debrief', description: 'Close the shift and follow up', icon: MessageSquare },
  vehicle_lookup: { label: 'Vehicle', description: 'Search vehicle history', icon: Car },
  person_search: { label: 'Person search', description: 'Authorized notice and permit checks', icon: UserRound },
  credentials: { label: 'Credentials', description: 'View capability and expiry', icon: BadgeCheck },
  workshop: { label: 'Workshop', description: 'Your builds and maintenance visits', icon: Wrench },
};

const CORE_OFFICER_MODULES: ReadonlySet<string> = new Set(['report', 'leave', 'timesheet', 'schedule', 'dispatch', 'debrief', 'vehicle_lookup', 'person_search', 'credentials', 'map', 'places', 'bob']);

const WELFARE_STATUS_DISPLAY: Record<WelfareStatus, { bg: string; dot: string; color: string }> = {
  ok: { bg: '#1A1A1A', dot: 'OK', color: '#4CAF50' },
  due: { bg: '#1A1200', dot: 'DUE', color: '#FF9800' },
  overdue: { bg: '#1A0000', dot: 'OVR', color: '#EF5350' },
  man_down: { bg: '#3A0000', dot: '!!', color: '#FF1744' },
  sos: { bg: '#3A0000', dot: 'SOS', color: '#FF1744' },
};

const LazyPageFallback: React.FC = () => (
  <div className="officer-module-loading">
    <div>Loading module...</div>
  </div>
);

const OfficerShell: React.FC<{ onSwitchPortal?: () => void }> = ({ onSwitchPortal }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { profile, signOut, updatePassword } = useAuth();
  const { shift: activeShift, isLoading: shiftLoading, error: shiftError, refetch: refreshShift } = useActiveShift(profile?.id ?? '', profile?.organizationId ?? '');
  const { status: moduleStatus, isModuleEnabled } = useEnabledModules(profile?.organizationId ?? null);
  const { selectedAgreement, selectedSite, selectedZone, setLocationMode, setActiveShiftLocationContext } = useServiceRelationships();
  const [activeModule, setActiveModule] = useState<ActiveModule>(null);

  const getGps = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return null;
    return new Promise<{ lat: number; lng: number } | null>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: true, maximumAge: 30_000, timeout: 8_000 },
      );
    });
  }, []);

  const safety = useOfficerSafety({
    officerId: profile?.id ?? null,
    organizationId: profile?.organizationId ?? null,
    orgManDownEnabled: isModuleEnabled('welfare', { safetyRelevant: true }),
    getGps,
  });

  const [officerState, setOfficerState] = useState<OfficerState>('home');
  const [offeredCount, setOfferedCount] = useState(0);
  const [bobOpen, setBobOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [moreToolsOpen, setMoreToolsOpen] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [accountMessage, setAccountMessage] = useState<string | null>(null);
  const [savingPassword, setSavingPassword] = useState(false);
  const [breadcrumbIssue, setBreadcrumbIssue] = useState<{ pendingCount: number; error: string } | null>(null);
  const [isOnline, setIsOnline] = useState(() => typeof navigator === 'undefined' ? true : navigator.onLine);
  const lastBreadcrumbAtRef = useRef<number | null>(null);
  const contentRef = useRef<HTMLElement | null>(null);
  const moreToolsRef = useRef<HTMLDivElement | null>(null);
  const moreToolsButtonRef = useRef<HTMLButtonElement | null>(null);
  const unsavedWork = useRef(new Set<symbol>());
  const registerUnsavedWork = useCallback((id: symbol, dirty: boolean) => {
    if (dirty) unsavedWork.current.add(id);
    else unsavedWork.current.delete(id);
  }, []);
  const confirmNavigation = useCallback(() => unsavedWork.current.size === 0
    || window.confirm('You have unsubmitted field work. Leave and lose the unsaved entries?'), []);

  useEffect(() => { setLocationMode('gps'); }, [setLocationMode]);
  useEffect(() => {
    setActiveShiftLocationContext(activeShift ? {
      organizationId: activeShift.organization_id,
      moduleKey: activeShift.service_agreement_module_key ?? null,
      locationId: activeShift.location_id ?? null,
      serviceAgreementLocationId: activeShift.service_agreement_location_id ?? null,
      siteIds: [...new Set([
        ...(activeShift.stops.map((stop) => stop.client_site_id).filter(Boolean) as string[]),
        ...(activeShift.location_id ? selectedSite?.location_id === activeShift.location_id ? [selectedSite.id] : [] : []),
      ])],
      zoneIds: [...new Set([
        ...(activeShift.zone_id ? [activeShift.zone_id] : []),
        ...activeShift.stops.map((stop) => stop.zone_id).filter(Boolean) as string[],
      ])],
    } : null);
  }, [activeShift, selectedSite?.id, selectedSite?.location_id, setActiveShiftLocationContext]);
  useEffect(() => { if (contentRef.current) contentRef.current.scrollTop = 0; setMoreToolsOpen(false); }, [location.pathname]);
  useEffect(() => {
    if (!moreToolsOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!moreToolsRef.current?.contains(event.target as Node)) setMoreToolsOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [moreToolsOpen]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (unsavedWork.current.size) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => { window.removeEventListener('online', handleOnline); window.removeEventListener('offline', handleOffline); };
  }, []);

  const canAccessOfficerModule = useCallback((module: ActiveModule): boolean => {
    if (!module) return true;
    if (module === 'modules') return true;
    if (CORE_OFFICER_MODULES.has(module)) return true;
    return canUseModule({ moduleKey: module, role: profile?.role, moduleAccess: profile?.moduleAccess, isModuleEnabled });
  }, [isModuleEnabled, profile?.moduleAccess, profile?.role]);

  // Directory: admin-tier roles see every organisation-enabled field module; everyone else sees their ticked modules.
  const grantedModules = useMemo(() => {
    const candidates = isAdminTierRole(profile?.role) ? Object.keys(MODULE_METADATA) : (profile?.moduleAccess ?? []);
    return Array.from(new Set(candidates.map(officerRouteModuleKey))).filter((module) => MODULE_METADATA[module]
      && (CORE_OFFICER_MODULES.has(module) || canUseModule({ moduleKey: module, role: profile?.role, moduleAccess: profile?.moduleAccess, isModuleEnabled })));
  }, [isModuleEnabled, profile?.moduleAccess, profile?.role]);

  // Derive active module from URL
  const moduleFromUrl = useCallback((pathname: string): ActiveModule => {
    const segments = pathname.split('/').filter(Boolean);
    if (segments[0] === 'officer' && segments[1]) {
      return segments[1] as ActiveModule || null;
    }
    return null;
  }, []);

  // Determine current state machine state
  useEffect(() => {
    const module = moduleFromUrl(location.pathname);
    if (module && moduleStatus === 'loading') return;
    if (module && !canAccessOfficerModule(module)) {
      navigate('/officer', { replace: true });
      setActiveModule(null);
      return;
    }
    setActiveModule(module);

    if (module === 'modules') {
      setOfficerState('selector');
    } else if (module) {
      setOfficerState('portal');
    } else if (activeShift) {
      setOfficerState('home');
    } else {
      setOfficerState('standby');
    }
  }, [location.pathname, activeShift, grantedModules, moduleStatus, canAccessOfficerModule, moduleFromUrl, navigate]);

  useEffect(() => {
    if (!profile?.id || typeof navigator === 'undefined' || !navigator.geolocation) return;
    const ownerUserId = profile.id;
    const recordsBreadcrumbs = canRecordOfficerBreadcrumbs(profile.role);
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        safety.recordMovement(position.coords.latitude, position.coords.longitude);
        if (!recordsBreadcrumbs) return;
        const capturedAt = Date.now();
        if (!isBreadcrumbDue(lastBreadcrumbAtRef.current, capturedAt)) return;
        lastBreadcrumbAtRef.current = capturedAt;
        void resolveAddressForCoordinates(position.coords.latitude, position.coords.longitude)
          .catch(() => null)
          .then((address) => captureOfficerBreadcrumb(buildOfficerBreadcrumb(position, activeShift?.id, address?.label ?? null), ownerUserId))
          .then((result) => {
            setBreadcrumbIssue(result.confirmed ? null : { pendingCount: result.pendingCount, error: result.error });
          });
      },
      () => undefined,
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 15_000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [activeShift?.id, profile?.id, profile?.role, safety.recordMovement]);

  useEffect(() => {
    if (!profile?.id || typeof window === 'undefined' || !canRecordOfficerBreadcrumbs(profile.role)) return;
    const ownerUserId = profile.id;
    let active = true;
    const flush = () => {
      void flushOfficerBreadcrumbs(ownerUserId).then((result) => {
        if (!active) return;
        setBreadcrumbIssue(result.confirmed ? null : { pendingCount: result.pendingCount, error: result.error });
      });
    };
    flush();
    window.addEventListener('online', flush);
    return () => {
      active = false;
      window.removeEventListener('online', flush);
    };
  }, [profile?.id, profile?.role]);

  // Load offered shift count
  useEffect(() => {
    const loadOfferedCount = async () => {
      if (!profile?.id) return;

      try {
        const { count, error } = await supabase
          .from('shifts')
          .select('id', { count: 'exact', head: true })
          .eq('officer_user_id', profile.id)
          .eq('status', 'published');

        if (error) throw error;
        setOfferedCount(count || 0);
      } catch (err) {
        console.error('Failed to load offered shifts:', err);
      }
    };

    loadOfferedCount();
    const interval = setInterval(loadOfferedCount, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, [profile?.id]);

  // Navigate to module
  const navigateToModule = useCallback((module: ActiveModule, navigationConfirmed = false) => {
    const target = module === null ? '/officer' : `/officer/${module}`;
    if (target !== location.pathname && !navigationConfirmed && !confirmNavigation()) return false;
    if (module === null) {
      navigate('/officer');
      setActiveModule(null);
      return true;
    }
    if (!canAccessOfficerModule(module)) {
      navigate('/officer', { replace: true });
      setActiveModule(null);
      return true;
    }
    navigate(target);
    setActiveModule(module);
    return true;
  }, [canAccessOfficerModule, confirmNavigation, location.pathname, navigate]);

  const confirmNotificationNavigation = useCallback((notification: NotificationRecord) => {
    const destination = resolveNotificationDestination(profile?.role ?? 'unknown', notification);
    return !destination || destination.kind === 'bob' || confirmNavigation();
  }, [confirmNavigation, profile?.role]);

  const jobAlerts = useNewDispatchJobAlerts(profile?.id);
  const dismissJobAlert = jobAlerts.dismiss;
  useEffect(() => unlockAudioOnFirstGesture(), []);
  const openDispatchJob = useCallback((jobId: string) => {
    dismissJobAlert(jobId);
    if (!canAccessOfficerModule('dispatch')) return;
    if (location.pathname !== '/officer/dispatch' && !confirmNavigation()) return;
    navigate(`/officer/dispatch?job=${encodeURIComponent(jobId)}`);
    setActiveModule('dispatch');
  }, [canAccessOfficerModule, confirmNavigation, dismissJobAlert, location.pathname, navigate]);

  const navigateFromNotification = useCallback((notification: NotificationRecord) => {
    const destination = resolveNotificationDestination(profile?.role ?? 'unknown', notification);
    if (!destination) return false;
    if (destination.kind === 'bob') {
      setBobOpen(true);
      return true;
    }
    if (destination.kind === 'officer_module') {
      return navigateToModule(destination.module as ActiveModule, true);
    }
    if (destination.kind === 'officer_report') {
      const report = destination.reportId ? `?report=${encodeURIComponent(destination.reportId)}` : '';
      navigate(`/officer/report${report}`);
      setActiveModule('report');
      return true;
    }
    if (destination.kind === 'officer_leave') {
      const leave = destination.leaveRequestId ? `?leave=${encodeURIComponent(destination.leaveRequestId)}` : '';
      navigate(`/officer/leave${leave}`);
      setActiveModule('leave');
      return true;
    }
    if (destination.kind === 'officer_timesheet') {
      const timesheet = destination.timesheetId ? `?timesheet=${encodeURIComponent(destination.timesheetId)}` : '';
      navigate(`/officer/timesheet${timesheet}`);
      setActiveModule('timesheet');
      return true;
    }
    if (destination.kind === 'officer_dispatch') {
      const job = destination.dispatchJobId ? `?job=${encodeURIComponent(destination.dispatchJobId)}` : '';
      navigate(`/officer/dispatch${job}`);
      setActiveModule('dispatch');
      return true;
    }
    if (destination.kind === 'officer_schedule') {
      const slot = destination.rosterSlotId ? `?slot=${encodeURIComponent(destination.rosterSlotId)}` : '';
      navigate(`/officer/schedule${slot}`);setActiveModule('schedule');return true;
    }
    if (destination.kind === 'officer_breach') {
      const breach = destination.breachAlertId ? `?breach=${encodeURIComponent(destination.breachAlertId)}` : '';
      navigate(`/officer/freedom_camping${breach}`);setActiveModule('freedom_camping');return true;
    }
    if (destination.kind === 'officer_debrief') {
      const debrief = destination.debriefId ? `?debrief=${encodeURIComponent(destination.debriefId)}` : '';
      navigate(`/officer/debrief${debrief}`);setActiveModule('debrief');return true;
    }
    if (destination.kind === 'officer_noise') {
      const assessment = destination.assessmentId ? `?assessment=${encodeURIComponent(destination.assessmentId)}` : '';
      navigate(`/officer/noise_control${assessment}`);setActiveModule('noise_control');return true;
    }
    return false;
  }, [navigate, navigateToModule, profile?.role]);

  const savePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (newPassword.length < 8) {
      setAccountMessage('Use at least 8 characters for your new password.');
      return;
    }
    setSavingPassword(true);
    setAccountMessage(null);
    const result = await updatePassword(newPassword);
    setSavingPassword(false);
    if (result.error) {
      setAccountMessage(result.error);
      return;
    }
    setNewPassword('');
    setAccountMessage('Password updated.');
  };

  // Get welfare status
  const currentWelfareStatus: WelfareStatus = safety.activeAlert?.kind === 'sos'
    ? 'sos'
    : safety.activeAlert
      ? 'man_down'
      : safety.status === 'overdue'
        ? 'overdue'
        : safety.status === 'due'
          ? 'due'
          : 'ok';
  const welfareDisplay = WELFARE_STATUS_DISPLAY[currentWelfareStatus];
  const welfareLabel = currentWelfareStatus === 'sos' ? 'SOS active' : currentWelfareStatus === 'man_down' ? 'Urgent alert' : currentWelfareStatus === 'overdue' ? 'Check-in overdue' : currentWelfareStatus === 'due' ? 'Check-in due' : 'Safety OK';

  // Get Bob context
  const bobContext = useMemo(() => ({
    activeModule,
    officerState,
    shift: activeShift,
    welfareStatus: currentWelfareStatus,
    role: profile?.role,
    agreement: selectedAgreement,
    site: selectedSite,
    zone: selectedZone,
    moduleGateStatus: moduleStatus,
  }), [activeModule, officerState, activeShift, currentWelfareStatus, profile?.role, selectedAgreement, selectedSite, selectedZone, moduleStatus]);

  // Render module portal
  const renderModuleContent = useCallback(() => {
    switch (activeModule) {
      case 'bob': return <BobWorkspacePage returnPath="/officer" />;
      case 'schedule':
        return <OfficerSchedulePage />;
      case 'patrol':
      case 'checkpoint_scan':
        return <PatrolPage />;
      case 'smoke_control':
        return <SmokeControlPage />;
      case 'report':
        return <OfficerFieldReportPage />;
      case 'leave':
        return <OfficerLeavePage />;
      case 'timesheet':
        return <OfficerTimesheetPage />;
      case 'credentials':
        return <OfficerCredentialsPage />;
      case 'vehicle_lookup':
        return <OfficerVehicleLookupPage />;
      case 'person_search':
        return <OfficerPersonSearchPage />;
      case 'workshop':
        return <OfficerWorkshopPage />;
      case 'noise_control':
        return <OfficerNoiseControlPage />;
      case 'parking':
        return <OfficerParkingPage />;
      case 'dispatch':
        return <OfficerDispatchPage onNavigate={(destination) => navigateToModule(destination === 'home' ? null : destination)} />;
      case 'biosecurity':
        return <OfficerBiosecurityPage />;
      case 'freedom_camping':
        return <OfficerFreedomCampingPage />;
      case 'overnight_verification':
        return <OfficerOvernightVerificationPage />;
      case 'site_guard':
        return <OfficerStaticGuardPage />;
      case 'access_control':
        return <OfficerAccessControlPage />;
      case 'ems':
        return <OfficerFieldReportPage />;
      case 'debrief':
        return <OfficerDebriefPage onNavigate={(destination) => navigateToModule(destination === 'home' ? null : destination)} />;
      case 'map':
        return <OfficerMapPage />;
      case 'places':
        return <OfficerPlacesPage />;
      case 'modules':
        return (
          <section className="officer-module-directory">
            <header><span>Field tools</span><h1>Tools</h1><p>Tools available for your organisation and role.</p></header>
            {grantedModules.length === 0 ? (
              <div className="officer-module-empty">No field tools are available for your role.</div>
            ) : (
              <div className="officer-module-grid">
                {grantedModules.map((mod) => {
                  const meta = MODULE_METADATA[mod];
                  if (!meta) return null;
                  const Icon = meta.icon;
                  const standaloneModule = SPECIALTY_MODULES.find((module) => module.key === mod || module.integratedKey === mod);
                  return (
                    <article className="officer-module-card" key={mod}>
                      <button type="button" className="officer-module-card-main" onClick={() => navigateToModule(mod as ActiveModule)}>
                        <span className="officer-module-icon"><Icon size={21} /></span>
                        <span className="officer-module-card-copy"><strong>{meta.label}</strong><small>{meta.description}</small></span>
                      </button>
                      {standaloneModule && <button type="button" className="officer-module-card-standalone" onClick={() => navigate(standaloneModule.standalonePath)}>Open standalone app</button>}
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        );
      default:
        return <LazyPageFallback />;
    }
  }, [activeModule, grantedModules, navigate, navigateToModule]);

  return (
    <OfficerUnsavedWorkContext.Provider value={registerUnsavedWork}>
    <div className="officer-shell" data-theme="dark">
      <header className="officer-shell-header">
        <button type="button" className="officer-shell-brand" onClick={() => navigateToModule(null)} title="Officer home" aria-label="Field portal home">
          <img
            src="https://dotczcyyzgabmtmnglqj.supabase.co/storage/v1/object/public/Logo/IES%20Logo.jpg"
            alt="Iron Eagle Security"
            className="officer-brand-logo"
          />
          <div><strong>Field Compliance Manager</strong><small>{activeShift ? `${serviceTypeLabel(activeShift.shift_type).label} shift` : 'Officer operations'}</small></div>
        </button>

        <div className="officer-shell-tools">
          {offeredCount > 0 && <span className="officer-offer-count" title={`${offeredCount} offered shifts`}>{offeredCount}</span>}
          <button type="button" className={`officer-safety-chip welfare-${currentWelfareStatus}`} onClick={() => void safety.checkIn()} disabled={safety.writeStatus === 'pending'} title="Check in now" aria-label={`${welfareLabel}. Check in`}>
            <span>{welfareDisplay.dot}</span><small>{welfareLabel}</small>
          </button>
          <NotificationCenter onBeforeNavigate={confirmNotificationNavigation} onNavigate={navigateFromNotification} />
          <button type="button" className="officer-profile-chip" onClick={() => { setAccountOpen(true); setAccountMessage(null); }} title="Account settings" aria-label="Account settings">
            <UserRound size={17} aria-hidden="true" /><span>{profile?.displayName?.split(' ')[0] ?? 'Officer'}</span>
          </button>
          <div className="officer-secondary-container" ref={moreToolsRef} onKeyDown={(event) => {
            if (event.key === 'Escape' && moreToolsOpen) { setMoreToolsOpen(false); moreToolsButtonRef.current?.focus(); }
          }}>
            <button type="button" ref={moreToolsButtonRef} className="officer-more-tools" aria-label="More field tools" aria-expanded={moreToolsOpen} aria-controls="officer-secondary-tools" onClick={() => setMoreToolsOpen((value) => !value)}>
              <MoreHorizontal size={21} aria-hidden="true" /><span>More</span>
            </button>
            <div id="officer-secondary-tools" className={`officer-secondary-tools ${moreToolsOpen ? 'is-open' : ''}`}>
              <span className={`officer-connectivity-chip ${isOnline ? 'is-online' : 'is-offline'}`} role="status" title={isOnline ? 'Device is online' : 'Evidence is queued until connection returns'}>{isOnline ? 'Online' : 'Offline'}</span>
              <div className="officer-secondary-item"><ChangeRequestButton compact workspaceLabel="Officer operations" /><span className="officer-secondary-label">Request a change</span></div>
              <div className="officer-secondary-item"><HelpInstructions context={activeModule ?? officerState} role={profile?.role} /><span className="officer-secondary-label">Instructions</span></div>
              <div className="officer-secondary-item"><button type="button" className="officer-shell-icon" onClick={() => { setBobOpen(true); setMoreToolsOpen(false); }} title="Open Bob command center" aria-label="Open Bob command center" aria-expanded={bobOpen}>
                <Bot size={19} aria-hidden="true" /><span className="sr-only">{bobOpen ? 'Bob assistant is open' : 'Open Bob assistant'}</span>
              </button><span className="officer-secondary-label">Open Bob</span></div>
            </div>
          </div>
        </div>
      </header>

      <div className="bob-page-layout">
      <main ref={contentRef} data-app-content className="officer-shell-content">
        <OfficerLocationAdvisory shift={activeShift} />
        <OfficerSafetyBriefingBanner shift={activeShift} />
        {/* Home and Dispatch already lead with the assigned job, so the banner only interrupts other pages. */}
        <OfficerJobAlertBanner jobs={activeModule === null || activeModule === 'dispatch' ? [] : jobAlerts.jobs} onOpen={openDispatchJob} onDismiss={dismissJobAlert} />
        <OfficerLocationPill />
        {safety.writeStatus === 'error' && safety.lastError && (
          <div role="alert" className="officer-shell-safety-error">
            Safety action not confirmed: {safety.lastError}
          </div>
        )}
        {safety.resolutionOutcome && <div className="officer-shell-safety-outcome" role="status">{safety.resolutionOutcome}</div>}
        {breadcrumbIssue && (
          <div role="status" className="officer-shell-evidence-warning">
            Location evidence not confirmed. {breadcrumbIssue.pendingCount} {breadcrumbIssue.pendingCount === 1 ? 'record is' : 'records are'} queued for retry. {breadcrumbIssue.error}
          </div>
        )}
        {!isOnline && <div role="status" className="officer-shell-offline-banner">No connection — field evidence will remain queued until the device is back online.</div>}
        {(officerState === 'standby' || officerState === 'home') && (
          <React.Suspense fallback={<LazyPageFallback />}>
            <OfficerAppInstall />
            <OfficerHomePage shift={activeShift} shiftLoading={shiftLoading} shiftError={shiftError} safety={safety} onNavigate={navigateToModule} onRefreshShift={refreshShift} onOpenJob={openDispatchJob} />
          </React.Suspense>
        )}
        {(officerState === 'selector' || officerState === 'portal') && (
          <React.Suspense fallback={<LazyPageFallback />}>
            {renderModuleContent()}
          </React.Suspense>
        )}
      </main>
      <BobPanel
        open={bobOpen && activeModule !== 'bob'}
        presentation="fullscreen"
        onClose={() => setBobOpen(false)}
        context={bobContext}
      />
      </div>

      <nav className="officer-action-bar" aria-label="Field actions">
        <button type="button" onClick={() => navigateToModule(null)} className={activeModule === null ? 'is-active' : ''} aria-current={activeModule === null ? 'page' : undefined}>
          <Home size={19} aria-hidden="true" /><span>Home</span>
        </button>
        <button type="button" onClick={() => navigateToModule('schedule')} className={activeModule === 'schedule' ? 'is-active' : ''} aria-current={activeModule === 'schedule' ? 'page' : undefined}>
          <CalendarDays size={19} aria-hidden="true" /><span>Schedule</span>
        </button>
        <button type="button" onClick={() => navigateToModule('modules')} className={activeModule === 'modules' ? 'is-active' : ''} aria-current={activeModule === 'modules' ? 'page' : undefined}>
          <Grid3X3 size={19} aria-hidden="true" /><span>Tools</span>
        </button>
        <button type="button" onClick={() => navigateToModule('report')} className={activeModule === 'report' ? 'is-active' : ''} aria-current={activeModule === 'report' ? 'page' : undefined}>
          <FilePlus2 size={19} aria-hidden="true" /><span>Report</span>
        </button>
        <button type="button" className="officer-sos-action" onClick={() => void safety.triggerSOS()} disabled={safety.writeStatus === 'pending' || safety.activeAlert?.kind === 'sos'}>
          <Siren size={19} aria-hidden="true" /><span>{safety.activeAlert?.kind === 'sos' ? 'SOS active' : 'SOS'}</span>
        </button>
      </nav>

      {accountOpen && (
        <div className="officer-account-backdrop" onClick={() => setAccountOpen(false)}>
          <section className="officer-account-dialog" role="dialog" aria-modal="true" aria-labelledby="officer-account-title" onClick={(event) => event.stopPropagation()}>
            <header><div><span>Account</span><h2 id="officer-account-title">{profile?.displayName ?? 'Officer'}</h2><p>{profile?.email ?? profile?.role ?? 'Officer account'}</p></div><button type="button" onClick={() => setAccountOpen(false)} aria-label="Close account settings"><X size={18} /></button></header>
            <div className="officer-account-role">{profile?.role?.replaceAll('_', ' ') ?? 'Officer'}</div>
            {onSwitchPortal && <button type="button" className="officer-account-switch" onClick={() => { if (confirmNavigation()) onSwitchPortal(); }}><Building2 size={17} aria-hidden="true" />Switch to admin portal</button>}
            <form onSubmit={(event) => void savePassword(event)}><label><span>New password</span><input type="password" autoComplete="new-password" minLength={8} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="At least 8 characters" /></label><button type="submit" disabled={savingPassword || newPassword.length < 8}><KeyRound size={16} />{savingPassword ? 'Updating password' : 'Update password'}</button></form>
            {accountMessage && <p className="officer-account-message" role="status">{accountMessage}</p>}
            <button type="button" className="officer-account-signout" onClick={() => { if (confirmNavigation()) void signOut(); }}><LogOut size={16} />Sign out</button>
          </section>
        </div>
      )}
    </div>
    </OfficerUnsavedWorkContext.Provider>
  );
};

export default OfficerShell;
