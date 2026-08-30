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
 * - Persistent chrome: FieldSafetyBar (top), PttBar (bottom)
 * - Four-state machine for navigation
 * - Welfare integration with check-in cadence (default 30 min)
 * - Man-down detection via GPS inactivity
 * - Module gating based on profile + org enablement
 * - Responsive mobile-first design
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useWelfareCheckin } from '../hooks/useWelfareCheckin';
import { useManDownDetection } from '../hooks/useManDownDetection';
import { useActiveShift } from '../hooks/useActiveShift';
import { useEnabledModules } from '../hooks/useEnabledModules';
import { supabase } from '../lib/supabase';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { NotificationsBell, PortalSwitcher, ReportButton } from '../components/stubs';
import { BobPanel } from '../components/BobPanel';
import { ProfessionalNav } from '../components/ProfessionalNav';
import { ProfessionalHeader } from '../components/ProfessionalHeader';

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

type ActiveModule =
  | 'freedom_camping' | 'parking' | 'noise_control' | 'biosecurity' | 'smoke_control'
  | 'site_guard' | 'ems' | 'patrol' | 'report' | 'leave' | 'timesheet' | 'schedule'
  | 'overnight_verification' | 'checkpoint_scan' | 'map' | 'dispatch' | 'debrief'
  | 'vehicle_lookup' | 'credentials' | 'modules' | null;

type WelfareStatus = 'ok' | 'due' | 'overdue' | 'man_down' | 'sos';

type OfficerState = 'standby' | 'home' | 'selector' | 'portal';

interface ShiftRecord {
  id: string;
  officer_user_id: string;
  scheduled_start: string;
  scheduled_end: string;
  status: 'published' | 'accepted' | 'scheduled' | 'in_progress' | 'completed';
  service_type: string;
  location_name?: string;
  notes?: string;
}

// Module metadata
const MODULE_METADATA: Record<string, { label: string; icon: string }> = {
  freedom_camping: { label: 'Freedom Camping', icon: '🏕️' },
  parking: { label: 'Parking', icon: '🅿️' },
  noise_control: { label: 'Noise Control', icon: '🔊' },
  biosecurity: { label: 'Biosecurity', icon: '🦠' },
  smoke_control: { label: 'Smoke Control', icon: '💨' },
  site_guard: { label: 'Site Guard', icon: '🛡️' },
  ems: { label: 'EMS', icon: '🚑' },
  patrol: { label: 'Patrol', icon: '🚗' },
  report: { label: 'Reports', icon: '📝' },
  leave: { label: 'Leave', icon: '📅' },
  timesheet: { label: 'Timesheet', icon: '⏱️' },
  schedule: { label: 'Schedule', icon: '📋' },
  overnight_verification: { label: 'Overnight', icon: '🌙' },
  checkpoint_scan: { label: 'Checkpoints', icon: '📍' },
  map: { label: 'Map', icon: '🗺️' },
  dispatch: { label: 'Dispatch', icon: '📡' },
  debrief: { label: 'Debrief', icon: '💬' },
  vehicle_lookup: { label: 'Vehicle', icon: '🚙' },
  credentials: { label: 'Credentials', icon: '🪪' },
};

const WELFARE_STATUS_DISPLAY: Record<WelfareStatus, { bg: string; dot: string; color: string }> = {
  ok: { bg: '#1A1A1A', dot: 'OK', color: '#4CAF50' },
  due: { bg: '#1A1200', dot: 'DUE', color: '#FF9800' },
  overdue: { bg: '#1A0000', dot: 'OVR', color: '#EF5350' },
  man_down: { bg: '#3A0000', dot: '!!', color: '#FF1744' },
  sos: { bg: '#3A0000', dot: 'SOS', color: '#FF1744' },
};

const LazyPageFallback: React.FC = () => (
  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
    <div style={{ color: 'var(--color-text-secondary)' }}>Loading module...</div>
  </div>
);

