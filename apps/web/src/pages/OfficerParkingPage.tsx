/**
 * OfficerParkingPage.tsx (Officer module: 'parking')
 *
 * Canonical schema: parking_chalk_records (plate, chalked_at, return_by,
 * status, location_name). Officer-scoped chalk-and-return workflow for
 * parking overstay enforcement.
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Camera, CheckCircle2, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { imageFileToBase64 } from '../lib/officerScan';
import { supabase } from '../lib/supabase';
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
}

interface ParkingScanResult {
  success: boolean;
  chalk_record_id: string;
  verdict: string;
  effective_limit_minutes: number;
  recommended_action: string;
  zone_name: string | null;
  breach_write_error?: string;
}

const OfficerParkingPage: React.FC = () => {
  const { profile } = useAuth();
  const [records, setRecords] = useState<ChalkRecord[]>([]);
  const [zones, setZones] = useState<ParkingZone[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ zone_id: '' });
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [preparingImage, setPreparingImage] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);

  // ATLAS READS: parking_chalk_records
  const loadRecords = useCallback(async () => {
    if (!profile?.id) return;
    try {
      setLoading(true);
      setError(null);

      const [{ data, error: err }, { data: zoneData, error: zoneError }] = await Promise.all([
        supabase
        .from('parking_chalk_records')
        .select('id, plate, chalked_at, return_by, status, location_name, notes')
        .eq('officer_id', profile.id)
          .order('chalked_at', { ascending: false }),
        supabase
          .from('location_zones')
          .select('id, name, address')
          .eq('organization_id', profile.organizationId ?? '')
          .eq('module_key', 'parking_enforcement')
          .eq('is_active', true)
          .eq('boundary_verification', 'verified')
          .order('name'),
      ]);

      if (err) throw err;
      if (zoneError) throw zoneError;
      setRecords((data as ChalkRecord[]) || []);
      setZones((zoneData as ParkingZone[]) || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load parking records');
    } finally {
      setLoading(false);
    }
  }, [profile?.id]);

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
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleChalk = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile?.id || !profile?.organizationId) return;

    try {
      setSubmitting(true);
      setError(null);
      setReceipt(null);

      // The scan function owns Zone validation, policy timing, geofence evidence,
      // compliance evaluation, and the parking_chalk_records write.
      const { data, error } = await supabase
        .functions
        .invoke<ParkingScanResult>('process-officer-scan', {
          body: {
            image_base64: imageBase64,
            zone_id: form.zone_id,
            module_key: 'parking_enforcement',
            captured_at: new Date().toISOString(),
          },
        });

      if (error) throw error;
      if (!data?.success || !data.chalk_record_id) throw new Error('Parking chalk receipt was not confirmed.');
      setForm({ zone_id: '' });
      clearVehicleCapture();
      setShowForm(false);
      setReceipt(`Chalk recorded for ${data.zone_name ?? 'selected Zone'}: ${data.verdict.replace(/_/g, ' ')}. Return policy: ${data.effective_limit_minutes} minutes.`);
      if (data.breach_write_error) setError(data.breach_write_error);
      await loadRecords();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to chalk vehicle');
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
      {receipt && <div className="alert alert-success" role="status">{receipt}</div>}

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
            <label htmlFor="parking-zone">Verified parking Zone</label>
            <select id="parking-zone" required value={form.zone_id} onChange={(e) => setForm({ ...form, zone_id: e.target.value })}>
              <option value="">Select a Zone</option>
              {zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}
            </select>
              {form.zone_id && zones.find((zone) => zone.id === form.zone_id)?.address && <small className="form-hint">Canonical address: {zones.find((zone) => zone.id === form.zone_id)?.address}</small>}
            {zones.length === 0 && <small className="form-hint">No verified parking Zones are available. Contact your administrator.</small>}
          </div>
          <button type="submit" className="btn btn-primary btn-block" disabled={submitting || preparingImage || !imageBase64 || zones.length === 0}>
            {submitting ? 'Saving chalk record' : 'Chalk Vehicle'}
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
