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
  Map,
  MapPin,
  MessageSquare,
  Moon,
  Radio,
  Route,
  Shield,
  Siren,
  Tent,
  UserRound,
  Volume2,
  Wind,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useActiveShift } from '../hooks/useActiveShift';
import { useOfficerSafety } from '../hooks/useOfficerSafety';
import { useEnabledModules } from '../hooks/useEnabledModules';
import { supabase } from '../lib/supabase';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { BobPanel } from '../components/BobPanel';
import { NotificationCenter, type NotificationRecord } from '../components/NotificationCenter';
import { PttBar } from '../components/PttBar';
import { resolveNotificationDestination } from '../lib/notificationNavigation';
import {
  buildOfficerBreadcrumb,
  captureOfficerBreadcrumb,
  flushOfficerBreadcrumbs,
  isBreadcrumbDue,
} from '../lib/officerBreadcrumb';
import './OfficerShell.css';

const PatrolPage = React.lazy(() => import('../pages/PatrolPage'));
const SmokeControlPage = React.lazy(() => import('../pages/modules/SmokeControlPage'));
const OfficerFieldReportPage = React.lazy(() => import('../pages/OfficerFieldReportPage'));
const OfficerLeavePage = React.lazy(() => import('../pages/OfficerLeavePage'));
const OfficerTimesheetPage = React.lazy(() => import('../pages/OfficerTimesheetPage'));
const OfficerCredentialsPage = React.lazy(() => import('../pages/OfficerCredentialsPage'));
const OfficerVehicleLookupPage = React.lazy(() => import('../pages/OfficerVehicleLookupPage'));
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

type ActiveModule =
  | 'freedom_camping' | 'parking' | 'noise_control' | 'biosecurity' | 'smoke_control'
  | 'site_guard' | 'ems' | 'patrol' | 'report' | 'leave' | 'timesheet' | 'schedule'
  | 'overnight_verification' | 'checkpoint_scan' | 'map' | 'dispatch' | 'debrief'
  | 'vehicle_lookup' | 'credentials' | 'modules' | null;

type WelfareStatus = 'ok' | 'due' | 'overdue' | 'man_down' | 'sos';

type OfficerState = 'standby' | 'home' | 'selector' | 'portal';

