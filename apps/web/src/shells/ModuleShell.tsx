import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Bot, ShieldCheck, Siren } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useActiveShift } from '../hooks/useActiveShift';
import { useEnabledModules } from '../hooks/useEnabledModules';
import { useOfficerSafety } from '../hooks/useOfficerSafety';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { BobPanel } from '../components/BobPanel';
import { SPECIALTY_MODULES, SPECIALTY_MODULE_BY_KEY, type SpecialtyModuleKey } from '../config/specialtyModules';
import './ModuleShell.css';

const OfficerFreedomCampingPage = React.lazy(() => import('../pages/OfficerFreedomCampingPage'));
const OfficerParkingPage = React.lazy(() => import('../pages/OfficerParkingPage'));
const OfficerNoiseControlPage = React.lazy(() => import('../pages/OfficerNoiseControlPage'));
const OfficerBiosecurityPage = React.lazy(() => import('../pages/OfficerBiosecurityPage'));
const SmokeControlPage = React.lazy(() => import('../pages/modules/SmokeControlPage'));
const OfficerStaticGuardPage = React.lazy(() => import('../pages/OfficerStaticGuardPage'));
const BreachReviewPage = React.lazy(() => import('../pages/BreachReviewPage'));
const ParkingOversightPage = React.lazy(() => import('../pages/ParkingOversightPage'));
const NoiseControlOversightPage = React.lazy(() => import('../pages/NoiseControlOversightPage'));
const BiosecurityOversightPage = React.lazy(() => import('../pages/BiosecurityOversightPage'));

function getGps() {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve(null);
  return new Promise<{ lat: number; lng: number } | null>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 8_000 },
    );
  });
}

function renderModule(moduleKey: string, adminView: boolean) {
  switch (moduleKey) {
    case 'freedom_camping': return adminView ? <BreachReviewPage /> : <OfficerFreedomCampingPage />;
    case 'parking_enforcement': return adminView ? <ParkingOversightPage /> : <OfficerParkingPage />;
    case 'noise_control': return adminView ? <NoiseControlOversightPage /> : <OfficerNoiseControlPage />;
    case 'biosecurity': return adminView ? <BiosecurityOversightPage /> : <OfficerBiosecurityPage />;
    case 'smoke_complaints':
    case 'smoke_control': return <SmokeControlPage />;
    case 'static_guarding': return <OfficerStaticGuardPage />;
    default: return null;
  }
}

export function ModuleShell() {
  const { moduleKey = '' } = useParams<{ moduleKey: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const { selectedAgreement, selectedSite, selectedZone } = useServiceRelationships();
  const { status, isModuleEnabled } = useEnabledModules(profile?.organizationId ?? null);
  const { shift } = useActiveShift(profile?.id ?? '', profile?.organizationId ?? '');
  const safety = useOfficerSafety({
    officerId: profile?.id ?? null,
    organizationId: profile?.organizationId ?? null,
    orgManDownEnabled: isModuleEnabled('welfare', { safetyRelevant: true }),
    getGps,
  });
  const [bobOpen, setBobOpen] = useState(false);
  const adminView = ['grand_master', 'master', 'admin'].includes(profile?.role ?? '')
    || (profile?.role === 'admin_officer' && typeof sessionStorage !== 'undefined' && sessionStorage.getItem('fcm.admin_officer.portal') === 'admin');
  const canonicalKey = moduleKey === 'smoke_control' ? 'smoke_complaints' : moduleKey;
  const moduleDefinition = SPECIALTY_MODULE_BY_KEY[canonicalKey as SpecialtyModuleKey];
  const label = moduleDefinition?.label;
  const allowed = status !== 'loading' && Boolean(moduleDefinition) && isModuleEnabled(canonicalKey);
  const availableModules = SPECIALTY_MODULES.filter((module) => isModuleEnabled(module.key));

  useEffect(() => {
    if (status !== 'loading' && !allowed) navigate('/officer', { replace: true });
  }, [allowed, navigate, status]);

  const bobContext = useMemo(() => ({
    activeModule: moduleKey,
    officerState: 'module',
    shift,
    welfareStatus: safety.activeAlert ? 'alert' : safety.status,
    role: profile?.role,
    agreement: selectedAgreement,
    site: selectedSite,
    zone: selectedZone,
    moduleGateStatus: status,
  }), [moduleKey, profile?.role, safety.activeAlert, safety.status, selectedAgreement, selectedSite, selectedZone, shift, status]);

  if (status === 'loading' || !label || !allowed) return <div className="module-shell-loading">Checking module access...</div>;

  return (
    <div className="module-shell">
      <header className="module-shell-header">
        <button type="button" className="module-shell-back" onClick={() => navigate('/officer')}>
          <ArrowLeft size={17} aria-hidden="true" />
          <span>Field operations</span>
        </button>
        <div className="module-shell-title"><span>Standalone module</span><strong>{label}</strong></div>
        <div className="module-shell-actions">
          {availableModules.length > 1 && <label className="module-shell-switch"><span className="sr-only">Switch module</span><select value={moduleDefinition?.key ?? ''} onChange={(event) => navigate(`/modules/${event.target.value}`)} aria-label="Switch standalone module">{availableModules.map((module) => <option key={module.key} value={module.key}>{module.label}</option>)}</select></label>}
          <span className={`module-shell-safety ${safety.activeAlert ? 'is-alert' : ''}`}><ShieldCheck size={16} aria-hidden="true" />{safety.activeAlert ? 'Alert' : 'Safety'}</span>
          <button type="button" className="module-shell-icon" onClick={() => setBobOpen(true)} title="Open Bob assistant" aria-label="Open Bob assistant"><Bot size={18} aria-hidden="true" /></button>
          <button type="button" className="module-shell-sos" onClick={() => void safety.triggerSOS()} disabled={safety.writeStatus === 'pending' || safety.activeAlert?.kind === 'sos'} title="Trigger SOS" aria-label="Trigger SOS"><Siren size={17} aria-hidden="true" /></button>
        </div>
      </header>
      <main className="module-shell-content">
        <React.Suspense fallback={<div className="module-shell-loading">Loading module...</div>}>
          {renderModule(canonicalKey, adminView)}
        </React.Suspense>
      </main>
      <BobPanel open={bobOpen} onClose={() => setBobOpen(false)} context={bobContext} />
    </div>
  );
}

export default ModuleShell;