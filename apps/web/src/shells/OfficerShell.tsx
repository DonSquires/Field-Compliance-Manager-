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
import {
  Activity,
  BadgeCheck,
  Bot,
  CalendarDays,
  Car,
  ClipboardList,
  Clock3,
  FilePlus2,
  FileText,
  Grid3X3,
  KeyRound,
  LogOut,
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
import { useActiveModuleContext } from '../hooks/useActiveModuleContext';
import { supabase } from '../lib/supabase';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { BobPanel } from '../components/BobPanel';
import { NotificationCenter, type NotificationRecord } from '../components/NotificationCenter';
import { HelpInstructions } from '../components/HelpInstructions';
import { OfficerLocationAdvisory } from '../components/OfficerLocationAdvisory';
import { PlaceContextBanner } from '../components/PlaceContextBanner';
import { resolveNotificationDestination } from '../lib/notificationNavigation';
import { SPECIALTY_MODULES } from '../config/specialtyModules';
import {
  buildOfficerBreadcrumb,
  captureOfficerBreadcrumb,
  flushOfficerBreadcrumbs,
  isBreadcrumbDue,
} from '../lib/officerBreadcrumb';
import { resolveAddressForCoordinates } from '../lib/locationAddress';
import './OfficerShell.css';

const PatrolPage = React.lazy(() => import('../pages/PatrolPage'));
const SmokeControlPage = React.lazy(() => import('../pages/modules/SmokeControlPage'));
const OfficerFieldReportPage = React.lazy(() => import('../pages/OfficerFieldReportPage'));
const OfficerLeavePage = React.lazy(() => import('../pages/OfficerLeavePage'));
const OfficerTimesheetPage = React.lazy(() => import('../pages/OfficerTimesheetPage'));
const OfficerCredentialsPage = React.lazy(() => import('../pages/OfficerCredentialsPage'));
const OfficerVehicleLookupPage = React.lazy(() => import('../pages/OfficerVehicleLookupPage'));
const OfficerWorkshopPage = React.lazy(() => import('../pages/OfficerWorkshopPage'));
const OfficerNoiseControlPage = React.lazy(() => import('../pages/OfficerNoiseControlPage'));
const OfficerParkingPage = React.lazy(() => import('../pages/OfficerParkingPage'));
const OfficerDispatchPage = React.lazy(() => import('../pages/OfficerDispatchPage'));
const OfficerBiosecurityPage = React.lazy(() => import('../pages/OfficerBiosecurityPage'));
const OfficerFreedomCampingPage = React.lazy(() => import('../pages/OfficerFreedomCampingPage'));
const OfficerOvernightVerificationPage = React.lazy(() => import('../pages/OfficerOvernightVerificationPage'));
const ComingSoonPage = React.lazy(() => import('../pages/ComingSoonPage'));
const OfficerMapPage = React.lazy(() => import('../pages/OfficerMapPage'));
const OfficerHomePage = React.lazy(() => import('../pages/OfficerHomePage').then((module) => ({ default: module.OfficerHomePage })));
const OfficerSchedulePage = React.lazy(() => import('../pages/OfficerSchedulePage'));
const OfficerDebriefPage = React.lazy(() => import('../pages/OfficerDebriefPage'));
const OfficerStaticGuardPage = React.lazy(() => import('../pages/OfficerStaticGuardPage'));
const OfficerAccessControlPage = React.lazy(() => import('../pages/OfficerAccessControlPage'));
const BobWorkspacePage = React.lazy(() => import('../pages/BobWorkspacePage'));

type ActiveModule =
  | 'freedom_camping' | 'parking' | 'noise_control' | 'biosecurity' | 'smoke_control'
  | 'site_guard' | 'access_control' | 'ems' | 'patrol' | 'report' | 'leave' | 'timesheet' | 'schedule'
  | 'overnight_verification' | 'checkpoint_scan' | 'map' | 'dispatch' | 'debrief'
  | 'vehicle_lookup' | 'credentials' | 'bob' | 'modules' | 'workshop' | null;

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
  dispatch: { label: 'Dispatch', description: 'Live jobs and response', icon: Radio },
  debrief: { label: 'Debrief', description: 'Close the shift and follow up', icon: MessageSquare },
  vehicle_lookup: { label: 'Vehicle', description: 'Search vehicle history', icon: Car },
  credentials: { label: 'Credentials', description: 'View capability and expiry', icon: BadgeCheck },
  workshop: { label: 'Workshop', description: 'Your builds and maintenance visits', icon: Wrench },
};

