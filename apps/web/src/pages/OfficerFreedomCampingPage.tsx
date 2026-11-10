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
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { useActiveModuleContext } from '../hooks/useActiveModuleContext';
import { formatComplianceReason } from '../lib/freedomCampingStatus';
import { type AddressCandidate, resolveAddressCandidates } from '../lib/locationAddress';
import {
  buildOfficerScanPayload,
  canSubmitOfficerScan,
  describeOfficerScanError,
  getCurrentPosition,
  imageFileToBase64,
  isNetworkFailure,
  listQueuedOfficerScans,
  markQueuedOfficerScanAttempt,
  type QueuedOfficerScan,
  OfficerScanResult,
  queueOfficerScan,
  removeQueuedOfficerScan,
} from '../lib/officerScan';
import { supabase } from '../lib/supabase';
import { resolveAddressForCoordinates } from '../lib/locationAddress';
import { ScanSafetyWarnings } from '../components/ScanSafetyWarnings';
import { NoticePrintActions } from '../components/NoticePrintActions';
import { GeneratedArtifactActions } from '../components/GeneratedArtifactActions';
import type { NoticeReceiptData } from '../lib/thermalReceipt';
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
  location_id?: string | null;
  organization_id?: string | null;
  module_key?: string | null;
}

interface BreachOutcome {
  id: string;
  observation_id: string;
  status: string;
  action_type: string | null;
  actioned_at: string | null;
  notes: string | null;
  requested_action: string | null;
  enforcement_mode: string | null;
  request_disposition: string | null;
}

type OfficerEnforcementAction = 'written_warning' | 'notice_to_vacate' | 'infringement';

interface OfficerEnforcementReceipt {
  alert_id: string;
  alert_status: string;
  requested_action: OfficerEnforcementAction;
  enforcement_mode: 'officer_direct' | 'admin_first' | 'hybrid';
  disposition: 'direct' | 'administrator_review';
  requested_at: string;
  next_actor: 'officer' | 'administrator';
  request_id: string;
}

type LocationState =
  | { status: 'locating'; latitude: null; longitude: null; accuracy: null; source: 'unavailable'; message: string }
  | { status: 'ready'; latitude: number; longitude: number; accuracy: number; source: 'device_gps' | 'address_candidate'; message: string }
  | { status: 'unavailable'; latitude: null; longitude: null; accuracy: null; source: 'unavailable'; message: string };

