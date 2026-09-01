/**
 * OfficerEmsDevicePage.tsx (Officer module: 'ems')
 *
 * Canonical schema: ems_devices (electronic monitoring devices fitted to
 * participants under bail/sentence supervision), ems_device_checks,
 * ems_alerts. Previously this module fell back to the generic
 * OfficerFieldReportPage with no device context at all.
 *
 * ems_devices/ems_device_checks/ems_alerts are SELECT-only under RLS, so
 * writes go through submit_ems_device_check(), which also auto-raises a
 * critical ems_alerts row and flags the device when tamper is observed.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface EmsDevice {
  id: string;
  device_serial: string;
  anchor_address: string | null;
  status: string;
}

interface GpsState {
  status: 'idle' | 'locating' | 'captured' | 'unavailable';
  lat: number | null;
  lng: number | null;
}

const emptyForm = {
  signal_quality: 'strong',
  physical_condition: '',
  participant_present: true,
  tamper_observed: false,
  notes: '',
};

const OfficerEmsDevicePage: React.FC = () => {
  const { profile } = useAuth();
  const [devices, setDevices] = useState<EmsDevice[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [form, setForm] = useState(emptyForm);
  const [gps, setGps] = useState<GpsState>({ status: 'idle', lat: null, lng: null });
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  // ATLAS READS: ems_devices
  const load = useCallback(async () => {
    if (!profile?.organizationId) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase
      .from('ems_devices')
      .select('id, device_serial, anchor_address, status')
      .eq('organization_id', profile.organizationId)
      .eq('status', 'active')
      .order('device_serial')
      .limit(200);
    if (err) setError(err.message);
    else setDevices((data as EmsDevice[]) ?? []);
    setLoading(false);
  }, [profile?.organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const acquireGps = () => {
    if (!navigator.geolocation) {
      setGps({ status: 'unavailable', lat: null, lng: null });
      return;
    }
    setGps({ status: 'locating', lat: null, lng: null });
    navigator.geolocation.getCurrentPosition(
      (position) => setGps({ status: 'captured', lat: position.coords.latitude, lng: position.coords.longitude }),
      () => setGps({ status: 'unavailable', lat: null, lng: null }),
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 8_000 },
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedId || submitting) return;
    setSubmitting(true);
    setError(null);
    setReceipt(null);

    // ATLAS WRITES: ems_device_checks, ems_alerts (via submit_ems_device_check)
    const { data, error: err } = await supabase.rpc('submit_ems_device_check', {
      p_device_id: selectedId,
      p_signal_quality: form.signal_quality,
      p_physical_condition: form.physical_condition || null,
      p_participant_present: form.participant_present,
      p_tamper_observed: form.tamper_observed,
      p_notes: form.notes.trim() || null,
      p_gps_lat: gps.lat,
      p_gps_lng: gps.lng,
    });

    if (err) {
      setError(err.message);
    } else {
      const result = (data as Array<{ id: string; alert_id: string | null }> | null)?.[0];
      setReceipt(result?.alert_id ? 'Check recorded. Tamper alert raised — respond immediately.' : 'Device check recorded.');
      setForm(emptyForm);
      setGps({ status: 'idle', lat: null, lng: null });
      if (form.tamper_observed) await load();
    }
    setSubmitting(false);
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading EMS devices...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>EMS Device Check</h1>
        <p className="subtitle">{devices.length} active device(s)</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}
      {receipt && <div className="alert alert-success">{receipt}</div>}

      <form className="assessment-form" onSubmit={handleSubmit}>
        <div className="form-group">
          <label>Device</label>
          <select required value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
            <option value="">Select a device…</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.device_serial} {d.anchor_address ? `· ${d.anchor_address}` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label>Signal quality</label>
          <select value={form.signal_quality} onChange={(e) => setForm({ ...form, signal_quality: e.target.value })}>
            <option value="strong">Strong</option>
            <option value="weak">Weak</option>
            <option value="no_signal">No signal</option>
          </select>
        </div>
        <div className="form-group">
          <label>Physical condition</label>
          <input value={form.physical_condition} onChange={(e) => setForm({ ...form, physical_condition: e.target.value })} placeholder="e.g. strap intact, casing undamaged" />
        </div>
        <div className="form-group">
          <label>
            <input type="checkbox" checked={form.participant_present} onChange={(e) => setForm({ ...form, participant_present: e.target.checked })} /> Participant present
          </label>
        </div>
        <div className="form-group">
          <label>
            <input type="checkbox" checked={form.tamper_observed} onChange={(e) => setForm({ ...form, tamper_observed: e.target.checked })} /> Tamper observed
          </label>
        </div>
        <div className="form-group">
          <label>Notes</label>
          <textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </div>
        <div className={`officer-report-gps state-${gps.status}`}>
          <strong>{gps.status === 'captured' ? 'GPS captured' : gps.status === 'locating' ? 'Locating' : gps.status === 'unavailable' ? 'GPS unavailable' : 'Add GPS evidence'}</strong>
          <button type="button" className="btn btn-secondary btn-sm" onClick={acquireGps} disabled={gps.status === 'locating'}>
            {gps.status === 'captured' ? 'Refresh' : 'Capture'}
          </button>
        </div>
        <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
          {submitting ? 'Submitting…' : 'Submit Check'}
        </button>
      </form>
    </div>
  );
};

export default OfficerEmsDevicePage;
