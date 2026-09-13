import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Crosshair,
  ImagePlus,
  MapPin,
  RefreshCw,
  Search,
  ShieldCheck,
  Upload,
  WifiOff,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLocation } from 'react-router-dom';
import { formatComplianceReason } from '../lib/freedomCampingStatus';
import { type AddressCandidate, resolveAddressCandidates } from '../lib/locationAddress';
import {
  buildOfficerScanPayload,
  canSubmitOfficerScan,
  getCurrentPosition,
  imageFileToBase64,
  isNetworkFailure,
  listQueuedOfficerScans,
  markQueuedOfficerScanAttempt,
  MAX_UPLOAD_ATTEMPTS,
  shouldDropQueuedOfficerScan,
  OfficerScanResult,
  queueOfficerScan,
  removeQueuedOfficerScan,
} from '../lib/officerScan';
import { supabase } from '../lib/supabase';
import { resolveAddressForCoordinates } from '../lib/locationAddress';
import './PageStyles.css';

interface ObservationSummary {
  id: string;
  plate_number: string;
  compliance_status: OfficerScanResult['compliance_status'] | null;
  compliance_reason: string | null;
  nights_this_zone: number | null;
  observed_at: string;
  zone_id: string | null;
}

interface ZoneOption {
  id: string;
  name: string;
}

interface BreachOutcome { id: string; observation_id: string; status: string; action_type: string | null; actioned_at: string | null; notes: string | null; }

type LocationState =
  | { status: 'locating'; latitude: null; longitude: null; accuracy: null; message: string }
  | { status: 'ready'; latitude: number; longitude: number; accuracy: number; message: string }
  | { status: 'unavailable'; latitude: null; longitude: null; accuracy: null; message: string };

const INITIAL_LOCATION: LocationState = {
  status: 'locating',
  latitude: null,
  longitude: null,
  accuracy: null,
  message: 'Acquiring location',
};

const STATUS_LABEL: Record<OfficerScanResult['compliance_status'], string> = {
  compliant: 'Compliant',
  at_risk: 'At risk',
  breach: 'Breach',
  breach_exempt: 'Enforcement exempt',
  unknown: 'Review required',
};

const STATUS_MESSAGE: Record<OfficerScanResult['compliance_status'], string> = {
  compliant: 'No compliance action required.',
  at_risk: 'At the configured limit. The next verified night may breach.',
  breach: 'A compliance breach has been recorded.',
  breach_exempt: 'The breach is recorded, but enforcement is withheld.',
  unknown: 'The evidence needs manual review before action is taken.',
};