// Module metadata
const MODULE_METADATA: Record<string, { label: string; icon: LucideIcon }> = {
  freedom_camping: { label: 'Freedom Camping', icon: Tent },
  parking: { label: 'Parking', icon: Car },
  noise_control: { label: 'Noise Control', icon: Volume2 },
  biosecurity: { label: 'Biosecurity', icon: Activity },
  smoke_control: { label: 'Smoke Control', icon: Wind },
  site_guard: { label: 'Site Guard', icon: Shield },
  ems: { label: 'EMS', icon: Activity },
  patrol: { label: 'Patrol', icon: Route },
  report: { label: 'Reports', icon: FileText },
  leave: { label: 'Leave', icon: CalendarDays },
  timesheet: { label: 'Timesheet', icon: Clock3 },
  schedule: { label: 'Schedule', icon: ClipboardList },
  overnight_verification: { label: 'Overnight', icon: Moon },
  checkpoint_scan: { label: 'Checkpoints', icon: MapPin },
  map: { label: 'Map', icon: Map },
  dispatch: { label: 'Dispatch', icon: Radio },
  debrief: { label: 'Debrief', icon: MessageSquare },
  vehicle_lookup: { label: 'Vehicle', icon: Car },
  credentials: { label: 'Credentials', icon: BadgeCheck },
};

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
  const { profile } = useAuth();
  const { shift: activeShift, isLoading: shiftLoading, error: shiftError } = useActiveShift(profile?.id ?? '', profile?.organizationId ?? '');
  const { status: moduleStatus, enabledModules, isModuleEnabled } = useEnabledModules(profile?.organizationId ?? null);
  const { selectedAgreement, selectedSite, selectedZone } = useServiceRelationships();

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

  const [activeModule, setActiveModule] = useState<ActiveModule>(null);
  const [officerState, setOfficerState] = useState<OfficerState>('home');
  const [offeredCount, setOfferedCount] = useState(0);
  const [bobOpen, setBobOpen] = useState(false);
  const [grantedModules, setGrantedModules] = useState<string[]>([]);
  const [breadcrumbIssue, setBreadcrumbIssue] = useState<{ pendingCount: number; error: string } | null>(null);
  const lastBreadcrumbAtRef = useRef<number | null>(null);

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
    setActiveModule(module);

    if (!activeShift && !module) {
      setOfficerState('standby');
    } else if (activeShift && !module) {
      setOfficerState('home');
    } else if (grantedModules.length > 1 && !module) {
      setOfficerState('selector');
    } else if (module) {
      setOfficerState('portal');
    } else {
      setOfficerState('home');
    }
  }, [location.pathname, activeShift, grantedModules, moduleFromUrl]);

  // Load granted modules
  useEffect(() => {
    setGrantedModules(Array.from(enabledModules));
  }, [enabledModules]);

  useEffect(() => {
    if (!profile?.id || typeof navigator === 'undefined' || !navigator.geolocation) return;
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        safety.recordMovement(position.coords.latitude, position.coords.longitude);
        const capturedAt = Date.now();
        if (!isBreadcrumbDue(lastBreadcrumbAtRef.current, capturedAt)) return;
        lastBreadcrumbAtRef.current = capturedAt;
        void captureOfficerBreadcrumb(buildOfficerBreadcrumb(position, activeShift?.id)).then((result) => {
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
    } else {
      navigate(`/officer/${module}`);
      setActiveModule(module);
    }
  }, [navigate]);

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
    return false;
  }, [navigateToModule, profile?.role]);

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
      case 'noise_control':
        return <OfficerNoiseControlPage />;
      case 'parking':
        return <OfficerParkingPage />;
      case 'dispatch':
        return <OfficerDispatchPage />;
      case 'biosecurity':
        return <OfficerBiosecurityPage />;
      case 'freedom_camping':
        return <OfficerFreedomCampingPage />;
      case 'overnight_verification':
        return <OfficerOvernightVerificationPage />;
      case 'site_guard':
        return <OfficerDispatchPage />;
      case 'ems':
        return <OfficerFieldReportPage />;
      case 'debrief':
        return <OfficerDebriefPage />;
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
                  return (
                    <button key={mod} onClick={() => navigateToModule(mod as ActiveModule)}>
                      <span><Icon size={21} /></span>
                      <strong>{meta.label}</strong>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        );
      default:
        return <LazyPageFallback />;
    }
  }, [activeModule, grantedModules, navigateToModule]);

  return (
    <div className="officer-shell">
      <header className="officer-shell-header">
        <button type="button" className="officer-shell-brand" onClick={() => navigateToModule(null)} title="Officer home">
          <span><Shield size={19} aria-hidden="true" /></span>
          <div><strong>Field Compliance Manager</strong><small>{activeShift ? `${activeShift.shift_type} shift` : 'Officer operations'}</small></div>
        </button>

        <div className="officer-shell-tools">
          {offeredCount > 0 && <span className="officer-offer-count" title={`${offeredCount} offered shifts`}>{offeredCount}</span>}
          <button type="button" className={`officer-safety-chip welfare-${currentWelfareStatus}`} onClick={() => void safety.checkIn()} disabled={safety.writeStatus === 'pending'} title="Check in now">
            <span>{welfareDisplay.dot}</span><small>Safety</small>
          </button>
          <NotificationCenter onNavigate={navigateFromNotification} />
          <button type="button" className="officer-shell-icon" onClick={() => setBobOpen(true)} title="Open Bob assistant">
            <Bot size={19} aria-hidden="true" /><span className="sr-only">Open Bob assistant</span>
          </button>
          <div className="officer-profile-chip" title={profile?.displayName ?? 'Officer'}>
            <UserRound size={17} aria-hidden="true" /><span>{profile?.displayName?.split(' ')[0] ?? 'Officer'}</span>
          </div>
        </div>
      </header>

      <main data-app-content className="officer-shell-content">
        {safety.writeStatus === 'error' && safety.lastError && (
          <div role="alert" className="officer-shell-safety-error">
            Safety action not confirmed: {safety.lastError}
          </div>
        )}
        {breadcrumbIssue && (
          <div role="status" className="officer-shell-evidence-warning">
            Location evidence not confirmed. {breadcrumbIssue.pendingCount} {breadcrumbIssue.pendingCount === 1 ? 'record is' : 'records are'} queued for retry. {breadcrumbIssue.error}
          </div>
        )}
        {(officerState === 'standby' || officerState === 'home') && (
          <React.Suspense fallback={<LazyPageFallback />}>
            <OfficerHomePage shift={activeShift} shiftLoading={shiftLoading} shiftError={shiftError} safety={safety} onNavigate={navigateToModule} />
          </React.Suspense>
        )}
        {(officerState === 'selector' || officerState === 'portal') && (
          <React.Suspense fallback={<LazyPageFallback />}>
            {renderModuleContent()}
          </React.Suspense>
        )}
      </main>

      <nav className="officer-action-bar" aria-label="Field actions">
        <button type="button" onClick={() => navigateToModule('modules')} className={activeModule === 'modules' ? 'is-active' : ''}>
          <Grid3X3 size={19} aria-hidden="true" /><span>Modules</span>
        </button>
        <button type="button" onClick={() => navigateToModule('report')} className={activeModule === 'report' ? 'is-active' : ''}>
          <FilePlus2 size={19} aria-hidden="true" /><span>Report</span>
        </button>
        <button type="button" className="officer-sos-action" onClick={() => void safety.triggerSOS()} disabled={safety.writeStatus === 'pending' || safety.activeAlert?.kind === 'sos'}>
          <Siren size={19} aria-hidden="true" /><span>{safety.activeAlert?.kind === 'sos' ? 'SOS active' : 'SOS'}</span>
        </button>
      </nav>

      <PttBar />

      <BobPanel
        open={bobOpen}
        onClose={() => setBobOpen(false)}
        context={bobContext}
      />
    </div>
  );
};

export default OfficerShell;
