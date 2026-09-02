import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Camera, CheckCircle2, Crosshair, RefreshCw, ScanLine, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import {
  buildOfficerScanPayload,
  canSubmitOfficerScan,
  getCurrentPosition,
  imageFileToBase64,
  normalizePlate,
} from '../lib/officerScan';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface ChalkRecord {
  id: string;
  plate: string;
  chalked_at: string;
  return_by: string;
  status: string;
  location_name: string | null;
  zone_id: string | null;
  effective_time_limit_minutes: number | null;
  rego_status: string | null;
  wof_status: string | null;
  cof_status: string | null;
  infringement_number: string | null;
}

interface ParkingScanResult {
  success: boolean;
  chalk_record_id: string;
  plate_number: string;
  plate_source: 'alpr' | 'manual';
  verdict: string;
  recommended_action: string;
  zone_name: string | null;
  effective_limit_minutes: number;
  grace_period_minutes: number;
  rego_status: string;
  wof_status: string;
  cof_status: string;
  breach_write_error?: string;
}

const OfficerParkingPage: React.FC = () => {
  const { profile } = useAuth();
  const relationships = useServiceRelationships();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [records, setRecords] = useState<ChalkRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [preparingImage, setPreparingImage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plateNumber, setPlateNumber] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [imageBase64, setImageBase64] = useState<string>();
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [capturedAt, setCapturedAt] = useState<string>();
  const [location, setLocation] = useState<{ status: 'locating' | 'ready' | 'unavailable'; lat: number | null; lng: number | null; accuracy: number | null }>({ status: 'locating', lat: null, lng: null, accuracy: null });
  const [receipt, setReceipt] = useState<ParkingScanResult | null>(null);

  const loadRecords = useCallback(async () => {
    if (!profile?.id) return;
    try {
      setLoading(true);
      setError(null);
      const { data, error: queryError } = await supabase
        .from('parking_chalk_records')
        .select('id, plate, chalked_at, return_by, status, location_name, zone_id, effective_time_limit_minutes, rego_status, wof_status, cof_status, infringement_number')
        .eq('officer_id', profile.id)
        .order('chalked_at', { ascending: false })
        .limit(100);
      if (queryError) throw queryError;
      setRecords((data as ChalkRecord[]) ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load parking records.');
    } finally {
      setLoading(false);
    }
  }, [profile?.id]);

  const acquireLocation = useCallback(async () => {
    setLocation({ status: 'locating', lat: null, lng: null, accuracy: null });
    try {
      const position = await getCurrentPosition();
      setLocation({ status: 'ready', lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy });
    } catch {
      setLocation({ status: 'unavailable', lat: null, lng: null, accuracy: null });
    }
  }, []);

  useEffect(() => {
    void loadRecords();
    void acquireLocation();
  }, [acquireLocation, loadRecords]);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const parkingZones = useMemo(
    () => relationships.zones.filter((zone) => zone.zone_type === 'parking' && zone.is_active),
    [relationships.zones],
  );
  const payload = useMemo(() => buildOfficerScanPayload({
    plateNumber,
    imageBase64,
    latitude: location.lat,
    longitude: location.lng,
    zoneId,
    capturedAt,
    moduleKey: 'parking_enforcement',
  }), [capturedAt, imageBase64, location.lat, location.lng, plateNumber, zoneId]);

  const clearEvidence = useCallback(() => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(undefined);
    setImageBase64(undefined);
    setCapturedAt(undefined);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [previewUrl]);

  const handleImage = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setPreparingImage(true);
    setError(null);
    try {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(file));
      setImageBase64(await imageFileToBase64(file));
      setCapturedAt(new Date().toISOString());
    } catch (imageError) {
      clearEvidence();
      setError(imageError instanceof Error ? imageError.message : 'The image could not be prepared.');
    } finally {
      setPreparingImage(false);
    }
  };

  const submitScan = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmitOfficerScan(payload)) return;
    setSubmitting(true);
    setError(null);
    setReceipt(null);
    try {
      const { data, error: invokeError } = await supabase.functions.invoke<ParkingScanResult>('process-officer-scan', { body: payload });
      if (invokeError) throw invokeError;
      if (!data?.success || !data.chalk_record_id) throw new Error('The scan did not return a confirmed Parking record.');
      setReceipt(data);
      setPlateNumber('');
      clearEvidence();
      await loadRecords();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'The Parking scan could not be processed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page-container">
      <header className="page-header"><h1>Parking</h1><p className="subtitle">Place-bound vehicle evidence and compliance checks</p></header>
      {error && <div className="alert alert-error" role="alert"><AlertTriangle size={18} /> {error}<button className="alert-close" onClick={() => setError(null)} aria-label="Close alert"><X size={16} /></button></div>}

      <div className="parking-workspace">
        <form className="assessment-form parking-capture" onSubmit={submitScan}>
          <input ref={fileInputRef} className="sr-only" type="file" accept="image/*" capture="environment" onChange={handleImage} />
          <div className="form-section-header"><ScanLine size={20} /><div><h2>Vehicle observation</h2><p>Rule timing and compliance are determined from the configured zone.</p></div></div>
          {previewUrl ? <div className="parking-photo-preview"><img src={previewUrl} alt="Parking evidence preview" /><span><CheckCircle2 size={16} /> Evidence ready</span><button type="button" onClick={clearEvidence} title="Remove image"><X size={18} /><span className="sr-only">Remove image</span></button></div> : <button type="button" className="parking-camera-button" onClick={() => fileInputRef.current?.click()} disabled={preparingImage}><Camera size={28} /><span>{preparingImage ? 'Preparing image' : 'Capture vehicle evidence'}</span></button>}
          <div className="form-grid form-grid-2">
            <div className="form-group"><label htmlFor="parking-plate">Plate number <small>optional with photo</small></label><input id="parking-plate" value={plateNumber} onChange={(event) => setPlateNumber(normalizePlate(event.target.value))} placeholder="ABC123" autoCapitalize="characters" maxLength={10} /></div>
            <div className="form-group"><label htmlFor="parking-zone">Parking zone</label><select id="parking-zone" value={zoneId} onChange={(event) => setZoneId(event.target.value)}><option value="">Automatic from GPS</option>{parkingZones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></div>
          </div>
          <div className={`parking-location location-${location.status}`}><Crosshair size={17} /><span>{location.status === 'ready' ? `GPS ready, accuracy ${Math.round(location.accuracy ?? 0)} m` : location.status === 'locating' ? 'Acquiring GPS' : 'GPS unavailable, select a configured zone'}</span><button type="button" onClick={() => void acquireLocation()} disabled={location.status === 'locating'} title="Refresh location"><RefreshCw size={16} /><span className="sr-only">Refresh location</span></button></div>
          <button type="submit" className="btn btn-primary btn-block" disabled={!canSubmitOfficerScan(payload) || submitting || preparingImage}>{submitting ? 'Processing observation...' : 'Process Parking observation'}</button>
        </form>

        <section className="parking-receipt" aria-live="polite">
          {receipt ? <><div className="parking-receipt-heading"><CheckCircle2 size={22} /><div><span>Confirmed record</span><strong>{receipt.plate_number}</strong></div><span className={`status-badge status-${receipt.verdict}`}>{receipt.verdict.replaceAll('_', ' ')}</span></div><dl><div><dt>Zone</dt><dd>{receipt.zone_name ?? 'GPS-matched area'}</dd></div><div><dt>Rule</dt><dd>{receipt.effective_limit_minutes} min + {receipt.grace_period_minutes} min grace</dd></div><div><dt>Action</dt><dd>{receipt.recommended_action.replaceAll('_', ' ')}</dd></div><div><dt>Vehicle</dt><dd>Rego {receipt.rego_status} · WoF {receipt.wof_status} · CoF {receipt.cof_status}</dd></div></dl>{receipt.breach_write_error && <div className="alert alert-error">Record saved, but its breach alert was not confirmed.</div>}</> : <div className="empty-state"><ScanLine size={25} /><p>The confirmed compliance receipt will appear here.</p></div>}
        </section>
      </div>

      <section className="parking-history">
        <div className="section-heading"><h2>My recent observations</h2><span>{records.length}</span></div>
        {loading ? <div className="loading-state"><div className="spinner"></div><p>Loading parking records...</p></div> : records.length === 0 ? <div className="empty-state"><p>No Parking observations yet.</p></div> : <div className="contacts-list">{records.map((record) => <article key={record.id} className="contact-card"><div className="contact-header"><h3>{record.plate}</h3><span className={`status-badge status-${record.status}`}>{record.status.replaceAll('_', ' ')}</span></div><div className="contact-details"><p>{record.location_name || parkingZones.find((zone) => zone.id === record.zone_id)?.name || 'Configured parking area'}</p><p className="contact-meta">Observed {new Date(record.chalked_at).toLocaleString()} · Return by {new Date(record.return_by).toLocaleString()}</p><p className="contact-meta">Rule {record.effective_time_limit_minutes ?? '—'} min · Rego {record.rego_status ?? 'unknown'} · WoF {record.wof_status ?? 'unknown'} · CoF {record.cof_status ?? 'unknown'}</p>{record.infringement_number && <p><strong>Infringement {record.infringement_number}</strong></p>}</div></article>)}</div>}
      </section>
    </div>
  );
};

export default OfficerParkingPage;