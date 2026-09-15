import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Camera, CheckCircle2, Crosshair, LogOut, MapPin, RefreshCw, ScanLine, Shield, Upload, WifiOff, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import {
  buildOfficerScanPayload,
  canSubmitOfficerScan,
  getCurrentPosition,
  imageFileToBase64,
  isNetworkFailure,
  listQueuedOfficerScans,
  markQueuedOfficerScanAttempt,
  queueOfficerScan,
  removeQueuedOfficerScan,
  type ScanModuleKey,
} from '../lib/officerScan';
import { formatComplianceReason } from '../lib/freedomCampingStatus';
import { supabase } from '../lib/supabase';
import { HelpInstructions } from '../components/HelpInstructions';
import { PlaceContextBanner } from '../components/PlaceContextBanner';
import './ScanShell.css';

interface ScanResult {
  success: boolean;
  module_key: ScanModuleKey;
  plate_number: string;
  plate_source: 'alpr' | 'manual';
  zone_name: string | null;
  compliance_status?: string;
  compliance_reason?: string | null;
  verdict?: string;
  recommended_action?: string;
  nights_this_zone?: number;
  nights_this_month?: number;
  effective_limit_minutes?: number;
  breach_alert_id?: string | null;
  breach_write_error?: string;
  zone_closed?: boolean;
  zone_closure?: { closure_type: string; reason: string | null } | null;
  resolution_status?: string | null;
  governor_overlap_flag?: boolean;
  geofence_notice?: string | null;
}

// GEOFENCE_PRINCIPLES P1: each resolver outcome reads differently; none of them is "no zone".
const RESOLUTION_LABEL: Record<string, string> = {
  resolved: 'Verified geofence matched',
  outside_all_geofences: 'Outside all verified geofences',
  unresolved_no_geofence: 'No geofence configured here',
  unresolved_unverified: 'Boundary exists but is not verified',
  unresolved_invalid: 'Boundary geometry is invalid',
  not_evaluated: 'No GPS fix — geofence not evaluated',
};

const MODULE_LABEL: Record<ScanModuleKey, string> = {
  freedom_camping: 'Freedom camping',
  parking_enforcement: 'Parking',
};

