/**
 * OfficerFreedomCampingPage.tsx (Officer module: 'freedom_camping')
 *
 * Canonical schema: observations (plate_number, is_compliant,
 * compliance_reason, nights_this_zone/month, zone_id, module_key). Recording
 * a vehicle scan against a governed zone is the core freedom-camping
 * compliance workflow — the observation IS the evidence record.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface Observation {
  id: string;
  plate_number: string;
  is_compliant: boolean | null;
  compliance_reason: string | null;
  nights_this_zone: number | null;
  nights_this_month: number | null;
  observed_at: string;
}

interface ZoneOption {
  id: string;
  name: string;
}

const OfficerFreedomCampingPage: React.FC = () => {
  const { profile } = useAuth();
  const [observations, setObservations] = useState<Observation[]>([]);
  const [zones, setZones] = useState<ZoneOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    plate_number: '',
    zone_id: '',
    is_compliant: 'true',
    compliance_reason: '',
  });

  // ATLAS READS: observations, location_zones
  const loadData = useCallback(async () => {
    const orgId = profile?.organizationId;
    if (!orgId || !profile?.id) return;

    try {
      setLoading(true);
      setError(null);

      const [obsRes, zonesRes] = await Promise.all([
        supabase
          .from('observations')
          .select('id, plate_number, is_compliant, compliance_reason, nights_this_zone, nights_this_month, observed_at')
          .eq('officer_id', profile.id)
          .eq('module_key', 'freedom_camping')
          .order('observed_at', { ascending: false }),
        supabase.from('location_zones').select('id, name').eq('organization_id', orgId).eq('module_key', 'freedom_camping'),
      ]);

      if (obsRes.error) throw obsRes.error;
      if (zonesRes.error) throw zonesRes.error;

      setObservations((obsRes.data as Observation[]) || []);
      setZones((zonesRes.data as ZoneOption[]) || []);
      if (zonesRes.data && zonesRes.data.length > 0 && !form.zone_id) {
        setForm((f) => ({ ...f, zone_id: zonesRes.data[0].id }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load observations');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.organizationId, profile?.id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile?.id || !profile?.organizationId || !form.plate_number.trim()) return;

    try {
      // ATLAS WRITES: observations
      const { data, error } = await supabase
        .from('observations')
        .insert([
          {
            organization_id: profile.organizationId,
            officer_id: profile.id,
            plate_number: form.plate_number.toUpperCase(),
            zone_id: form.zone_id || null,
            is_compliant: form.is_compliant === 'true',
            compliance_reason: form.compliance_reason || null,
            module_key: 'freedom_camping',
          },
        ])
        .select()
        .single();

      if (error) throw error;
      setObservations([data as Observation, ...observations]);
      setForm({ plate_number: '', zone_id: form.zone_id, is_compliant: 'true', compliance_reason: '' });
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to record observation');
    }
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading observations...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Freedom Camping</h1>
        <p className="subtitle">{observations.length} observations recorded</p>
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
        {showForm ? 'Cancel' : '+ Record Observation'}
      </button>

      {showForm && (
        <form className="assessment-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Plate Number</label>
            <input
              type="text"
              required
              value={form.plate_number}
              onChange={(e) => setForm({ ...form, plate_number: e.target.value.toUpperCase() })}
            />
          </div>
          <div className="form-group">
            <label>Zone</label>
            <select value={form.zone_id} onChange={(e) => setForm({ ...form, zone_id: e.target.value })}>
              {zones.length === 0 && <option value="">No zones configured</option>}
              {zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Compliant</label>
            <select value={form.is_compliant} onChange={(e) => setForm({ ...form, is_compliant: e.target.value })}>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </div>
          {form.is_compliant === 'false' && (
            <div className="form-group">
              <label>Compliance Reason</label>
              <textarea
                rows={3}
                value={form.compliance_reason}
                onChange={(e) => setForm({ ...form, compliance_reason: e.target.value })}
              />
            </div>
          )}
          <button type="submit" className="btn btn-primary btn-block">
            Record Observation
          </button>
        </form>
      )}

      <div className="contacts-list" style={{ marginTop: '12px' }}>
        {observations.length === 0 ? (
          <div className="empty-state">
            <p>No observations recorded yet.</p>
          </div>
        ) : (
          observations.map((o) => (
            <div key={o.id} className="contact-card">
              <div className="contact-header">
                <h3>{o.plate_number}</h3>
                <span className={`status-badge status-${o.is_compliant ? 'active' : 'inactive'}`}>
                  {o.is_compliant === null ? 'Unknown' : o.is_compliant ? 'Compliant' : 'Non-compliant'}
                </span>
              </div>
              <div className="contact-details">
                {o.compliance_reason && <p>{o.compliance_reason}</p>}
                <p className="contact-meta">
                  {o.nights_this_zone ?? 0} night(s) this zone · {new Date(o.observed_at).toLocaleString()}
                </p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default OfficerFreedomCampingPage;