const CORE_OFFICER_MODULES = new Set<ActiveModule>(['report', 'leave', 'timesheet', 'schedule', 'dispatch', 'debrief', 'vehicle_lookup', 'credentials', 'map', 'bob']);

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

const OfficerShell: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { profile, signOut, updatePassword } = useAuth();
  const { shift: activeShift, isLoading: shiftLoading, error: shiftError, refetch: refreshShift } = useActiveShift(profile?.id ?? '', profile?.organizationId ?? '');
  const { status: moduleStatus, enabledModules, isModuleEnabled } = useEnabledModules(profile?.organizationId ?? null);
  const { selectedAgreement, selectedSite, selectedZone, setLocationMode } = useServiceRelationships();
  const [activeModule, setActiveModule] = useState<ActiveModule>(null);
  const moduleContext = useActiveModuleContext(activeModule ?? null);

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
  const [newPassword, setNewPassword] = useState('');
  const [accountMessage, setAccountMessage] = useState<string | null>(null);
  const [savingPassword, setSavingPassword] = useState(false);
  const [grantedModules, setGrantedModules] = useState<string[]>([]);
  const [breadcrumbIssue, setBreadcrumbIssue] = useState<{ pendingCount: number; error: string } | null>(null);
  const [isOnline, setIsOnline] = useState(() => typeof navigator === 'undefined' ? true : navigator.onLine);
  const lastBreadcrumbAtRef = useRef<number | null>(null);

  useEffect(() => { setLocationMode('gps'); }, [setLocationMode]);

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
    if (moduleContext.moduleKey === module && moduleContext.policyStatus && moduleContext.policyStatus !== 'needs_resolution') {
      return moduleContext.enabled;
    }
    return grantedModules.includes(module)
      || (moduleStatus === 'configured' && enabledModules.has(module) && (profile?.moduleAccess ?? []).includes(module));
  }, [enabledModules, grantedModules, moduleContext.enabled, moduleContext.moduleKey, moduleContext.policyStatus, moduleStatus, profile?.moduleAccess]);

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

  // Direct module access requires both the officer's grant and the organisation entitlement.
  useEffect(() => {
    const directAccess = profile?.moduleAccess ?? [];
    setGrantedModules(Array.from(enabledModules).filter((module) => directAccess.includes(module)));
  }, [enabledModules, profile?.moduleAccess]);

  useEffect(() => {
    if (!profile?.id || typeof navigator === 'undefined' || !navigator.geolocation) return;
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        safety.recordMovement(position.coords.latitude, position.coords.longitude);
        const capturedAt = Date.now();
        if (!isBreadcrumbDue(lastBreadcrumbAtRef.current, capturedAt)) return;
        lastBreadcrumbAtRef.current = capturedAt;
        void resolveAddressForCoordinates(position.coords.latitude, position.coords.longitude)
          .catch(() => null)
          .then((address) => captureOfficerBreadcrumb(buildOfficerBreadcrumb(position, activeShift?.id, address?.label ?? null)))
          .then((result) => {
            setBreadcrumbIssue(result.confirmed ? null : { pendingCount: result.pendingCount, error: result.error });
          });
      },
      () => undefined,
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 15_000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [activeShift?.id, profile?.id, safety.recordMovement]);

  useEffect(() => {
    if (!profile?.id || typeof window === 'undefined') return;
    let active = true;
    const flush = () => {
      void flushOfficerBreadcrumbs().then((result) => {
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
  }, [profile?.id]);

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
  const navigateToModule = useCallback((module: ActiveModule) => {
    if (module === null) {
      navigate('/officer');
      setActiveModule(null);
      return;
    }
    if (!canAccessOfficerModule(module)) {
      navigate('/officer', { replace: true });
      setActiveModule(null);
      return;
    }
    navigate(`/officer/${module}`);
    setActiveModule(module);
  }, [canAccessOfficerModule, navigate]);

  const navigateFromNotification = useCallback((notification: NotificationRecord) => {
    const destination = resolveNotificationDestination(profile?.role ?? 'unknown', notification);
    if (!destination) return false;
    if (destination.kind === 'bob') {
      setBobOpen(true);
      return true;
    }
    if (destination.kind === 'officer_module') {
      navigateToModule(destination.module as ActiveModule);
      return true;
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
      case 'modules':
        return (
          <section className="officer-module-directory">
            <header><span>Field tools</span><h1>Enabled modules</h1><p>Tools available for your organisation and role.</p></header>
            {grantedModules.length === 0 ? (
              <div className="officer-module-empty">No enabled field modules are available.</div>
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
    <div className="officer-shell">
      <header className="officer-shell-header">
        <button type="button" className="officer-shell-brand" onClick={() => navigateToModule(null)} title="Officer home">
          <img
            src="https://dotczcyyzgabmtmnglqj.supabase.co/storage/v1/object/public/Logo/IES%20Logo.jpg"
            alt="Iron Eagle Security"
            className="officer-brand-logo"
          />
          <div><strong>Field Compliance Manager</strong><small>{activeShift ? `${activeShift.shift_type} shift` : 'Officer operations'}</small></div>
        </button>

        <div className="officer-shell-tools">
          {offeredCount > 0 && <span className="officer-offer-count" title={`${offeredCount} offered shifts`}>{offeredCount}</span>}
          <button type="button" className={`officer-safety-chip welfare-${currentWelfareStatus}`} onClick={() => void safety.checkIn()} disabled={safety.writeStatus === 'pending'} title="Check in now">
            <span>{welfareDisplay.dot}</span><small>{welfareLabel}</small>
          </button>
          <span className={`officer-connectivity-chip ${isOnline ? 'is-online' : 'is-offline'}`} role="status" title={isOnline ? 'Device is online' : 'Evidence is queued until connection returns'}>{isOnline ? 'Online' : 'Offline'}</span>
          <NotificationCenter onNavigate={navigateFromNotification} />
          <HelpInstructions context={activeModule ?? officerState} role={profile?.role} />
          <button type="button" className="officer-shell-icon" onClick={() => setBobOpen(true)} title="Open Bob command center" aria-label="Open Bob command center" aria-expanded={bobOpen}>
            <Bot size={19} aria-hidden="true" /><span className="sr-only">{bobOpen ? 'Bob assistant is open' : 'Open Bob assistant'}</span>
          </button>
          <button type="button" className="officer-profile-chip" onClick={() => { setAccountOpen(true); setAccountMessage(null); }} title="Account settings" aria-label="Account settings">
            <UserRound size={17} aria-hidden="true" /><span>{profile?.displayName?.split(' ')[0] ?? 'Officer'}</span>
          </button>
        </div>
      </header>

      <div className="bob-page-layout">
      <main data-app-content className="officer-shell-content">
        <OfficerLocationAdvisory shift={activeShift} />
        <PlaceContextBanner />
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
            <OfficerHomePage shift={activeShift} shiftLoading={shiftLoading} shiftError={shiftError} safety={safety} onNavigate={navigateToModule} onRefreshShift={refreshShift} />
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
        presentation="docked"
        onClose={() => setBobOpen(false)}
        context={bobContext}
      />
      </div>

      <nav className="officer-action-bar" aria-label="Field actions">
        <button type="button" onClick={() => navigateToModule('modules')} className={activeModule === 'modules' ? 'is-active' : ''} aria-current={activeModule === 'modules' ? 'page' : undefined}>
          <Grid3X3 size={19} aria-hidden="true" /><span>Modules</span>
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
            <form onSubmit={(event) => void savePassword(event)}><label><span>New password</span><input type="password" autoComplete="new-password" minLength={8} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="At least 8 characters" /></label><button type="submit" disabled={savingPassword || newPassword.length < 8}><KeyRound size={16} />{savingPassword ? 'Updating password' : 'Update password'}</button></form>
            {accountMessage && <p className="officer-account-message" role="status">{accountMessage}</p>}
            <button type="button" className="officer-account-signout" onClick={() => void signOut()}><LogOut size={16} />Sign out</button>
          </section>
        </div>
      )}
    </div>
  );
};

export default OfficerShell;
