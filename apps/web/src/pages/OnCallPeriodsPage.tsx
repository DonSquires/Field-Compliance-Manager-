/**
 * OnCallPeriodsPage.tsx (Admin CRM tab: 'oncall')
 *
 * Canonical schema: on_call_periods (admin-managed directly -- RLS already
 * grants org-admin INSERT/UPDATE/DELETE, no RPC needed), callout_shifts and
 * travel_allowances (read-only here for payroll visibility; officers write
 * them via log_callout_milestone()/submit_travel_allowance()).
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface OnCallPeriod {
  id: string;
  officer_user_id: string;
  period_type: string;
  starts_at: string;
  ends_at: string;
  flat_rate: number | null;
  status: string;
}

interface Officer {
  id: string;
  display_name: string | null;
}

interface CalloutShift {
  id: string;
  on_call_period_id: string;
  callout_received_at: string | null;
  returned_at: string | null;
}

interface TravelAllowance {
  id: string;
  callout_shift_id: string;
  journey_type: string;
  distance_km: number | null;
  rate_per_km: number | null;
}

const emptyForm = { officer_user_id: '', period_type: 'standard', starts_at: '', ends_at: '', flat_rate: '' };

const OnCallPeriodsPage: React.FC = () => {
  const { profile } = useAuth();
  const [periods, setPeriods] = useState<OnCallPeriod[]>([]);
  const [officers, setOfficers] = useState<Officer[]>([]);
  const [callouts, setCallouts] = useState<CalloutShift[]>([]);
  const [travel, setTravel] = useState<TravelAllowance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  // ATLAS READS: on_call_periods, user_profiles, callout_shifts, travel_allowances
  const load = useCallback(async () => {
    const orgId = profile?.organizationId;
    if (!orgId) return;
    setLoading(true);
    setError(null);
    const [periodResponse, officerResponse, calloutResponse, travelResponse] = await Promise.all([
      supabase.from('on_call_periods').select('id, officer_user_id, period_type, starts_at, ends_at, flat_rate, status').eq('organization_id', orgId).order('starts_at', { ascending: false }).limit(100),
      supabase.from('user_profiles').select('id, display_name').eq('organization_id', orgId).eq('role', 'officer'),
      supabase.from('callout_shifts').select('id, on_call_period_id, callout_received_at, returned_at').eq('organization_id', orgId),
      supabase.from('travel_allowances').select('id, callout_shift_id, journey_type, distance_km, rate_per_km').eq('organization_id', orgId),
    ]);
    setPeriods((periodResponse.data as OnCallPeriod[]) ?? []);
    setOfficers((officerResponse.data as Officer[]) ?? []);
    setCallouts((calloutResponse.data as CalloutShift[]) ?? []);
    setTravel((travelResponse.data as TravelAllowance[]) ?? []);
    const failures = [periodResponse.error?.message, officerResponse.error?.message, calloutResponse.error?.message, travelResponse.error?.message].filter(Boolean);
    if (failures.length) setError(failures.join(' · '));
    setLoading(false);
  }, [profile?.organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile?.organizationId || !form.officer_user_id || !form.starts_at || !form.ends_at || saving) return;
    setSaving(true);
    setError(null);

    // ATLAS WRITES: on_call_periods
    const { error: err } = await supabase.from('on_call_periods').insert([
      {
        organization_id: profile.organizationId,
        officer_user_id: form.officer_user_id,
        period_type: form.period_type,
        starts_at: new Date(form.starts_at).toISOString(),
        ends_at: new Date(form.ends_at).toISOString(),
        flat_rate: form.flat_rate ? parseFloat(form.flat_rate) : null,
      },
    ]);

    if (err) setError(err.message);
    else {
      setForm(emptyForm);
      await load();
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading on-call periods...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>On-Call Roster</h1>
        <p className="subtitle">{periods.length} on-call period(s)</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      <form className="assessment-form" onSubmit={handleCreate}>
        <div className="form-group">
          <label>Officer</label>
          <select required value={form.officer_user_id} onChange={(e) => setForm({ ...form, officer_user_id: e.target.value })}>
            <option value="">Select an officer…</option>
            {officers.map((o) => (
              <option key={o.id} value={o.id}>
                {o.display_name || o.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label>Period type</label>
          <select value={form.period_type} onChange={(e) => setForm({ ...form, period_type: e.target.value })}>
            <option value="standard">Standard</option>
            <option value="before_shift">Before shift</option>
            <option value="after_shift">After shift</option>
            <option value="overnight">Overnight</option>
          </select>
        </div>
        <div className="form-group">
          <label>Starts at</label>
          <input required type="datetime-local" value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} />
        </div>
        <div className="form-group">
          <label>Ends at</label>
          <input required type="datetime-local" value={form.ends_at} onChange={(e) => setForm({ ...form, ends_at: e.target.value })} />
        </div>
        <div className="form-group">
          <label>Flat rate ($)</label>
          <input type="number" step="0.01" value={form.flat_rate} onChange={(e) => setForm({ ...form, flat_rate: e.target.value })} />
        </div>
        <button type="submit" className="btn btn-primary btn-block" disabled={saving}>
          {saving ? 'Saving…' : 'Assign On-Call Period'}
        </button>
      </form>

      <div className="reports-table-wrapper" style={{ marginTop: '24px' }}>
        <table className="reports-table">
          <thead>
            <tr>
              <th>Officer</th>
              <th>Type</th>
              <th>Window</th>
              <th>Status</th>
              <th>Callout</th>
            </tr>
          </thead>
          <tbody>
            {periods.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-center">
                  No on-call periods
                </td>
              </tr>
            ) : (
              periods.map((period) => {
                const callout = callouts.find((c) => c.on_call_period_id === period.id);
                const claims = travel.filter((t) => t.callout_shift_id === callout?.id);
                return (
                  <tr key={period.id}>
                    <td>{officers.find((o) => o.id === period.officer_user_id)?.display_name || period.officer_user_id.slice(0, 8)}</td>
                    <td>{period.period_type.replaceAll('_', ' ')}</td>
                    <td>
                      {new Date(period.starts_at).toLocaleString()} – {new Date(period.ends_at).toLocaleString()}
                    </td>
                    <td>{period.status}</td>
                    <td>
                      {callout ? (
                        <>
                          {callout.returned_at ? 'Completed' : 'In progress'}
                          {claims.length > 0 && ` · ${claims.length} travel claim(s)`}
                        </>
                      ) : (
                        '-'
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default OnCallPeriodsPage;
