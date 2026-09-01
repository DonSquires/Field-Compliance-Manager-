/**
 * OfficerParkingPage.tsx (Officer module: 'parking')
 *
 * Canonical schema: parking_chalk_records (digital chalk-and-return
 * pass), via the SAME process-officer-scan pipeline as freedom camping
 * (module_key='parking_enforcement') -- ALPR, vehicle embedding for
 * movement/re-scan detection, classify-parking-scene (road markings,
 * disabled bay, signed time limit), rego/WOF/COF lookups, and
 * evaluate_parking_compliance() for the overstay verdict. breach_alerts
 * are auto-created server-side on overstay or expired rego/WOF/COF.
 *
 * Previously this page was a manual plate-typing form completely
 * disconnected from that pipeline -- no photo, no GPS, no zone, no ALPR,
 * no embedding-based re-scan matching, and no breach-alert generation.
 * Rebuilt to mirror OfficerFreedomCampingPage.tsx's capture flow, per
 * Bob's module_parking/workflow_parking knowledge cards: first-pass scan
 * -> return-pass scan -> over-stay detected -> breach alert with both
 * scan timestamps as evidence.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Camera, CheckCircle2, Crosshair, ImagePlus, MapPin, RefreshCw, ShieldCheck, Upload, WifiOff, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import {
  buildOfficerScanPayload,
  canSubmitOfficerScan,
  getCurrentPosition,
  imageFileToBase64,
  isNetworkFailure,
  listQueuedOfficerScans,
  markQueuedOfficerScanAttempt,
  normalizePlate,
  queueOfficerScan,
  removeQueuedOfficerScan,
} from '../lib/officerScan';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface ParkingScanResult {
  success: boolean;
  verdict: 'clear' | 'watch' | 'overstay' | string;
  plate: string;
  plate_number: string;
  plate_source: 'alpr' | 'manual';
  effective_limit_minutes: number;
  grace_period_minutes: number;
  minutes_elapsed: number | null;
  is_overstay: boolean;
  is_disabled_bay: boolean;
  road_marking: string;
  recommended_action: string;
  is_repeat: boolean;
  repeat_count: number;
  movement_moved: boolean | null;
  movement_similarity: number | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_colour: string | null;
  rego_status: string;
  wof_status: string;
  cof_status: string;
  vehicle_compliance_flags: string[];
  zone_id: string | null;
  zone_name: string | null;
  zone_closed: boolean;
  chalk_record_id: string;
  breach_alert_id: string | null;
  breach_write_error?: string;
}

interface ChalkRecord {
  id: string;
  plate: string;
  chalked_at: string;
  return_by: string;
  status: string;
  location_name: string | null;
  zone_id: string | null;
}

interface ZoneOption {
  id: string;
  name: string;
}

type LocationState =
  | { status: 'locating'; latitude: null; longitude: null; accuracy: null; message: string }
  | { status: 'ready'; latitude: number; longitude: number; accuracy: number; message: string }
  | { status: 'unavailable'; latitude: null; longitude: null; accuracy: null; message: string };

const INITIAL_LOCATION: LocationState = { status: 'locating', latitude: null, longitude: null, accuracy: null, message: 'Acquiring location' };

const VERDICT_LABEL: Record<string, string> = {
  clear: 'Clear',
  watch: 'Approaching limit',
  overstay: 'Overstay',
};

const OfficerParkingPage: React.FC = () => {
  const { profile } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [records, setRecords] = useState<ChalkRecord[]>([]);
  const [zones, setZones] = useState<ZoneOption[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [plateNumber, setPlateNumber] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [imageBase64, setImageBase64] = useState<string>();
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string>();
  const [capturedAt, setCapturedAt] = useState<string>();
  const [preparingImage, setPreparingImage] = useState(false);
  const [location, setLocation] = useState<LocationState>(INITIAL_LOCATION);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<ParkingScanResult | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [queueMessage, setQueueMessage] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    if (!profile?.id || !profile.organizationId) return;
    try {
      setLoadingHistory(true);
      setHistoryError(null);
      const [recordsResponse, zonesResponse] = await Promise.all([
        supabase
          .from('parking_chalk_records')
          .select('id, plate, chalked_at, return_by, status, location_name, zone_id')
          .eq('officer_id', profile.id)
          .order('chalked_at', { ascending: false })
          .limit(8),
        supabase
          .from('location_zones')
          .select('id, name')
          .eq('organization_id', profile.organizationId)
          .eq('module_key', 'parking_enforcement')
          .order('name'),
      ]);
      if (recordsResponse.error) throw recordsResponse.error;
      if (zonesResponse.error) throw zonesResponse.error;
      setRecords((recordsResponse.data as ChalkRecord[]) ?? []);
      setZones((zonesResponse.data as ZoneOption[]) ?? []);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : 'Recent scans could not be loaded.');
    } finally {
      setLoadingHistory(false);
    }
  }, [profile?.id, profile?.organizationId]);

  const refreshQueueCount = useCallback(async () => {
    try {
      setQueuedCount((await listQueuedOfficerScans()).length);
    } catch {
      setQueueMessage('Offline storage is unavailable on this device.');
    }
  }, []);

  const acquireLocation = useCallback(async () => {
    setLocation(INITIAL_LOCATION);
    try {
      const position = await getCurrentPosition();
      setLocation({ status: 'ready', latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy, message: `Location ready · ±${Math.round(position.coords.accuracy)} m` });
    } catch {
      setLocation({ status: 'unavailable', latitude: null, longitude: null, accuracy: null, message: 'Location unavailable · choose a zone' });
    }
  }, []);

  const syncQueuedScans = useCallback(async () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    setSyncing(true);
    setQueueMessage(null);
    try {
      const queuedScans = await listQueuedOfficerScans();
      let synced = 0;
      for (const scan of queuedScans) {
        if (scan.body.module_key !== 'parking_enforcement') continue;
        const { error } = await supabase.functions.invoke('process-officer-scan', { body: { ...scan.body, synced_at: new Date().toISOString() } });
        if (error) {
          await markQueuedOfficerScanAttempt(scan);
          continue;
        }
        await removeQueuedOfficerScan(scan.id);
        synced += 1;
      }
      await refreshQueueCount();
      if (synced > 0) {
        setQueueMessage(`${synced} queued scan${synced === 1 ? '' : 's'} synced.`);
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

  const payload = useMemo(
    () => buildOfficerScanPayload({ plateNumber, imageBase64, latitude: location.latitude, longitude: location.longitude, zoneId, capturedAt, moduleKey: 'parking_enforcement' }),
    [capturedAt, imageBase64, location.latitude, location.longitude, plateNumber, zoneId],
  );

  const clearCapture = useCallback(() => {
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    setImagePreviewUrl(undefined);
    setImageBase64(undefined);
    setCapturedAt(undefined);
    setPlateNumber('');
    setSubmitError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [imagePreviewUrl]);

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setPreparingImage(true);
    setSubmitError(null);
    setResult(null);
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
      const { data, error } = await supabase.functions.invoke<ParkingScanResult>('process-officer-scan', { body: payload });
      if (error) throw error;
      if (!data?.chalk_record_id) throw new Error('The scan completed without a chalk record.');
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

  const verdict = result?.verdict ?? 'clear';

  return (
    <div className="page-container fc-scan-page">
      <header className="fc-scan-header">
        <div>
          <span className="fc-eyebrow">Parking enforcement</span>
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
              <span className="fc-photo-label">
                <CheckCircle2 size={15} aria-hidden="true" /> Evidence captured
              </span>
              <button type="button" className="fc-remove-photo" onClick={clearCapture} title="Remove photo">
                <X size={18} aria-hidden="true" />
                <span className="sr-only">Remove photo</span>
              </button>
            </div>
          ) : (
            <button type="button" className="fc-camera-target" onClick={() => fileInputRef.current?.click()} disabled={preparingImage}>
              <span className="fc-camera-icon">
                <Camera size={30} strokeWidth={1.7} aria-hidden="true" />
              </span>
              <strong>{preparingImage ? 'Preparing image' : 'Capture vehicle'}</strong>
              <span>Rear camera</span>
            </button>
          )}

          <div className="fc-field-grid">
            <label className="fc-field">
              <span>
                Plate number <small>optional with photo</small>
              </span>
              <div className="fc-plate-input">
                <input value={plateNumber} onChange={(event) => setPlateNumber(normalizePlate(event.target.value))} placeholder="ABC123" inputMode="text" autoCapitalize="characters" autoComplete="off" maxLength={10} />
              </div>
            </label>

            <label className="fc-field">
              <span>
                Zone <small>{location.status === 'ready' ? 'auto-detected when blank' : 'required without GPS'}</small>
              </span>
              <div className="fc-select-wrap">
                <MapPin size={17} aria-hidden="true" />
                <select value={zoneId} onChange={(event) => setZoneId(event.target.value)}>
                  <option value="">Automatic from GPS</option>
                  {zones.map((zone) => (
                    <option key={zone.id} value={zone.id}>
                      {zone.name}
                    </option>
                  ))}
                </select>
              </div>
            </label>
          </div>

          <div className={`fc-location-row location-${location.status}`}>
            <Crosshair size={17} aria-hidden="true" />
            <span>{location.message}</span>
            <button type="button" onClick={() => void acquireLocation()} disabled={location.status === 'locating'} title="Refresh location">
              <RefreshCw size={16} className={location.status === 'locating' ? 'is-spinning' : ''} aria-hidden="true" />
              <span className="sr-only">Refresh location</span>
            </button>
          </div>

          {submitError && (
            <div className="fc-error" role="alert">
              <AlertTriangle size={18} aria-hidden="true" />
              <span>{submitError}</span>
            </div>
          )}

          <button className="fc-submit" type="submit" disabled={!canSubmitOfficerScan(payload) || preparingImage || submitting}>
            {submitting ? <RefreshCw size={19} className="is-spinning" aria-hidden="true" /> : imageBase64 ? <Upload size={19} aria-hidden="true" /> : <ImagePlus size={19} aria-hidden="true" />}
            {submitting ? 'Processing scan' : 'Process scan'}
          </button>
        </form>

        <aside className="fc-result-column">
          {result ? (
            <section className={`fc-verdict verdict-${verdict === 'overstay' ? 'breach' : verdict === 'watch' ? 'at_risk' : 'compliant'}`} aria-live="polite">
              <div className="fc-verdict-topline">
                <span>{VERDICT_LABEL[verdict] ?? verdict}</span>
                <span className="fc-source">{result.plate_source === 'alpr' ? 'ALPR' : 'MANUAL'}</span>
              </div>
              <div className="fc-result-plate">{result.plate_number}</div>
              {result.zone_closed && (
                <div className="alert alert-warning" role="alert">
                  <AlertTriangle size={16} aria-hidden="true" />
                  Zone closure in force. The compliance verdict remains rule-derived.
                </div>
              )}

              <dl className="fc-metrics">
                <div>
                  <dt>Minutes elapsed</dt>
                  <dd>
                    {result.minutes_elapsed ?? '—'}
                    <small> / {result.effective_limit_minutes} min limit</small>
                  </dd>
                </div>
                <div>
                  <dt>Repeat</dt>
                  <dd>{result.is_repeat ? `Yes (${result.repeat_count})` : 'No'}</dd>
                </div>
              </dl>

              <div className="fc-result-facts">
                <span>
                  <MapPin size={15} aria-hidden="true" /> {result.zone_name ?? 'Outside a configured zone'}
                </span>
                {result.is_disabled_bay && <span>Disabled bay</span>}
                {result.vehicle_make && (
                  <span>
                    {result.vehicle_make} {result.vehicle_model ?? ''} {result.vehicle_colour ?? ''}
                  </span>
                )}
              </div>

              {result.vehicle_compliance_flags.length > 0 && (
                <div className="fc-result-facts">
                  {result.vehicle_compliance_flags.map((flag) => (
                    <span key={flag} className="badge is-alert">
                      {flag.replaceAll('_', ' ')}
                    </span>
                  ))}
                </div>
              )}

              {result.breach_alert_id && (
                <div className="alert alert-warning" role="alert">
                  <AlertTriangle size={16} aria-hidden="true" />
                  Breach alert raised — {result.is_overstay ? 'overstay' : 'vehicle compliance'} recorded for supervisor review.
                </div>
              )}

              {result.breach_write_error && (
                <div className="fc-error" role="alert">
                  <AlertTriangle size={18} aria-hidden="true" />
                  <span>Chalk record saved, but the breach alert was not confirmed. Supervisor follow-up is required.</span>
                </div>
              )}

              <button type="button" className="fc-new-scan" onClick={() => setResult(null)}>
                <Camera size={17} aria-hidden="true" /> New scan
              </button>
            </section>
          ) : (
            <section className="fc-awaiting-result">
              <ShieldCheck size={24} aria-hidden="true" />
              <div>
                <strong>Awaiting scan</strong>
                <span>Compliance status appears here after processing.</span>
              </div>
            </section>
          )}

          <section className="fc-recent">
            <div className="fc-section-heading">
              <div>
                <span className="fc-eyebrow">This shift</span>
                <h2>Recent chalk records</h2>
              </div>
              <button type="button" className="fc-icon-button" onClick={() => void loadHistory()} disabled={loadingHistory} title="Refresh recent scans">
                <RefreshCw size={17} className={loadingHistory ? 'is-spinning' : ''} aria-hidden="true" />
                <span className="sr-only">Refresh recent scans</span>
              </button>
            </div>

            {historyError && (
              <div className="fc-inline-message is-error" role="alert">
                {historyError}
              </div>
            )}
            {!loadingHistory && records.length === 0 && <p className="fc-empty">No scans recorded yet.</p>}
            <div className="fc-recent-list">
              {records.map((record) => (
                <div className="fc-recent-row" key={record.id}>
                  <span className={`fc-status-dot status-${record.status === 'active' ? 'at_risk' : record.status === 'resolved' ? 'breach' : 'compliant'}`} aria-hidden="true" />
                  <div>
                    <strong>{record.plate}</strong>
                    <span>{record.location_name ?? record.status.replaceAll('_', ' ')}</span>
                  </div>
                  <time dateTime={record.chalked_at}>{new Date(record.chalked_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
};

export default OfficerParkingPage;