const StandbyScreen: React.FC<{ onNavigate: (module: ActiveModule) => void }> = ({ onNavigate }) => (
  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '60vh', gap: '24px' }}>
    <div style={{ fontSize: '48px' }}>⏸️</div>
    <div style={{ fontSize: '24px', fontWeight: 600, color: 'var(--color-text-primary)' }}>No Active Shift</div>
    <div style={{ color: 'var(--color-text-secondary)', textAlign: 'center', maxWidth: '300px' }}>
      You don't currently have an active shift. Access modules or check your roster for upcoming assignments.
    </div>
    <div style={{ display: 'flex', gap: '12px' }}>
      <button
        onClick={() => onNavigate('schedule')}
        style={{
          padding: '12px 24px',
          backgroundColor: 'var(--color-primary)',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: 'pointer',
          fontWeight: 500,
        }}
      >
        View Schedule
      </button>
      <button
        onClick={() => onNavigate('modules')}
        style={{
          padding: '12px 24px',
          backgroundColor: 'transparent',
          color: 'var(--color-primary)',
          border: '1px solid var(--color-primary)',
          borderRadius: '4px',
          cursor: 'pointer',
          fontWeight: 500,
        }}
      >
        Access Modules
      </button>
    </div>
  </div>
);

const OfficerShell: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { profile } = useAuth();
  const { checkin, needsCheckin } = useWelfareCheckin(profile?.id ?? '');
  const { isManDown } = useManDownDetection(profile?.id ?? '', { organizationId: profile?.organizationId ?? '' });
  const { shift: activeShift } = useActiveShift(profile?.id ?? '', profile?.organizationId ?? '');
  const { enabledModules } = useEnabledModules(profile?.organizationId ?? null);
  const { selectedAgreement, selectedSite, selectedZone } = useServiceRelationships();

  const [activeModule, setActiveModule] = useState<ActiveModule>(null);
  const [officerState, setOfficerState] = useState<OfficerState>('home');
  const [offeredCount, setOfferedCount] = useState(0);
  const [bobOpen, setBobOpen] = useState(false);
  const [grantedModules, setGrantedModules] = useState<string[]>([]);

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

  // Load offered shift count
  useEffect(() => {
    const loadOfferedCount = async () => {
      if (!profile?.id) return;

      try {
        const { count } = await supabase
          .from('shifts')
          .select('id', { count: 'exact', head: true })
          .eq('officer_user_id', profile.id)
          .eq('status', 'published');

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
    if (module === 'modules' || module === null) {
      navigate('/officer');
      setActiveModule(null);
    } else {
      navigate(`/officer/${module}`);
      setActiveModule(module);
    }
  }, [navigate]);

  // Get welfare status
  const currentWelfareStatus: WelfareStatus = isManDown
    ? 'man_down'
    : checkin?.status === 'escalated'
      ? 'overdue'
      : needsCheckin
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
  }), [activeModule, officerState, activeShift, currentWelfareStatus, profile?.role, selectedAgreement, selectedSite, selectedZone]);

  // Render module portal
  const renderModuleContent = useCallback(() => {
    switch (activeModule) {
      case 'schedule':
        return <div style={{ padding: '16px' }}>📋 Schedule Module</div>;
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
        return <ComingSoonPage title="Debrief" />;
      case 'map':
        return <OfficerMapPage />;
      case 'modules':
        return (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '12px', padding: '16px' }}>
            {grantedModules.map((mod) => {
              const meta = MODULE_METADATA[mod];
              if (!meta) return null;
              return (
                <button
                  key={mod}
                  onClick={() => navigateToModule(mod as ActiveModule)}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '16px',
                    backgroundColor: 'var(--color-bg-secondary)',
                    border: '1px solid var(--color-border)',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    gap: '8px',
                    fontSize: '14px',
                  }}
                >
                  <span style={{ fontSize: '24px' }}>{meta.icon}</span>
                  <span>{meta.label}</span>
                </button>
              );
            })}
          </div>
        );
      default:
        return <LazyPageFallback />;
    }
  }, [activeModule, grantedModules, navigateToModule]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', backgroundColor: 'var(--color-bg-primary)' }}>
      {/* Professional Header */}
      <ProfessionalHeader
        title="Officer Operations"
        subtitle={activeShift ? `${activeShift?.shift_type || 'Shift'} in progress` : 'No active shift'}
        statusIndicator={{
          status: isManDown ? 'offline' : (needsCheckin ? 'idle' : 'online'),
          label: isManDown ? 'Man Down' : (needsCheckin ? 'Check-in Due' : 'OK'),
        }}
        userDisplayName={profile?.displayName}
        notificationCount={offeredCount}
        onNotifications={() => navigateToModule('schedule')}
        actions={currentWelfareStatus !== 'ok' ? [
          {
            label: '🆘 SOS',
            onClick: () => console.log('SOS triggered'),
            variant: 'danger',
          },
        ] : undefined}
      />

      {/* Main Layout with Sidebar */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Professional Navigation Sidebar */}
        <ProfessionalNav
          sections={[
            {
              title: 'Active Shift',
              items: activeShift ? [
                {
                  id: 'shift-home',
                  label: 'Dashboard',
                  path: '/officer',
                  status: 'active',
                },
              ] : [],
            },
            {
              title: 'Field Operations',
              items: [
                { id: 'freedom_camping', label: 'Freedom Camping', path: '/officer/freedom_camping', status: grantedModules.includes('freedom_camping') ? ('active' as const) : ('none' as const) },
                { id: 'parking', label: 'Parking', path: '/officer/parking', status: grantedModules.includes('parking') ? ('active' as const) : ('none' as const) },
                { id: 'noise_control', label: 'Noise Control', path: '/officer/noise_control', status: grantedModules.includes('noise_control') ? ('active' as const) : ('none' as const) },
                { id: 'biosecurity', label: 'Biosecurity', path: '/officer/biosecurity', status: grantedModules.includes('biosecurity') ? ('active' as const) : ('none' as const) },
                { id: 'smoke_control', label: 'Smoke Control', path: '/officer/smoke_control', status: grantedModules.includes('smoke_control') ? ('active' as const) : ('none' as const) },
                { id: 'patrol', label: 'Patrol', path: '/officer/patrol', status: grantedModules.includes('patrol') ? ('active' as const) : ('none' as const) },
              ].filter(item => grantedModules.includes(item.id)),
            },
            {
              title: 'Site Operations',
              items: [
                { id: 'dispatch', label: 'Dispatch', path: '/officer/dispatch', status: grantedModules.includes('dispatch') ? ('active' as const) : ('none' as const) },
                { id: 'vehicle_lookup', label: 'Vehicle Lookup', path: '/officer/vehicle_lookup', status: grantedModules.includes('vehicle_lookup') ? ('active' as const) : ('none' as const) },
                { id: 'map', label: 'Map View', path: '/officer/map', status: grantedModules.includes('map') ? ('active' as const) : ('none' as const) },
              ].filter(item => grantedModules.includes(item.id)),
            },
            {
              title: 'Administration',
              items: [
                { id: 'timesheet', label: 'Timesheet', path: '/officer/timesheet', status: 'none' as const },
                { id: 'leave', label: 'Leave', path: '/officer/leave', status: 'none' as const },
                { id: 'credentials', label: 'Credentials', path: '/officer/credentials', status: 'none' as const },
                { id: 'report', label: 'Field Reports', path: '/officer/report', status: offeredCount > 0 ? ('pending' as const) : ('none' as const) },
              ],
            },
          ]}
          currentPath={location.pathname}
          onNavigate={(path) => navigate(path)}
        />

        {/* Main Content Area */}
        <main style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          {officerState === 'standby' && <StandbyScreen onNavigate={navigateToModule} />}
          {(officerState === 'home' || officerState === 'selector' || officerState === 'portal') && (
            <React.Suspense fallback={<LazyPageFallback />}>
              {renderModuleContent()}
            </React.Suspense>
          )}
        </main>
      </div>

      {/* Safety Footer Chrome */}
      <div
        style={{
          height: '52px',
          backgroundColor: 'var(--color-bg-secondary)',
          borderTop: '1px solid var(--color-border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingLeft: 'var(--space-4)',
          paddingRight: 'var(--space-4)',
          gap: 'var(--space-3)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
          <span style={{
            display: 'inline-flex',
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: welfareDisplay.color,
          }} />
          {isManDown ? 'Man Down Detected' : needsCheckin ? 'Welfare Check-in Due' : 'Officer OK'}
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
          <button
            onClick={() => navigateToModule('modules')}
            style={{
              padding: 'var(--space-2) var(--space-4)',
              backgroundColor: 'transparent',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--color-text-primary)',
              cursor: 'pointer',
              fontWeight: 500,
              fontSize: 'var(--text-sm)',
            }}
          >
            All Modules
          </button>

          {ReportButton && (
            <ReportButton
              style={{
                padding: 'var(--space-2) var(--space-4)',
                backgroundColor: 'var(--color-primary)',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                color: 'white',
                cursor: 'pointer',
                fontWeight: 500,
                fontSize: 'var(--text-sm)',
              }}
            />
          )}

          <button
            onClick={() => console.log('SOS triggered')}
            style={{
              padding: 'var(--space-2) var(--space-4)',
              backgroundColor: 'var(--color-error)',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              color: 'white',
              cursor: 'pointer',
              fontWeight: 700,
              fontSize: 'var(--text-sm)',
            }}
            title="Emergency SOS"
          >
            🆘 SOS
          </button>
        </div>
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

export default OfficerShell;