const OfficerFreedomCampingPage: React.FC = () => {
  const routeLocation = useLocation();
  const requestedBreachId = new URLSearchParams(routeLocation.search).get('breach');
  const { profile } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [observations, setObservations] = useState<ObservationSummary[]>([]);
  const [zones, setZones] = useState<ZoneOption[]>([]);
    const [breaches, setBreaches] = useState<BreachOutcome[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [zoneId, setZoneId] = useState('');
  const [plateNumber, setPlateNumber] = useState('');
  const [clientRequestId, setClientRequestId] = useState(() => crypto.randomUUID());
  const [imageBase64, setImageBase64] = useState<string>();
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string>();
  const [capturedAt, setCapturedAt] = useState<string>();
  const [preparingImage, setPreparingImage] = useState(false);
  const [location, setLocation] = useState<LocationState>(INITIAL_LOCATION);
  const [addressQuery, setAddressQuery] = useState('');
  const [addressCandidates, setAddressCandidates] = useState<AddressCandidate[]>([]);
  const [resolvingAddress, setResolvingAddress] = useState(false);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [resolvedAddress, setResolvedAddress] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<OfficerScanResult | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [queueMessage, setQueueMessage] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    if (!profile?.id || !profile.organizationId) return;
    try {
      setLoadingHistory(true);
      setHistoryError(null);
      const [observationsResponse, zonesResponse] = await Promise.all([
        supabase
          .from('observations')
          .select('id, plate_number, compliance_status, compliance_reason, nights_this_zone, observed_at, zone_id')
          .eq('officer_id', profile.id)
          .eq('module_key', 'freedom_camping')
          .order('observed_at', { ascending: false })
          .limit(8),
        supabase
          .from('location_zones')
          .select('id, name')
          .eq('organization_id', profile.organizationId)
          .eq('module_key', 'freedom_camping')
          .order('name'),
      ]);
      if (observationsResponse.error) throw observationsResponse.error;
      if (zonesResponse.error) throw zonesResponse.error;
      const observationRows = (observationsResponse.data as ObservationSummary[]) ?? [];
      setObservations(observationRows);
      setZones((zonesResponse.data as ZoneOption[]) ?? []);
      const observationIds = observationRows.map((observation) => observation.id);
      if (observationIds.length) {
        const { data: breachRows, error: breachError } = await supabase.from('breach_alerts').select('id, observation_id, status, action_type, actioned_at, notes').in('observation_id', observationIds).order('actioned_at', { ascending: false, nullsFirst: false });
        if (breachError) throw breachError;
        setBreaches((breachRows as BreachOutcome[]) ?? []);
      } else setBreaches([]);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : 'Recent scans could not be loaded.');
    } finally {
      setLoadingHistory(false);
    }
  }, [profile?.id, profile?.organizationId]);

  useEffect(() => {
    if (requestedBreachId) {
      document.getElementById(`officer-breach-${requestedBreachId}`)?.scrollIntoView({ block: 'center' });
    }
  }, [breaches, requestedBreachId]);

  const refreshQueueCount = useCallback(async () => {
    try {
      setQueuedCount((await listQueuedOfficerScans()).length);
    } catch {
      setQueueMessage('Offline storage is unavailable on this device.');
    }
  }, []);

  const acquireLocation = useCallback(async () => {
    setLocation(INITIAL_LOCATION);
    setResolvedAddress(null);
    try {
      const position = await getCurrentPosition();
      const { latitude, longitude, accuracy } = position.coords;
      setLocation({
        status: 'ready',
        latitude,
        longitude,
        accuracy,
        message: `Location ready · ±${Math.round(accuracy)} m`,
      });
      try {
        const address = await resolveAddressForCoordinates(latitude, longitude);
        setResolvedAddress(address?.label ?? null);
      } catch {
        setResolvedAddress(null);
      }
    } catch {
      setLocation({
        status: 'unavailable',
        latitude: null,
        longitude: null,
        accuracy: null,
        message: 'Location unavailable · choose a zone',
      });
    }
  }, []);

  const applyAddressCandidate = useCallback((candidate: AddressCandidate) => {
    setLocation({
      status: 'ready',
      latitude: candidate.lat,
      longitude: candidate.lng,
      accuracy: 0,
      message: 'Address ready',
    });
    setResolvedAddress(candidate.label);
  }, []);

  const resolveTypedAddress = useCallback(async () => {
    setResolvingAddress(true);
    setAddressError(null);
    try {
      const candidates = await resolveAddressCandidates(addressQuery, 5);
      setAddressCandidates(candidates);
      if (candidates.length === 0) setAddressError('No address match was returned.');
      else applyAddressCandidate(candidates[0]);
    } catch (error) {
      setAddressCandidates([]);
      setAddressError(error instanceof Error ? error.message : 'Address could not be resolved.');
    } finally {
      setResolvingAddress(false);
    }
  }, [addressQuery, applyAddressCandidate]);

  const syncQueuedScans = useCallback(async () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    setSyncing(true);
    setQueueMessage(null);
    try {
      const queuedScans = await listQueuedOfficerScans();
      let synced = 0;
      let dropped = 0;
      for (const scan of queuedScans) {
        const { error } = await supabase.functions.invoke('process-officer-scan', {
          body: { ...scan.body, synced_at: new Date().toISOString() },
        });
        if (error) {
          if (shouldDropQueuedOfficerScan(scan)) {
            await removeQueuedOfficerScan(scan.id);
            dropped += 1;
          } else {
            await markQueuedOfficerScanAttempt(scan);
          }
          continue;
        }
        await removeQueuedOfficerScan(scan.id);
        synced += 1;
      }
      await refreshQueueCount();
      if (synced > 0 || dropped > 0) {
        const messages = [];
        if (synced > 0) messages.push(`${synced} queued scan${synced === 1 ? '' : 's'} synced`);
        if (dropped > 0) messages.push(`${dropped} scan${dropped === 1 ? '' : 's'} removed after ${MAX_UPLOAD_ATTEMPTS} failed attempts`);
        setQueueMessage(`${messages.join('. ')}.`);
        await loadHistory();
      }
    } catch (error) {
      setQueueMessage(error instanceof Error ? error.message : 'Queued scans could not be synced.');
    } finally {
      setSyncing(false);
    }
  }, [loadHistory, refreshQueueCount]);

  useEffect(() => {
    void loadHistory();
    void refreshQueueCount();
    void acquireLocation();
  }, [acquireLocation, loadHistory, refreshQueueCount]);

  useEffect(() => {
    const handleOnline = () => void syncQueuedScans();
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [syncQueuedScans]);

  useEffect(() => () => {
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
  }, [imagePreviewUrl]);

  const payload = useMemo(() => buildOfficerScanPayload({
    clientRequestId,
    plateNumber,
    imageBase64,
    latitude: location.latitude,
    longitude: location.longitude,
    zoneId,
    capturedAt,
  }), [capturedAt, clientRequestId, imageBase64, location.latitude, location.longitude, zoneId, plateNumber]);

  const clearCapture = useCallback(() => {
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    setImagePreviewUrl(undefined);
    setImageBase64(undefined);
    setPlateNumber('');
    setClientRequestId(crypto.randomUUID());
    setCapturedAt(undefined);
    setSubmitError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [imagePreviewUrl]);

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setPreparingImage(true);
    setSubmitError(null);
    setResult(null);
    setPlateNumber('');
    setClientRequestId(crypto.randomUUID());
    try {
      if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
      setImagePreviewUrl(URL.createObjectURL(file));
      setImageBase64(await imageFileToBase64(file));
      setCapturedAt(new Date().toISOString());
    } catch (error) {
      setImagePreviewUrl(undefined);
      setImageBase64(undefined);
      setSubmitError(error instanceof Error ? error.message : 'The image could not be prepared.');
    } finally {
      setPreparingImage(false);
    }
  };

  const queueCurrentScan = useCallback(async () => {
    await queueOfficerScan(payload);
    await refreshQueueCount();
    setQueueMessage('Scan saved on this device and queued for sync.');
    clearCapture();
  }, [clearCapture, payload, refreshQueueCount]);

  const submitScan = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmitOfficerScan(payload)) return;
    setSubmitting(true);
    setSubmitError(null);
    setResult(null);
    try {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        await queueCurrentScan();
        return;
      }
      const { data, error } = await supabase.functions.invoke<OfficerScanResult>('process-officer-scan', { body: payload });
      if (error) throw error;
      if (!data?.observation_id) throw new Error('The scan completed without an observation record.');
      setResult(data);
      clearCapture();
      await loadHistory();
    } catch (error) {
      if (isNetworkFailure(error)) {
        try {
          await queueCurrentScan();
        } catch (queueError) {
          setSubmitError(queueError instanceof Error ? queueError.message : 'The scan could not be queued.');
        }
      } else {
        setSubmitError(error instanceof Error ? error.message : 'The scan could not be processed.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const status = result?.compliance_status ?? 'unknown';

  return (
    <div className="page-container fc-scan-page">
      <header className="fc-scan-header">
        <div>
          <span className="fc-eyebrow">Freedom camping</span>
          <h1>Vehicle scan</h1>
        </div>
        <div className={`fc-connection ${queuedCount > 0 ? 'has-queue' : ''}`}>
          {queuedCount > 0 ? <WifiOff size={15} aria-hidden="true" /> : <ShieldCheck size={15} aria-hidden="true" />}
          <span>{queuedCount > 0 ? `${queuedCount} queued` : 'Ready'}</span>
        </div>
      </header>

      {queuedCount > 0 && (
        <div className="fc-queue-bar" role="status">
          <div>
            <strong>{queuedCount} scan{queuedCount === 1 ? '' : 's'} waiting</strong>
            <span>Stored on this device</span>
          </div>
          <button type="button" className="fc-icon-button" onClick={() => void syncQueuedScans()} disabled={syncing} title="Sync queued scans">
            <RefreshCw size={18} className={syncing ? 'is-spinning' : ''} aria-hidden="true" />
            <span className="sr-only">Sync queued scans</span>
          </button>
        </div>
      )}

      {queueMessage && <div className="fc-inline-message" role="status">{queueMessage}</div>}

      <div className="fc-scan-layout">
        <form className="fc-capture-panel" onSubmit={submitScan}>
          <input ref={fileInputRef} className="sr-only" type="file" accept="image/*" capture="environment" onChange={handleFileChange} />

          {imagePreviewUrl ? (
            <div className="fc-photo-preview">
              <img src={imagePreviewUrl} alt="Vehicle evidence preview" />
              <div className="fc-photo-shade" />
              <span className="fc-photo-label"><CheckCircle2 size={15} aria-hidden="true" /> Evidence captured</span>
              <button type="button" className="fc-remove-photo" onClick={clearCapture} title="Remove photo">
                <X size={18} aria-hidden="true" />
                <span className="sr-only">Remove photo</span>
              </button>
            </div>
          ) : (
            <button type="button" className="fc-camera-target" onClick={() => fileInputRef.current?.click()} disabled={preparingImage}>
              <span className="fc-camera-icon"><Camera size={30} strokeWidth={1.7} aria-hidden="true" /></span>
              <strong>{preparingImage ? 'Preparing image' : 'Capture vehicle'}</strong>
              <span>Rear camera</span>
              <span className="fc-frame-corner fc-frame-top-left" />
              <span className="fc-frame-corner fc-frame-top-right" />
              <span className="fc-frame-corner fc-frame-bottom-left" />
              <span className="fc-frame-corner fc-frame-bottom-right" />
            </button>
          )}

          <div className="fc-field-grid">
            <label className="fc-field">
              <span>Plate <small>manual fallback</small></span>
              <div className="fc-select-wrap">
                <Search size={17} aria-hidden="true" />
                <input value={plateNumber} onChange={(event) => setPlateNumber(event.target.value)} placeholder="Use if ALPR cannot read" autoCapitalize="characters" spellCheck={false} />
              </div>
            </label>
            <label className="fc-field">
              <span>Zone <small>{location.status === 'ready' ? 'auto-detected when blank' : 'required without GPS'}</small></span>
              <div className="fc-select-wrap">
                <MapPin size={17} aria-hidden="true" />
                <select value={zoneId} onChange={(event) => setZoneId(event.target.value)}>
                  <option value="">Automatic from GPS</option>
                  {zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}
                </select>
              </div>
            </label>
            <label className="fc-field">
              <span>Address <small>search</small></span>
              <div className="fc-select-wrap">
                <MapPin size={17} aria-hidden="true" />
                <input value={addressQuery} onChange={(event) => setAddressQuery(event.target.value)} placeholder="Street address or place" />
              </div>
            </label>
          </div>

          <div className="fc-location-row location-ready">
            <Search size={17} aria-hidden="true" />
            <span>{addressError ?? (resolvedAddress ? `Resolved address · ${resolvedAddress}` : 'Address resolver ready')}</span>
            <button type="button" onClick={() => void resolveTypedAddress()} disabled={resolvingAddress || !addressQuery.trim()} title="Resolve address">
              <RefreshCw size={16} className={resolvingAddress ? 'is-spinning' : ''} aria-hidden="true" />
              <span className="sr-only">Resolve address</span>
            </button>
          </div>
          {addressCandidates.length > 1 && <div className="fc-field-grid">{addressCandidates.map((candidate) => <button type="button" className="fc-new-scan" key={`${candidate.source}-${candidate.lat}-${candidate.lng}`} onClick={() => applyAddressCandidate(candidate)}><MapPin size={15} aria-hidden="true" />{candidate.label}</button>)}</div>}

          <div className={`fc-location-row location-${location.status}`}>
            <Crosshair size={17} aria-hidden="true" />
            <span>{location.message}</span>
            <button type="button" onClick={() => void acquireLocation()} disabled={location.status === 'locating'} title="Refresh location">
              <RefreshCw size={16} className={location.status === 'locating' ? 'is-spinning' : ''} aria-hidden="true" />
              <span className="sr-only">Refresh location</span>
            </button>
          </div>
          {resolvedAddress && <div className="fc-inline-message" role="status"><MapPin size={16} aria-hidden="true" /> GPS-resolved address: {resolvedAddress}</div>}

          {submitError && (
            <div className="fc-error" role="alert">
              <AlertTriangle size={18} aria-hidden="true" />
              <span>{submitError}</span>
            </div>
          )}

          <button className="fc-submit" type="submit" disabled={!imageBase64 || !canSubmitOfficerScan(payload) || preparingImage || submitting}>
            {submitting ? <RefreshCw size={19} className="is-spinning" aria-hidden="true" /> : imageBase64 ? <Upload size={19} aria-hidden="true" /> : <ImagePlus size={19} aria-hidden="true" />}
            {submitting ? 'Processing scan' : 'Process scan'}
          </button>
        </form>

        <aside className="fc-result-column">
          {result ? (
            <section className={`fc-verdict verdict-${status}`} aria-live="polite">
              <div className="fc-verdict-topline">
                <span>{STATUS_LABEL[status]}</span>
                <span className="fc-source">{result.plate_source === 'alpr' ? 'ALPR' : 'MANUAL'}</span>
              </div>
              <div className="fc-result-plate">{result.plate_number}</div>
              <p className="fc-verdict-message">{STATUS_MESSAGE[status]}</p>
              {result.compliance_reason && <p className="fc-reason">{formatComplianceReason(result.compliance_reason)}</p>}
              {result.zone_closed && <div className="alert alert-warning" role="alert"><AlertTriangle size={16} aria-hidden="true" />Zone closure in force: {result.zone_closure?.closure_type.replaceAll('_', ' ') ?? 'closure'}{result.zone_closure?.reason ? ` · ${result.zone_closure.reason}` : ''}. The compliance verdict remains rule-derived.</div>}

              <dl className="fc-metrics">
                <div><dt>Current streak</dt><dd>{result.nights_this_zone}<small>{result.limit_consecutive !== null ? ` / ${result.limit_consecutive}` : ''}</small></dd></div>
                <div><dt>This month</dt><dd>{result.nights_this_month}<small>{result.limit_monthly !== null ? ` / ${result.limit_monthly}` : ''}</small></dd></div>
              </dl>

              <div className="fc-result-facts">
                <span><MapPin size={15} aria-hidden="true" /> {result.zone_name ?? 'Outside a configured zone'}</span>
                {result.is_scv && <span><ShieldCheck size={15} aria-hidden="true" /> Active SCV</span>}
                {result.requires_morning_verification && <span><RefreshCw size={15} aria-hidden="true" /> Morning verification required</span>}
              </div>

              {result.breach_write_error && (
                <div className="fc-error" role="alert">
                  <AlertTriangle size={18} aria-hidden="true" />
                  <span>Observation saved, but the breach alert was not confirmed. Supervisor follow-up is required.</span>
                </div>
              )}

              <button type="button" className="fc-new-scan" onClick={() => setResult(null)}><Camera size={17} aria-hidden="true" /> New scan</button>
            </section>
          ) : (
            <section className="fc-awaiting-result">
              <ShieldCheck size={24} aria-hidden="true" />
              <div><strong>Awaiting scan</strong><span>Compliance status appears here after processing.</span></div>
            </section>
          )}

          <section className="fc-recent">
            <div className="fc-section-heading">
              <div><span className="fc-eyebrow">This shift</span><h2>Recent scans</h2></div>
              <button type="button" className="fc-icon-button" onClick={() => void loadHistory()} disabled={loadingHistory} title="Refresh recent scans">
                <RefreshCw size={17} className={loadingHistory ? 'is-spinning' : ''} aria-hidden="true" />
                <span className="sr-only">Refresh recent scans</span>
              </button>
            </div>

            {historyError && <div className="fc-inline-message is-error" role="alert">{historyError}</div>}
            {!loadingHistory && observations.length === 0 && <p className="fc-empty">No scans recorded yet.</p>}
            <div className="fc-recent-list">
              {observations.map((observation) => {
                const observationStatus = observation.compliance_status ?? 'unknown';
                return (
                  <div className="fc-recent-row" key={observation.id}>
                    <span className={`fc-status-dot status-${observationStatus}`} aria-hidden="true" />
                    <div><strong>{observation.plate_number}</strong><span>{formatComplianceReason(observation.compliance_reason) || STATUS_LABEL[observationStatus]}</span></div>
                    <time dateTime={observation.observed_at}>{new Date(observation.observed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                  </div>
                );
              })}
            </div>
          </section>
          {breaches.length > 0 && <section className="fc-recent"><div className="fc-section-heading"><div><span className="fc-eyebrow">Supervisor decisions</span><h2>Breach outcomes</h2></div></div><div className="fc-recent-list">{breaches.map((breach) => <article id={`officer-breach-${breach.id}`} className={`fc-breach-outcome ${breach.id === requestedBreachId ? 'is-context-focus' : ''}`} key={breach.id}><div><strong>Admin outcome · {breach.status.replaceAll('_', ' ')}</strong><span>{breach.action_type?.replaceAll('_', ' ') ?? 'Review decision'}</span></div>{breach.notes && <p>{breach.notes}</p>}<small>Alert {breach.id.slice(0, 8)}{breach.actioned_at ? ` · ${new Date(breach.actioned_at).toLocaleString('en-NZ')}` : ''}</small></article>)}</div></section>}
        </aside>
      </div>
    </div>
  );
};

export default OfficerFreedomCampingPage;