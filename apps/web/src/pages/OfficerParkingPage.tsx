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

const OfficerParkingPage: React.FC = () => {
  const { profile } = useAuth();
  const [records, setRecords] = useState<ChalkRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ plate: '', location_name: '', return_hours: '2' });
  const [submitting, setSubmitting] = useState(false);

  // ATLAS READS: parking_chalk_records
  const loadRecords = useCallback(async () => {
    if (!profile?.id) return;
    try {
      setLoading(true);
      setError(null);

      const { data, error: err } = await supabase
        .from('parking_chalk_records')
        .select('id, plate, chalked_at, return_by, status, location_name, notes')
        .eq('officer_id', profile.id)
        .order('chalked_at', { ascending: false });

      if (err) throw err;
      setRecords((data as ChalkRecord[]) || []);
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
      const returnBy = new Date(Date.now() + parseFloat(form.return_hours) * 60 * 60 * 1000).toISOString();

      // ATLAS WRITES: parking_chalk_records
      const { data, error } = await supabase
        .from('parking_chalk_records')
        .insert([
          {
            organization_id: profile.organizationId,
            officer_id: profile.id,
            plate: form.plate.toUpperCase(),
            location_name: form.location_name || null,
            return_by: returnBy,
            status: 'active',
          },
        ])
        .select()
        .single();

      if (error) throw error;
      setRecords([data as ChalkRecord, ...records]);
      setForm({ plate: '', location_name: '', return_hours: '2' });
      setShowForm(false);
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
            <label htmlFor="parking-location">Location</label>
            <input id="parking-location" type="text" value={form.location_name} onChange={(e) => setForm({ ...form, location_name: e.target.value })} />
          </div>
          <div className="form-group">
            <label htmlFor="parking-return-hours">Return check in (hours)</label>
            <input
              id="parking-return-hours"
              type="number"
              min="0.5"
              max="24"
              step="0.5"
              value={form.return_hours}
              onChange={(e) => setForm({ ...form, return_hours: e.target.value })}
            />
          </div>
          <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
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
