/**
 * OfficerParkingPage.tsx (Officer module: 'parking')
 *
 * Canonical schema: parking_chalk_records (plate, chalked_at, return_by,
 * status, location_name). Officer-scoped chalk-and-return workflow for
 * parking overstay enforcement.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ plate: '', zone_id: '' });
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
          .select('id, name')
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
            plate_number: form.plate.trim().toUpperCase(),
            zone_id: form.zone_id,
            module_key: 'parking_enforcement',
            captured_at: new Date().toISOString(),
          },
        });

      if (error) throw error;
      if (!data?.success || !data.chalk_record_id) throw new Error('Parking chalk receipt was not confirmed.');
      setForm({ plate: '', zone_id: '' });
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
          <div className="form-group">
            <label htmlFor="parking-plate">Plate</label>
            <input
              id="parking-plate"
              type="text"
              required
              value={form.plate}
              onChange={(e) => setForm({ ...form, plate: e.target.value.toUpperCase() })}
            />
          </div>
          <div className="form-group">
            <label htmlFor="parking-zone">Verified parking Zone</label>
            <select id="parking-zone" required value={form.zone_id} onChange={(e) => setForm({ ...form, zone_id: e.target.value })}>
              <option value="">Select a Zone</option>
              {zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}
            </select>
            {zones.length === 0 && <small className="form-hint">No verified parking Zones are available. Contact your administrator.</small>}
          </div>
          <button type="submit" className="btn btn-primary btn-block" disabled={submitting || zones.length === 0}>
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