const INITIAL_LOCATION: LocationState = {
  status: 'locating',
  latitude: null,
  longitude: null,
  accuracy: null,
  source: 'unavailable',
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
  const { profile, operatingOrganizationId } = useAuth();
  const { selectedAgreement, selectedAgreementZones, selectedSite, selectedZone } = useServiceRelationships();
  const moduleContext = useActiveModuleContext('freedom_camping');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [observations, setObservations] = useState<ObservationSummary[]>([]);
  const [zones, setZones] = useState<ZoneOption[]>([]);
    const [breaches, setBreaches] = useState<BreachOutcome[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [zoneId, setZoneId] = useState('');
  const [plateNumber, setPlateNumber] = useState('');
  const [clientRequestId, setClientRequestId] = useState<string>(() => crypto.randomUUID());
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
  const [savedCaptures, setSavedCaptures] = useState<QueuedOfficerScan[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [queueMessage, setQueueMessage] = useState<string | null>(null);
  const [enforcementAction, setEnforcementAction] = useState<OfficerEnforcementAction>('written_warning');
  const [enforcementNotes, setEnforcementNotes] = useState('');
  const [enforcementBusy, setEnforcementBusy] = useState(false);
  const [enforcementError, setEnforcementError] = useState<string | null>(null);
  const [enforcementReceipt, setEnforcementReceipt] = useState<OfficerEnforcementReceipt | null>(null);
  const [enforcementRequestId, setEnforcementRequestId] = useState(() => crypto.randomUUID());
  const [noticePreview, setNoticePreview] = useState<NoticeReceiptData | null>(null);
  const [noticeReceipt, setNoticeReceipt] = useState<NoticeReceiptData | null>(null);
  const [noticeArtifactPath, setNoticeArtifactPath] = useState<string | null>(null);
  const [typedAuthorizerName, setTypedAuthorizerName] = useState('');
  const [printRequestId, setPrintRequestId] = useState(() => crypto.randomUUID());

  const loadHistory = useCallback(async () => {
    if (!profile?.id || !profile.organizationId) {
      setObservations([]);
      setZones([]);
      setBreaches([]);
      setHistoryError('Organisation access could not be confirmed. Recent scans are unavailable.');
      setLoadingHistory(false);
      return;
    }
    try {
      setLoadingHistory(true);
      setHistoryError(null);
      const activeZoneIds = selectedAgreementZones.length > 0 ? selectedAgreementZones.map((zone) => zone.id) : null;
      const [observationsResponse, zonesResponse] = await Promise.all([
        supabase
          .from('observations')
          .select('id, plate_number, compliance_status, compliance_reason, nights_this_zone, observed_at, zone_id')
          .eq('officer_id', profile.id)
          .eq('module_key', 'freedom_camping')
          .order('observed_at', { ascending: false })
          .limit(8),
        activeZoneIds && activeZoneIds.length > 0
          ? supabase.from('location_zones').select('id, name, location_id, organization_id, module_key').in('id', activeZoneIds).eq('module_key', 'freedom_camping').order('name')
          : supabase.from('location_zones').select('id, name, location_id, organization_id, module_key').eq('organization_id', profile.organizationId).eq('module_key', 'freedom_camping').order('name'),
      ]);
      if (observationsResponse.error) throw observationsResponse.error;
      if (zonesResponse.error) throw zonesResponse.error;
      const observationRows = (observationsResponse.data as ObservationSummary[]) ?? [];
      setObservations(observationRows);
      setZones((zonesResponse.data as ZoneOption[]) ?? []);
      const observationIds = observationRows.map((observation) => observation.id);
      if (observationIds.length) {
        const { data: breachRows, error: breachError } = await supabase.from('breach_alerts').select('id, observation_id, status, action_type, actioned_at, notes, requested_action, enforcement_mode, request_disposition').in('observation_id', observationIds).order('actioned_at', { ascending: false, nullsFirst: false });
        if (breachError) throw breachError;
        setBreaches((breachRows as BreachOutcome[]) ?? []);
      } else setBreaches([]);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : 'Recent scans could not be loaded.');
    } finally {
      setLoadingHistory(false);
    }
  }, [profile?.id, profile?.organizationId, selectedAgreementZones]);

  useEffect(() => {
    if (selectedZone && !zoneId) {
      setZoneId(selectedZone.id);
    }
  }, [selectedZone, zoneId]);

  useEffect(() => {
    if (requestedBreachId) {
      document.getElementById(`officer-breach-${requestedBreachId}`)?.scrollIntoView({ block: 'center' });
    }
  }, [breaches, requestedBreachId]);

  const refreshQueueCount = useCallback(async () => {
    try {
      if (!profile?.id) return;
      const scans = (await listQueuedOfficerScans(profile.id)).filter((scan) => scan.body.module_key === 'freedom_camping');
      setQueuedCount(scans.length);
      setSavedCaptures(scans);
    } catch {
      setQueueMessage('Offline storage is unavailable on this device.');
    }
  }, [profile?.id]);

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
        source: 'device_gps',
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
        source: 'unavailable',
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
      source: 'address_candidate',
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
      if (!profile?.id) return;
      const queuedScans = await listQueuedOfficerScans(profile.id);
      let synced = 0;
      let held = 0;
      for (const scan of queuedScans) {
        if (scan.body.module_key !== 'freedom_camping' || scan.status === 'needs_review') continue;
        const { error } = await supabase.functions.invoke('process-officer-scan', {
          body: { ...scan.body, synced_at: new Date().toISOString() },
        });
        if (error) {
          await markQueuedOfficerScanAttempt(scan, await describeOfficerScanError(error), !isNetworkFailure(error));
          held += 1;
          continue;
        }
        await removeQueuedOfficerScan(scan.id);
        synced += 1;
      }
      await refreshQueueCount();
      if (synced > 0 || held > 0) {
        const messages = [];
        if (synced > 0) messages.push(`${synced} queued scan${synced === 1 ? '' : 's'} synced`);
        if (held > 0) messages.push(`${held} capture${held === 1 ? '' : 's'} retained on this device for review`);
        setQueueMessage(`${messages.join('. ')}.`);
        await loadHistory();
      }
    } catch (error) {
      setQueueMessage(error instanceof Error ? error.message : 'Queued scans could not be synced.');
    } finally {
      setSyncing(false);
    }
  }, [loadHistory, profile?.id, refreshQueueCount]);

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

  const workingZone = zones.find((zone) => zone.id === zoneId)
    ?? selectedAgreementZones.find((zone) => zone.id === zoneId && zone.module_key === 'freedom_camping')
    ?? (selectedZone?.module_key === 'freedom_camping' ? selectedZone : null);
  const scanLocationId = workingZone?.location_id ?? selectedSite?.location_id ?? null;
  const scanSiteId = selectedSite?.location_id === scanLocationId ? selectedSite.id : null;
  const payload = useMemo(() => buildOfficerScanPayload({
    clientRequestId,
    operatingOrganizationId: operatingOrganizationId ?? selectedAgreement?.provider_organization_id ?? profile?.organizationId,
    locationId: scanLocationId,
    clientSiteId: scanSiteId,
    serviceAgreementId: selectedAgreement?.id,
    locationSource: location.source === 'device_gps' || location.source === 'address_candidate' ? location.source : zoneId ? 'manual_zone' : 'unavailable',
    plateNumber,
    imageBase64,
    latitude: location.latitude,
    longitude: location.longitude,
    zoneId,
    capturedAt,
  }), [capturedAt, clientRequestId, imageBase64, location.latitude, location.longitude, location.source, zoneId, plateNumber, operatingOrganizationId, profile?.organizationId, selectedAgreement, scanLocationId, scanSiteId]);

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
    await queueOfficerScan(payload, profile?.id);
    await refreshQueueCount();
    setQueueMessage('Scan saved on this device and queued for sync.');
    clearCapture();
  }, [clearCapture, payload, profile?.id, refreshQueueCount]);

  const submitScan = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmitOfficerScan(payload)) return;
    setSubmitting(true);
    setSubmitError(null);
    setResult(null);
    let stagedCapture: QueuedOfficerScan | null = null;
    try {
      stagedCapture = await queueOfficerScan(payload, profile?.id);
      await refreshQueueCount();
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        await queueCurrentScan();
        return;
      }
      const { data, error } = await supabase.functions.invoke<OfficerScanResult>('process-officer-scan', { body: payload });
      if (error) throw error;
      if (!data?.observation_id) throw new Error('The scan completed without an observation record.');
      await removeQueuedOfficerScan(stagedCapture.id);
      await refreshQueueCount();
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
        const message = await describeOfficerScanError(error);
        if (stagedCapture) {
          await markQueuedOfficerScanAttempt(stagedCapture, message, true);
          await refreshQueueCount();
        }
        setSubmitError(`${message}${stagedCapture ? ' Photo retained on this device.' : ''}`);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const status = result?.compliance_status ?? 'unknown';

  const submitEnforcementAction = async () => {
    if (!result?.breach_alert_id || !enforcementNotes.trim()) return;
    setEnforcementBusy(true);
    setEnforcementError(null);
    try {
      const { data, error } = await supabase.rpc('submit_officer_breach_action', {
        p_alert_id: result.breach_alert_id,
        p_expected_status: 'open',
        p_action: enforcementAction,
        p_notes: enforcementNotes.trim(),
        p_request_id: enforcementRequestId,
      });
      const receipt = (data as OfficerEnforcementReceipt[] | null)?.[0];
      if (error || !receipt) throw error ?? new Error('The enforcement receipt was not confirmed.');
      setEnforcementReceipt(receipt);
      await loadHistory();
    } catch (error) {
      setEnforcementError(error instanceof Error ? error.message : 'The enforcement request could not be recorded.');
    } finally {
      setEnforcementBusy(false);
    }
  };

  const beginNewScan = () => {
    setResult(null);
    setEnforcementReceipt(null);
    setEnforcementNotes('');
    setEnforcementError(null);
    setEnforcementRequestId(crypto.randomUUID());
    setNoticePreview(null);
    setNoticeReceipt(null);
    setNoticeArtifactPath(null);
    setTypedAuthorizerName('');
    setPrintRequestId(crypto.randomUUID());
  };

  const previewOfficerNotice = async () => {
    if (!result?.breach_alert_id || !enforcementReceipt || !profile?.displayName) return;
    setEnforcementBusy(true);
    setEnforcementError(null);
    const { data, error } = await supabase.functions.invoke<{ html?: string; receipt?: NoticeReceiptData }>('generate-notice', {
      body: {
        operation: 'preview',
        notice_type: enforcementReceipt.requested_action,
        breach_alert_id: result.breach_alert_id,
        officer_name: profile.displayName,
        location_name: result.zone_name,
        additional_notes: enforcementNotes,
      },
    });
    if (error || !data?.html || !data.receipt) {
      setEnforcementError(error?.message ?? 'The notice preview could not be generated.');
    } else {
      setNoticePreview(data.receipt);
      const previewUrl = URL.createObjectURL(new Blob([data.html], { type: 'text/html' }));
      window.open(previewUrl, '_blank', 'noopener,noreferrer');
      window.setTimeout(() => URL.revokeObjectURL(previewUrl), 60_000);
    }
    setEnforcementBusy(false);
  };

  const authorizeOfficerNotice = async () => {
    if (!result?.breach_alert_id || !enforcementReceipt || !profile?.displayName) return;
    setEnforcementBusy(true);
    setEnforcementError(null);
    const { data, error } = await supabase.functions.invoke<{
      pdf_url?: string;
      receipt?: NoticeReceiptData;
      authorization_receipt?: { id: string };
    }>('generate-notice', {
      body: {
        operation: 'authorize_print',
        notice_type: enforcementReceipt.requested_action,
        breach_alert_id: result.breach_alert_id,
        officer_name: profile.displayName,
        typed_name: typedAuthorizerName,
        print_request_id: printRequestId,
        location_name: result.zone_name,
        additional_notes: enforcementNotes,
      },
    });
    if (error || !data?.pdf_url || !data.receipt || !data.authorization_receipt) {
      setEnforcementError(error?.message ?? 'Print authorization was not confirmed.');
    } else {
      setNoticeReceipt(data.receipt);
      setNoticeArtifactPath(data.pdf_url);
    }
    setEnforcementBusy(false);
  };

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
      {savedCaptures.filter((scan) => scan.status === 'needs_review').map((scan) => <div className="fc-inline-message" key={scan.id}>
        <span>{scan.lastError ?? 'Saved capture needs review'}</span>
        <button type="button" className="fc-new-scan" disabled={submitting} onClick={() => {
          setImageBase64(scan.body.image_base64);
          setImagePreviewUrl(`data:image/jpeg;base64,${scan.body.image_base64}`);
          setCapturedAt(scan.body.captured_at);
          setPlateNumber(scan.body.plate_number ?? '');
          setZoneId(scan.body.zone_id ?? '');
          setClientRequestId(scan.body.client_request_id ?? scan.id);
          if ((scan.body.location_source === 'device_gps' || scan.body.location_source === 'address_candidate') && scan.body.gps_lat != null && scan.body.gps_lng != null) {
            setLocation({ status: 'ready', latitude: scan.body.gps_lat, longitude: scan.body.gps_lng, accuracy: 0, source: scan.body.location_source, message: scan.body.location_source === 'address_candidate' ? 'Saved address candidate' : 'Saved device location' });
          } else {
            setLocation({ status: 'unavailable', latitude: null, longitude: null, accuracy: null, source: 'unavailable', message: 'Saved location source is not confirmed · choose a Zone' });
          }
        }}><Search size={15} />Review saved capture</button>
      </div>)}

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
              <ScanSafetyWarnings warnings={result.safety_warnings} />
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

              {result.breach_alert_id && result.compliance_status === 'breach' && !enforcementReceipt && (
                <div className="fc-capture-panel" aria-label="Enforcement action">
                  <div className="fc-section-heading">
                    <div><span className="fc-eyebrow">Governed next action</span><h2>Record enforcement decision</h2></div>
                  </div>
                  <label className="fc-field">
                    <span>Notice action</span>
                    <select value={enforcementAction} onChange={(event) => setEnforcementAction(event.target.value as OfficerEnforcementAction)}>
                      <option value="written_warning">Written warning</option>
                      <option value="notice_to_vacate">Notice to vacate</option>
                      <option value="infringement">Infringement</option>
                    </select>
                  </label>
                  <label className="fc-field">
                    <span>Officer notes <small>required</small></span>
                    <textarea
                      value={enforcementNotes}
                      onChange={(event) => setEnforcementNotes(event.target.value)}
                      placeholder="Record contact, evidence, instruction, and expected follow-up"
                      rows={4}
                    />
                  </label>
                  <p className="fc-reason">The server checks your place and task authority, then applies this zone’s direct or administrator-review policy.</p>
                  {enforcementError && <div className="fc-error" role="alert"><AlertTriangle size={18} aria-hidden="true" /><span>{enforcementError}</span></div>}
                  <button type="button" className="fc-submit" onClick={() => void submitEnforcementAction()} disabled={enforcementBusy || !enforcementNotes.trim()}>
                    {enforcementBusy ? <RefreshCw size={19} className="is-spinning" aria-hidden="true" /> : <ShieldCheck size={19} aria-hidden="true" />}
                    {enforcementBusy ? 'Recording decision' : 'Submit governed action'}
                  </button>
                </div>
              )}

              {enforcementReceipt && (
                <div className="alert alert-success" role="status">
                  <strong>{enforcementReceipt.disposition === 'direct' ? 'Direct action recorded' : 'Administrator review requested'}</strong>
                  <p>
                    {enforcementReceipt.requested_action.replaceAll('_', ' ')} · {enforcementReceipt.enforcement_mode.replaceAll('_', ' ')}
                  </p>
                  <small>
                    Receipt {enforcementReceipt.request_id.slice(0, 8)} · Next actor: {enforcementReceipt.next_actor}
                  </small>
                </div>
              )}

              {enforcementReceipt?.disposition === 'direct' && !noticePreview && (
                <button type="button" className="fc-submit" onClick={() => void previewOfficerNotice()} disabled={enforcementBusy}>
                  Preview notice
                </button>
              )}
              {noticePreview && !noticeReceipt && (
                <div className="fc-capture-panel">
                  <p><strong>Preview opened.</strong> Confirm it is correct, then type your full profile name.</p>
                  <label className="fc-field">
                    <span>Full name</span>
                    <input value={typedAuthorizerName} onChange={(event) => setTypedAuthorizerName(event.target.value)} autoComplete="name" />
                  </label>
                  <button
                    type="button"
                    className="fc-submit"
                    onClick={() => void authorizeOfficerNotice()}
                    disabled={enforcementBusy || typedAuthorizerName !== profile?.displayName}
                  >
                    Authorize Print
                  </button>
                </div>
              )}
              {noticeReceipt && (
                <NoticePrintActions receipt={noticeReceipt} organizationId={profile?.organizationId ?? null} />
              )}
              {noticeArtifactPath && (
                <GeneratedArtifactActions bucket="notice-artifacts" path={noticeArtifactPath} fileName={`notice-${noticeReceipt?.noticeNumber ?? result.breach_alert_id}.pdf`} label="Notice PDF" />
              )}

              <button type="button" className="fc-new-scan" onClick={beginNewScan}><Camera size={17} aria-hidden="true" /> New scan</button>
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
          {breaches.length > 0 && <section className="fc-recent"><div className="fc-section-heading"><div><span className="fc-eyebrow">Enforcement receipts</span><h2>Breach outcomes</h2></div></div><div className="fc-recent-list">{breaches.map((breach) => <article id={`officer-breach-${breach.id}`} className={`fc-breach-outcome ${breach.id === requestedBreachId ? 'is-context-focus' : ''}`} key={breach.id}><div><strong>{breach.request_disposition === 'administrator_review' && breach.status === 'acknowledged' ? 'Awaiting administrator review' : `Outcome · ${breach.status.replaceAll('_', ' ')}`}</strong><span>{(breach.action_type ?? breach.requested_action)?.replaceAll('_', ' ') ?? 'Review decision'}</span></div>{breach.enforcement_mode && <p>Policy: {breach.enforcement_mode.replaceAll('_', ' ')}</p>}{breach.notes && <p>{breach.notes}</p>}<small>Alert {breach.id.slice(0, 8)}{breach.actioned_at ? ` · ${new Date(breach.actioned_at).toLocaleString('en-NZ')}` : ''}</small></article>)}</div></section>}
        </aside>
      </div>
    </div>
  );
};

export default OfficerFreedomCampingPage;