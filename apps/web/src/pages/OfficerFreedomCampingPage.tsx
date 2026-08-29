/**
 * OfficerFreedomCampingPage.tsx (Officer module: 'freedom_camping')
 *
 * Canonical schema: observations (plate_number, is_compliant,
 * compliance_reason, nights_this_zone/month, zone_id, module_key). Recording
 * a vehicle scan against a governed zone is the core freedom-camping
 * compliance workflow — the observation IS the evidence record.
 *
 * Compliance verdict is computed server-side by calculate_vehicle_compliance
 * (Atlas-confirmed: real RPC, proven flow, currently only invoked by the
 * process-officer-scan edge function) rather than left to officer judgement —
 * the two independent counters (consecutive-night streak, monthly total) are
 * the actual product rule and cannot be guessed correctly by eye.
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

interface ComplianceVerdict {
  is_compliant: boolean;
  reason: string | null;
  nights_this_zone: number;
  nights_this_month: number;
  limit_consecutive: number | null;
  limit_monthly: number | null;
  scv_required: boolean;
  is_scv: boolean;
}

const REASON_LABEL: Record<string, string> = {
  consecutive_night_limit_exceeded: 'Consecutive night limit exceeded',
  monthly_limit_exceeded: 'Monthly night limit exceeded',
};

const OfficerFreedomCampingPage: React.FC = () => {
  const { profile } = useAuth();
  const [observations, setObservations] = useState<Observation[]>([]);
  const [zones, setZones] = useState<ZoneOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ plate_number: '', zone_id: '' });
  const [verdict, setVerdict] = useState<ComplianceVerdict | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

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

  // ATLAS CALLS: calculate_vehicle_compliance (RPC) — the actual compliance
  // engine (consecutive-night streak + monthly total, two independent
  // counters). Confirmed callable by 'authenticated' role in schema.sql.
  const handleCheckCompliance = async () => {
    if (!profile?.organizationId || !form.plate_number.trim() || !form.zone_id) return;

    try {
      setChecking(true);
      setCheckError(null);
      setVerdict(null);

      const { data, error } = await supabase.rpc('calculate_vehicle_compliance', {
        p_plate: form.plate_number.toUpperCase(),
        p_zone_id: form.zone_id,
        p_org_id: profile.organizationId,
      });

      if (error) throw error;
      setVerdict(data as ComplianceVerdict);
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : 'Failed to check compliance');
    } finally {
      setChecking(false);
    }
  };

  // Any change to plate/zone invalidates a previously-computed verdict so a
  // stale result can never be submitted against a different vehicle/zone.
  const updateForm = (next: Partial<typeof form>) => {
    setForm((f) => ({ ...f, ...next }));
    setVerdict(null);
    setCheckError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile?.id || !profile?.organizationId || !form.plate_number.trim() || !verdict) return;

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
            is_compliant: verdict.is_compliant,
            compliance_reason: verdict.reason,
            nights_this_zone: verdict.nights_this_zone,
            nights_this_month: verdict.nights_this_month,
            is_scv: verdict.is_scv,
            module_key: 'freedom_camping',
          },
        ])
        .select()
        .single();

      if (error) throw error;
      setObservations([data as Observation, ...observations]);
      setForm({ plate_number: '', zone_id: form.zone_id });
      setVerdict(null);
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
              onChange={(e) => updateForm({ plate_number: e.target.value.toUpperCase() })}
            />
          </div>
          <div className="form-group">
            <label>Zone</label>
            <select value={form.zone_id} onChange={(e) => updateForm({ zone_id: e.target.value })}>
              {zones.length === 0 && <option value="">No zones configured</option>}
              {zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            className="btn btn-secondary"
            disabled={checking || !form.plate_number.trim() || !form.zone_id}
            onClick={handleCheckCompliance}
          >
            {checking ? 'Checking…' : 'Check Compliance'}
          </button>

          {checkError && (
            <div className="alert alert-error" role="alert">
              {checkError}
            </div>
          )}

          {verdict && (
            <div className="assessment-card">
              <div className="assessment-header">
                <span className={`badge ${verdict.is_compliant ? 'badge-success' : 'badge-danger'}`}>
                  {verdict.is_compliant ? 'Compliant' : 'Breach'}
                </span>
                {verdict.is_scv && <span className="badge badge-info">SCV</span>}
              </div>
              <p className="contact-meta">
                {verdict.nights_this_zone} night(s) this zone
                {verdict.limit_consecutive !== null ? ` (limit ${verdict.limit_consecutive})` : ''} ·{' '}
                {verdict.nights_this_month} night(s) this month
                {verdict.limit_monthly !== null ? ` (limit ${verdict.limit_monthly})` : ''}
              </p>
              {verdict.reason && <p className="contact-meta">{REASON_LABEL[verdict.reason] ?? verdict.reason}</p>}
            </div>
          )}

          <button type="submit" className="btn btn-primary btn-block" disabled={!verdict}>
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