export function ScanShell() {
  const { profile, signOut } = useAuth();
  const relationships = useServiceRelationships();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [entitledModules, setEntitledModules] = useState<ScanModuleKey[]>([]);
  const [moduleKey, setModuleKey] = useState<ScanModuleKey>('freedom_camping');
  const [entitlementLoading, setEntitlementLoading] = useState(true);
  const [entitlementError, setEntitlementError] = useState<string | null>(null);
  const [zoneId, setZoneId] = useState('');
  const [imageBase64, setImageBase64] = useState<string>();
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [capturedAt, setCapturedAt] = useState<string>();
  const [preparingImage, setPreparingImage] = useState(false);
  const [location, setLocation] = useState<{ status: 'locating' | 'ready' | 'unavailable'; lat: number | null; lng: number | null; accuracy: number | null }>({ status: 'locating', lat: null, lng: null, accuracy: null });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);
  const [queueMessage, setQueueMessage] = useState<string | null>(null);

  const loadEntitlements = useCallback(async () => {
    const agreementIds = relationships.agreements.map((agreement) => agreement.id);
    if (relationships.loading) return;
    if (!agreementIds.length) {
      setEntitledModules([]);
      setEntitlementLoading(false);
      return;
    }
    try {
      setEntitlementLoading(true);
      setEntitlementError(null);
      const { data, error: queryError } = await supabase
        .from('service_agreement_modules')
        .select('module_key')
        .in('service_agreement_id', agreementIds)
        .eq('enabled', true)
        .eq('standalone_scan_enabled', true);
      if (queryError) throw queryError;
      const modules = [...new Set((data ?? []).map((row) => row.module_key))]
        .filter((key): key is ScanModuleKey => key === 'freedom_camping' || key === 'parking_enforcement');
      setEntitledModules(modules);
      if (modules.length) setModuleKey((current) => modules.includes(current) ? current : modules[0]);
    } catch (queryError) {
      setEntitlementError(queryError instanceof Error ? queryError.message : 'Standalone scan access could not be verified.');
      setEntitledModules([]);
    } finally {
      setEntitlementLoading(false);
    }
  }, [relationships.agreements, relationships.loading]);

  const acquireLocation = useCallback(async () => {
    setLocation({ status: 'locating', lat: null, lng: null, accuracy: null });
    try {
      const position = await getCurrentPosition();
      setLocation({ status: 'ready', lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy });
    } catch {
      setLocation({ status: 'unavailable', lat: null, lng: null, accuracy: null });
    }
  }, []);

  const refreshQueue = useCallback(async () => {
    try {
      setQueuedCount((await listQueuedOfficerScans()).length);
    } catch {
      setQueueMessage('Offline storage is unavailable.');
    }
  }, []);

  useEffect(() => {
    void loadEntitlements();
  }, [loadEntitlements]);

  useEffect(() => {
    void acquireLocation();
    void refreshQueue();
  }, [acquireLocation, refreshQueue]);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const availableZones = useMemo(() => relationships.zones.filter((zone) => {
    if (moduleKey === 'parking_enforcement') return zone.zone_type === 'parking';
    return zone.zone_type === 'freedom_camping';
  }), [moduleKey, relationships.zones]);

  const payload = useMemo(() => buildOfficerScanPayload({
    imageBase64,
    latitude: location.lat,
    longitude: location.lng,
    zoneId,
    capturedAt,
    moduleKey,
  }), [capturedAt, imageBase64, location.lat, location.lng, moduleKey, zoneId]);

  const clearCapture = useCallback(() => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(undefined);
    setImageBase64(undefined);
    setCapturedAt(undefined);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [previewUrl]);

  const handleImage = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setPreparingImage(true);
    setError(null);
    setResult(null);
    try {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(file));
      setImageBase64(await imageFileToBase64(file));
      setCapturedAt(new Date().toISOString());
    } catch (imageError) {
      setPreviewUrl(undefined);
      setImageBase64(undefined);
      setError(imageError instanceof Error ? imageError.message : 'The image could not be prepared.');
    } finally {
      setPreparingImage(false);
    }
  };

  const queueCurrentScan = useCallback(async () => {
    await queueOfficerScan(payload);
    await refreshQueue();
    setQueueMessage('Scan stored on this device and queued for sync.');
    clearCapture();
  }, [clearCapture, payload, refreshQueue]);

  const syncQueue = useCallback(async () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    setQueueMessage(null);
    try {
      const scans = await listQueuedOfficerScans();
      let synced = 0;
      for (const scan of scans) {
        const { error: syncError } = await supabase.functions.invoke('process-officer-scan', { body: { ...scan.body, synced_at: new Date().toISOString() } });
        if (syncError) {
          await markQueuedOfficerScanAttempt(scan);
          continue;
        }
        await removeQueuedOfficerScan(scan.id);
        synced += 1;
      }
      await refreshQueue();
      setQueueMessage(synced ? `${synced} queued scan${synced === 1 ? '' : 's'} synced.` : 'No queued scan could be synced.');
    } catch (syncError) {
      setQueueMessage(syncError instanceof Error ? syncError.message : 'Queued scans could not be synced.');
    }
  }, [refreshQueue]);

  useEffect(() => {
    const handleOnline = () => void syncQueue();
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [syncQueue]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmitOfficerScan(payload) || !entitledModules.includes(moduleKey)) return;
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        await queueCurrentScan();
        return;
      }
      const { data, error: invokeError } = await supabase.functions.invoke<ScanResult>('process-officer-scan', { body: payload });
      if (invokeError) throw invokeError;
      if (!data?.success) throw new Error('The scan did not return a confirmed record.');
      setResult(data);
      clearCapture();
    } catch (submitError) {
      if (isNetworkFailure(submitError)) {
        try {
          await queueCurrentScan();
        } catch (queueError) {
          setError(queueError instanceof Error ? queueError.message : 'The scan could not be queued.');
        }
      } else {
        setError(submitError instanceof Error ? submitError.message : 'The scan could not be processed.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    navigate('/');
  };

  if (!profile) return <div className="scan-shell-state">Loading scan station</div>;

  return (
    <div className="scan-shell">
      <header className="scan-shell-header">
        <div className="scan-shell-brand">
          <img
            src="https://dotczcyyzgabmtmnglqj.supabase.co/storage/v1/object/public/Logo/IES%20Logo.jpg"
            alt="Iron Eagle Security"
            className="scan-brand-logo"
          />
          <div><strong>Field Compliance Manager</strong><small>Standalone scan station</small></div>
        </div>
        <div className="scan-shell-user"><span>{profile.displayName}</span><HelpInstructions context="field scan" role={profile.role} /><button type="button" onClick={() => void handleSignOut()} title="Sign out"><LogOut size={18} /><span className="sr-only">Sign out</span></button></div>
      </header>

      <main className="scan-shell-content">
        <PlaceContextBanner />
        {entitlementLoading || relationships.loading ? (
          <div className="scan-shell-state"><RefreshCw size={22} className="is-spinning" /> Verifying standalone scan access</div>
        ) : entitlementError || relationships.error ? (
          <div className="scan-shell-state is-error" role="alert"><AlertTriangle size={24} /><strong>Scan access could not be verified</strong><span>{entitlementError ?? relationships.error}</span><button type="button" onClick={() => void loadEntitlements()}>Try again</button></div>
        ) : entitledModules.length === 0 ? (
          <div className="scan-shell-state"><ScanLine size={28} /><strong>No standalone scan module is enabled</strong><span>An administrator must enable standalone scanning on a service-agreement module.</span></div>
        ) : (
          <div className="scan-workspace">
            <header className="scan-workspace-heading"><div><span>Capture station</span><h1>Vehicle scan</h1><p>Capture vehicle evidence for ALPR and policy assessment.</p></div>{queuedCount > 0 && <button type="button" className="scan-queue-chip" onClick={() => void syncQueue()}><WifiOff size={15} /> {queuedCount} queued</button>}</header>

            {entitledModules.length > 1 && <div className="scan-module-tabs" role="tablist">{entitledModules.map((module) => <button type="button" role="tab" aria-selected={moduleKey === module} className={moduleKey === module ? 'is-active' : ''} onClick={() => { setModuleKey(module); setZoneId(''); setResult(null); }} key={module}>{MODULE_LABEL[module]}</button>)}</div>}
            {queueMessage && <div className="scan-inline-message" role="status">{queueMessage}</div>}

            <div className="scan-main-grid">
              <form className="scan-capture-form" onSubmit={submit}>
                <input ref={fileInputRef} className="sr-only" type="file" accept="image/*" capture="environment" onChange={handleImage} />
                {previewUrl ? <div className="scan-preview"><img src={previewUrl} alt="Vehicle evidence preview" /><span><CheckCircle2 size={15} /> Evidence ready</span><button type="button" onClick={clearCapture} title="Remove image"><X size={18} /><span className="sr-only">Remove image</span></button></div> : <button type="button" className="scan-camera-target" onClick={() => fileInputRef.current?.click()} disabled={preparingImage}><Camera size={34} /><strong>{preparingImage ? 'Preparing image' : 'Capture vehicle'}</strong><span>Use rear camera</span></button>}

                <div className="scan-input-grid">
                  <label><span>Zone <small>{location.status === 'ready' ? 'automatic when blank' : 'select a location'}</small></span><div><MapPin size={16} /><select value={zoneId} onChange={(event) => setZoneId(event.target.value)}><option value="">Automatic from GPS</option>{availableZones.map((zone) => <option value={zone.id} key={zone.id}>{zone.name}</option>)}</select></div></label>
                </div>

                <div className={`scan-location location-${location.status}`}><Crosshair size={17} /><span>{location.status === 'ready' ? `Location ready · ±${Math.round(location.accuracy ?? 0)} m` : location.status === 'locating' ? 'Acquiring location' : 'Location unavailable · select a zone'}</span><button type="button" onClick={() => void acquireLocation()} disabled={location.status === 'locating'}><RefreshCw size={16} className={location.status === 'locating' ? 'is-spinning' : ''} /><span className="sr-only">Refresh location</span></button></div>
                {error && <div className="scan-error" role="alert"><AlertTriangle size={18} /> {error}</div>}
                <button type="submit" className="scan-submit" disabled={!imageBase64 || !canSubmitOfficerScan(payload) || submitting || preparingImage}>{submitting ? <RefreshCw size={19} className="is-spinning" /> : <Upload size={19} />}{submitting ? 'Processing scan' : `Process ${MODULE_LABEL[moduleKey]} scan`}</button>
              </form>

              <aside className="scan-result-panel">
                {result ? <ScanResultView result={result} /> : <div className="scan-result-empty"><ScanLine size={25} /><strong>Awaiting scan</strong><span>The confirmed result will appear here.</span></div>}
              </aside>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function ScanResultView({ result }: { result: ScanResult }) {
  const status = result.module_key === 'parking_enforcement' ? result.verdict ?? 'unknown' : result.compliance_status ?? 'unknown';
  const positive = status === 'clear' || status === 'compliant';
  return (
    <div className={`scan-result result-${positive ? 'positive' : 'attention'}`}>
      <div className="scan-result-top"><span>{positive ? 'Clear' : status.replace(/_/g, ' ')}</span><small>{result.plate_source}</small></div>
      <strong className="scan-result-plate">{result.plate_number}</strong>
      <p>{result.module_key === 'parking_enforcement' ? (result.recommended_action ?? 'Parking assessment recorded').replace(/_/g, ' ') : formatComplianceReason(result.compliance_reason) || 'Compliance result recorded'}</p>
      <dl>
        <div><dt>Module</dt><dd>{MODULE_LABEL[result.module_key]}</dd></div>
        <div><dt>Zone</dt><dd>{result.zone_name ?? RESOLUTION_LABEL[result.resolution_status ?? ''] ?? 'Geofence outcome not reported'}</dd></div>
        {result.module_key === 'parking_enforcement' ? <div><dt>Time limit</dt><dd>{result.effective_limit_minutes ?? '—'} min</dd></div> : <div><dt>Night count</dt><dd>{result.nights_this_zone ?? 0} current · {result.nights_this_month ?? 0} month</dd></div>}
      </dl>
      {result.geofence_notice && <div className={`scan-error ${result.resolution_status === 'outside_all_geofences' ? 'is-informational' : ''}`} role="alert"><AlertTriangle size={18} /> {result.geofence_notice}</div>}
      {result.governor_overlap_flag && <div className="scan-error is-informational" role="status"><AlertTriangle size={18} /> More than one governing jurisdiction covers this point; the smallest was applied. Confirm the council rule set before serving any notice.</div>}
      {result.zone_closed && <div className="scan-error" role="alert"><AlertTriangle size={18} /> Zone closure in force: {result.zone_closure?.closure_type.replaceAll('_', ' ') ?? 'closure'}{result.zone_closure?.reason ? ` · ${result.zone_closure.reason}` : ''}. Verdict remains rule-derived.</div>}
      {result.breach_write_error && <div className="scan-error" role="alert"><AlertTriangle size={18} /> Record saved, but the breach alert was not confirmed.</div>}
    </div>
  );
}