/**
 * OfficerParkingPage.tsx (Officer module: 'parking')
 *
 * Canonical schema: parking_chalk_records (plate, chalked_at, return_by,
 * status, location_name). Officer-scoped chalk-and-return workflow for
 * parking overstay enforcement.
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Camera, CheckCircle2, MapPin, Search, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { useActiveModuleContext } from '../hooks/useActiveModuleContext';
import { type AddressCandidate, resolveAddressCandidates } from '../lib/locationAddress';
import { buildOfficerScanPayload, describeOfficerScanError, getOfficerScanRecoveryContext, imageFileToBase64, isNetworkFailure, listQueuedOfficerScans, markQueuedOfficerScanAttempt, queueOfficerScan, removeQueuedOfficerScan, type QueuedOfficerScan, type ScanSafetyWarningSummary } from '../lib/officerScan';
import { supabase } from '../lib/supabase';
import { ScanSafetyWarnings } from '../components/ScanSafetyWarnings';
import './PageStyles.css';

interface ChalkRecord {
  id: string;
  plate: string;
  chalked_at: string;
  return_by: string;
  status: string;
  location_name: string | null;
  notes: string | null;
}

interface ParkingZone {
  id: string;
  name: string;
  address: string | null;
  location_id?: string | null;
  organization_id?: string | null;
  module_key?: string | null;
  service_agreement_id?: string | null;
}

interface ParkingScanResult {
  success: boolean;
  chalk_record_id: string;
  verdict: string;
  effective_limit_minutes: number;
  recommended_action: string;
  zone_name: string | null;
  safety_warnings?: ScanSafetyWarningSummary[] | null;
  breach_write_error?: string;
}

const OfficerParkingPage: React.FC = () => {
  const { profile, operatingOrganizationId } = useAuth();
  const { zones: relationshipZones, selectedSite, selectedZone } = useServiceRelationships();
  const moduleContext = useActiveModuleContext('parking_enforcement');
  const [records, setRecords] = useState<ChalkRecord[]>([]);
  const [zones, setZones] = useState<ParkingZone[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ zone_id: '' });
  const [addressQuery, setAddressQuery] = useState('');
  const [addressCandidates, setAddressCandidates] = useState<AddressCandidate[]>([]);
  const [addressPoint, setAddressPoint] = useState<AddressCandidate | null>(null);
  const [resolvingAddress, setResolvingAddress] = useState(false);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [plateNumber, setPlateNumber] = useState('');
  const [clientRequestId, setClientRequestId] = useState<string>(() => crypto.randomUUID());
  const [capturedAt, setCapturedAt] = useState<string>();
  const [recoveryOriginalContext, setRecoveryOriginalContext] = useState<ReturnType<typeof getOfficerScanRecoveryContext>>();
  const [retryPayload, setRetryPayload] = useState<ReturnType<typeof buildOfficerScanPayload>>();
  const [savedCaptures, setSavedCaptures] = useState<QueuedOfficerScan[]>([]);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [preparingImage, setPreparingImage] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [scanWarnings, setScanWarnings] = useState<ScanSafetyWarningSummary[]>([]);

  const refreshSavedCaptures = useCallback(async () => {
    if (!profile?.id) return;
    setSavedCaptures((await listQueuedOfficerScans(profile.id)).filter((scan) => scan.body.module_key === 'parking_enforcement'));
  }, [profile?.id]);

  useEffect(() => { void refreshSavedCaptures().catch(() => setError('Device storage is unavailable. Capture cannot be submitted safely.')); }, [refreshSavedCaptures]);

  // ATLAS READS: parking_chalk_records
  const loadRecords = useCallback(async () => {
    if (!profile?.id || !profile.organizationId) {
      setRecords([]);
      setZones([]);
      setError('Organisation access could not be confirmed. Parking records are unavailable.');
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(null);

      const [{ data, error: err }, { data: zoneData, error: zoneError }] = await Promise.all([
        supabase.from('parking_chalk_records')
          .select('id, plate, chalked_at, return_by, status, location_name, notes')
          .eq('officer_id', profile.id)
          .order('chalked_at', { ascending: false }),
        supabase.from('location_zones').select('id, name, location_id, organization_id, module_key, locations(address)').eq('module_key', 'parking_enforcement').eq('is_active', true).eq('boundary_verification', 'verified').order('name'),
      ]);

      if (err) throw err;
      if (zoneError) throw zoneError;
      setRecords((data as ChalkRecord[]) || []);
      // A zone's address is its house's address.
      setZones(((zoneData as unknown as Array<{ id: string; name: string; location_id: string | null; organization_id: string; module_key: string; locations: { address: string | null } | null }>) || []).map((zone) => ({ id: zone.id, name: zone.name, address: zone.locations?.address ?? null, location_id: zone.location_id, organization_id: zone.organization_id, module_key: zone.module_key, service_agreement_id: relationshipZones.find((linked) => linked.id === zone.id)?.service_agreement_id ?? null })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load parking records');
    } finally {
      setLoading(false);
    }
  }, [profile?.id, profile?.organizationId, relationshipZones]);

  useEffect(() => {
    if (selectedZone?.module_key === 'parking_enforcement' && !form.zone_id && !recoveryOriginalContext) {
      setForm((current) => ({ ...current, zone_id: selectedZone.id }));
    }
  }, [selectedZone, form.zone_id, recoveryOriginalContext]);

  useEffect(() => {
    loadRecords();
  }, [loadRecords]);

  useEffect(() => () => { if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl); }, [imagePreviewUrl]);

  const captureVehicle = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setPreparingImage(true);
    setError(null);
    try {
      if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
      setImagePreviewUrl(URL.createObjectURL(file));
      setImageBase64(await imageFileToBase64(file));
      setCapturedAt(new Date().toISOString());
      setClientRequestId(crypto.randomUUID());
      setRecoveryOriginalContext(undefined);
      setRetryPayload(undefined);
      setPlateNumber('');
    } catch (captureError) {
      setImagePreviewUrl(null);
      setImageBase64(null);
      setError(captureError instanceof Error ? captureError.message : 'Vehicle evidence could not be prepared.');
    } finally {
      setPreparingImage(false);
    }
  };

  const clearVehicleCapture = () => {
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    setImagePreviewUrl(null);
    setImageBase64(null);
    setCapturedAt(undefined);
    setClientRequestId(crypto.randomUUID());
    setRecoveryOriginalContext(undefined);
    setRetryPayload(undefined);
    setPlateNumber('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleAddressResolve = async () => {
    setResolvingAddress(true);
    setAddressError(null);
    setAddressPoint(null);
    try {
      const candidates = await resolveAddressCandidates(addressQuery, 5);
      setAddressCandidates(candidates);
      if (candidates.length === 0) setAddressError('No address match was returned.');
      else setAddressPoint(candidates[0]);
    } catch (resolveError) {
      setAddressCandidates([]);
      setAddressError(resolveError instanceof Error ? resolveError.message : 'Address could not be resolved.');
    } finally {
      setResolvingAddress(false);
    }
  };

  const handleChalk = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile?.id || !profile?.organizationId) return;

    let stagedCapture: QueuedOfficerScan | null = null;
    let submittedPayload: ReturnType<typeof buildOfficerScanPayload> | null = null;
    try {
      setSubmitting(true);
      setError(null);
      setReceipt(null);
      const workingZone = zones.find((zone) => zone.id === form.zone_id)
        ?? relationshipZones.find((zone) => zone.id === form.zone_id && zone.module_key === 'parking_enforcement');
      const locationId = workingZone?.location_id ?? recoveryOriginalContext?.location_id ?? null;
      const siteId = locationId && selectedSite?.location_id === locationId ? selectedSite.id : null;
      const payload = retryPayload ?? buildOfficerScanPayload({
        imageBase64: imageBase64 ?? undefined, plateNumber, clientRequestId, capturedAt,
        operatingOrganizationId: recoveryOriginalContext ? recoveryOriginalContext.operating_organization_id : operatingOrganizationId ?? profile.organizationId,
        locationId,
        clientSiteId: workingZone ? siteId : recoveryOriginalContext?.client_site_id,
        serviceAgreementId: recoveryOriginalContext?.service_agreement_id,
        locationSource: recoveryOriginalContext ? form.zone_id ? 'manual_zone' : 'unavailable' : addressPoint ? 'address_candidate' : form.zone_id ? 'manual_zone' : 'unavailable',
        recoveryOriginalContext,
        zoneId: form.zone_id || undefined, latitude: addressPoint?.lat ?? null, longitude: addressPoint?.lng ?? null,
        moduleKey: 'parking_enforcement',
      });
      submittedPayload = payload;
      stagedCapture = await queueOfficerScan(payload, profile.id);
      await refreshSavedCaptures();
      if (!navigator.onLine) {
        setReceipt('Photo saved on this device. Review this capture when connected.');
        return;
      }

      // The scan function owns Zone validation, policy timing, geofence evidence,
      // compliance evaluation, and the parking_chalk_records write.
      const { data, error } = await supabase
        .functions
        .invoke<ParkingScanResult>('process-officer-scan', {
          body: payload,
        });

      if (error) throw error;
      if (!data?.success || !data.chalk_record_id) throw new Error('Parking chalk receipt was not confirmed.');
      await removeQueuedOfficerScan(stagedCapture.id);
      await refreshSavedCaptures();
      setForm({ zone_id: '' });
      setAddressQuery('');
      setAddressCandidates([]);
      setAddressPoint(null);
      clearVehicleCapture();
      setShowForm(false);
      setReceipt(`Chalk recorded for ${data.zone_name ?? 'selected Zone'}: ${data.verdict.replace(/_/g, ' ')}. Return policy: ${data.effective_limit_minutes} minutes.`);
      setScanWarnings(data.safety_warnings ?? []);
      if (data.breach_write_error) setError(data.breach_write_error);
      await loadRecords();
    } catch (err) {
      const message = await describeOfficerScanError(err);
      if (stagedCapture) {
        const transportFailure = isNetworkFailure(err);
        await markQueuedOfficerScanAttempt(stagedCapture, message, !transportFailure);
        if (transportFailure && submittedPayload) setRetryPayload(submittedPayload);
        else {
          setRetryPayload(undefined);
          setRecoveryOriginalContext(getOfficerScanRecoveryContext(stagedCapture.body));
        }
        await refreshSavedCaptures();
      }
      setError(`${message}${stagedCapture ? ' Photo retained on this device.' : ''}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleResolve = async (record: ChalkRecord) => {
    try {
      // ATLAS WRITES: parking_chalk_records
      const { error } = await supabase
        .from('parking_chalk_records')
        .update({ status: 'resolved', resolved_at: new Date().toISOString() })
        .eq('id', record.id);

      if (error) throw error;
      setRecords(records.map((r) => (r.id === record.id ? { ...r, status: 'resolved' } : r)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve record');
    }
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading parking records...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Parking</h1>
        <p className="subtitle">{records.length} chalk records</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}
      {receipt && <ScanSafetyWarnings warnings={scanWarnings} />}
      {receipt && <div className="alert alert-success" role="status">{receipt}</div>}
      {savedCaptures.map((scan) => <div className="alert" key={scan.id}>
        <span>{scan.lastError ?? 'Parking capture saved on this device.'}</span>
        <button type="button" className="btn btn-secondary btn-sm" disabled={submitting} onClick={() => {
          const original = getOfficerScanRecoveryContext(scan.body);
          setShowForm(true);
          setImageBase64(scan.body.image_base64 ?? null);
          setImagePreviewUrl(`data:image/jpeg;base64,${scan.body.image_base64}`);
          setPlateNumber(scan.body.plate_number ?? '');
          setCapturedAt(original.captured_at);
          setClientRequestId(scan.body.client_request_id ?? scan.id);
          setRecoveryOriginalContext(scan.status === 'needs_review' ? original : undefined);
          setRetryPayload(scan.status === 'needs_review' ? undefined : scan.body);
          setForm({ zone_id: scan.body.zone_id ?? '' });
          setAddressPoint(original.gps_lat != null && original.gps_lng != null ? { label: 'Saved capture coordinates', lat: original.gps_lat, lng: original.gps_lng, source: 'linz_address' } : null);
        }}><Search size={15} />Review saved capture</button>
      </div>)}

      <button className="btn btn-primary btn-sm" onClick={() => setShowForm(!showForm)}>
        {showForm ? 'Cancel' : '+ Chalk Vehicle'}
      </button>

      {showForm && (
        <form className="assessment-form" onSubmit={handleChalk}>
          <input ref={fileInputRef} className="sr-only" type="file" accept="image/*" capture="environment" onChange={captureVehicle} />
          <div className="form-group">
            <label>Vehicle evidence</label>
            {imagePreviewUrl ? <div className="scan-preview"><img src={imagePreviewUrl} alt="Vehicle evidence preview" /><span><CheckCircle2 size={15} /> Evidence ready for ALPR</span><button type="button" onClick={clearVehicleCapture} title="Remove image"><X size={18} /><span className="sr-only">Remove image</span></button></div> : <button type="button" className="scan-camera-target" onClick={() => fileInputRef.current?.click()} disabled={preparingImage}><Camera size={28} /><strong>{preparingImage ? 'Preparing image' : 'Capture vehicle'}</strong><span>Plate must be visible for ALPR</span></button>}
          </div>
          <div className="form-group">
            <label htmlFor="parking-plate">Plate (manual fallback)</label>
            <input id="parking-plate" value={plateNumber} onChange={(event) => setPlateNumber(event.target.value)} required={Boolean(recoveryOriginalContext)} autoCapitalize="characters" spellCheck={false} placeholder={recoveryOriginalContext ? 'Confirm plate for recovery' : 'Use if ALPR cannot read'} />
          </div>
          <div className="form-group">
            <label htmlFor="parking-zone">Verified parking Zone</label>
            <select id="parking-zone" value={form.zone_id} onChange={(e) => setForm({ ...form, zone_id: e.target.value })}>
              <option value="">Resolve from address</option>
              {zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}
            </select>
              {form.zone_id && zones.find((zone) => zone.id === form.zone_id)?.address && <small className="form-hint">Canonical address: {zones.find((zone) => zone.id === form.zone_id)?.address}</small>}
            {zones.length === 0 && <small className="form-hint">No verified parking Zones are available. Contact your administrator.</small>}
          </div>
          <div className="form-group">
            <label htmlFor="parking-address">Address</label>
            <div className="form-row">
              <input id="parking-address" value={addressQuery} onChange={(event) => { setAddressQuery(event.target.value); setAddressPoint(null); }} placeholder="Street address or place" />
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void handleAddressResolve()} disabled={resolvingAddress || !addressQuery.trim()}><Search size={15} />{resolvingAddress ? 'Resolving' : 'Resolve'}</button>
            </div>
            {addressPoint && <small className="form-hint"><MapPin size={13} /> {addressPoint.label}</small>}
            {addressError && <small className="form-hint">{addressError}</small>}
            {addressCandidates.length > 1 && <div className="form-row">{addressCandidates.map((candidate) => <button type="button" className="btn btn-secondary btn-sm" key={`${candidate.source}-${candidate.lat}-${candidate.lng}`} onClick={() => setAddressPoint(candidate)}>{candidate.label}</button>)}</div>}
          </div>
          <button type="submit" className="btn btn-primary btn-block" disabled={submitting || preparingImage || !imageBase64 || !form.zone_id || Boolean(recoveryOriginalContext && !plateNumber.trim())}>
            {submitting ? 'Saving chalk record' : retryPayload ? 'Retry saved request' : recoveryOriginalContext ? 'Recover saved capture' : 'Chalk Vehicle'}
          </button>
        </form>
      )}

      <div className="contacts-list" style={{ marginTop: '12px' }}>
        {records.length === 0 && !error ? (
          <div className="empty-state">
            <p>No chalk records yet.</p>
          </div>
        ) : (
          records.map((r) => (
            <div key={r.id} className="contact-card">
              <div className="contact-header">
                <h3>{r.plate}</h3>
                <span className={`status-badge status-${r.status}`}>{r.status}</span>
              </div>
              <div className="contact-details">
                <p>{r.location_name || 'no location'}</p>
                <p className="contact-meta">
                  Chalked {new Date(r.chalked_at).toLocaleString()} · Return by{' '}
                  {new Date(r.return_by).toLocaleString()}
                </p>
              </div>
              {r.status === 'active' && (
                <button className="btn btn-sm btn-secondary" onClick={() => handleResolve(r)}>
                  Mark Resolved
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default OfficerParkingPage;
