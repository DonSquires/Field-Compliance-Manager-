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
import { formatComplianceReason } from '../lib/freedomCampingStatus';
import { supabase } from '../lib/supabase';
import { ComplianceCard } from '../components/ComplianceCard';
import { ObservationList } from '../components/ObservationList';
import { ProfessionalHeader } from '../components/ProfessionalHeader';
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
  nightly_limit_consecutive: number | null;
  nightly_limit_monthly: number | null;
  scv_required: boolean;
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
  const [recording, setRecording] = useState(false);
  const [filter, setFilter] = useState<'all' | 'breach' | 'compliant'>('all');
  const [plateFilter, setPlateFilter] = useState('');

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
        supabase
          .from('location_zones')
          .select('id, name, nightly_limit_consecutive, nightly_limit_monthly, scv_required')
          .eq('organization_id', orgId)
          .eq('module_key', 'freedom_camping')
          .eq('is_active', true)
          .order('name'),
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
      setRecording(true);
      setError(null);

      // The scan function is the proven flow that writes the observation and
      // performs overnight-session and breach-alert handling when applicable.
      const { data, error } = await supabase.functions.invoke('process-officer-scan', {
        body: {
          plate_number: form.plate_number.toUpperCase(),
          zone_id: form.zone_id,
          module_key: 'freedom_camping',
        },
      });

      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || 'Failed to record observation');

      await loadData();
      setForm({ plate_number: '', zone_id: form.zone_id });
      setVerdict(null);
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to record observation');
    } finally {
      setRecording(false);
    }
  };

  const selectedZone = zones.find((zone) => zone.id === form.zone_id);

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        <ProfessionalHeader
          title="Freedom Camping"
          subtitle="Record vehicle sightings and verify compliance"
        />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', color: 'var(--color-text-secondary)' }}>
            <div className="spinner" style={{ margin: '0 auto var(--space-4)' }} />
            <p>Loading observations...</p>
          </div>
        </div>
      </div>
    );
  }

  const breachCount = observations.filter((o) => o.is_compliant === false).length;
  const compliantCount = observations.filter((o) => o.is_compliant === true).length;
  const todayCount = observations.filter((o) => new Date(o.observed_at).toDateString() === new Date().toDateString()).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', backgroundColor: 'var(--color-bg-secondary)' }}>
      {/* Header */}
      <ProfessionalHeader
        title="Freedom Camping"
        subtitle="Record vehicle sightings and verify compliance"
        actions={
          showForm ? [] : [
            {
              label: '+ New Observation',
              onClick: () => setShowForm(true),
              variant: 'primary',
            },
          ]
        }
      />

      {/* Main content */}
      <main style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ maxWidth: '1280px', margin: '0 auto', padding: 'var(--space-8)' }}>
          {/* Error alert */}
          {error && (
            <div className="alert alert-error" style={{ marginBottom: 'var(--space-6)' }} role="alert">
              <button
                className="alert-close"
                onClick={() => setError(null)}
                aria-label="Close alert"
              >
                ×
              </button>
              {error}
            </div>
          )}

          {/* Summary cards */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
              gap: 'var(--space-4)',
              marginBottom: 'var(--space-8)',
            }}
          >
            <div className="card" style={{ borderLeft: `4px solid var(--color-primary)` }}>
              <div style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--font-bold)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-tertiary)', marginBottom: 'var(--space-2)' }}>
                Recorded Today
              </div>
              <div style={{ fontSize: 'var(--text-4xl)', fontWeight: 'var(--font-bold)', color: 'var(--color-primary)' }}>
                {todayCount}
              </div>
            </div>

            <div className="card" style={{ borderLeft: `4px solid var(--color-error)` }}>
              <div style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--font-bold)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-tertiary)', marginBottom: 'var(--space-2)' }}>
                Require Follow-up
              </div>
              <div style={{ fontSize: 'var(--text-4xl)', fontWeight: 'var(--font-bold)', color: 'var(--color-error)' }}>
                {breachCount}
              </div>
            </div>

            <div className="card" style={{ borderLeft: `4px solid var(--color-success)` }}>
              <div style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--font-bold)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-tertiary)', marginBottom: 'var(--space-2)' }}>
                Compliant Records
              </div>
              <div style={{ fontSize: 'var(--text-4xl)', fontWeight: 'var(--font-bold)', color: 'var(--color-success)' }}>
                {compliantCount}
              </div>
            </div>
          </div>

          {/* Capture form */}
          {showForm && (
            <div className="card" style={{ marginBottom: 'var(--space-8)', backgroundColor: 'var(--color-neutral-50)', border: `2px solid var(--color-primary)` }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-6)' }}>
                <div>
                  <h2 style={{ margin: '0 0 var(--space-1) 0', fontSize: 'var(--text-2xl)' }}>
                    Vehicle Observation
                  </h2>
                  <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
                    Compliance is verified before and after recording
                  </p>
                </div>
                <button
                  onClick={() => {
                    setShowForm(false);
                    setVerdict(null);
                    setCheckError(null);
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    fontSize: 'var(--text-2xl)',
                    cursor: 'pointer',
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  ✕
                </button>
              </div>

              <form
                onSubmit={handleSubmit}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 'var(--space-4)',
                  marginBottom: 'var(--space-6)',
                }}
              >
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--text-sm)', fontWeight: 'var(--font-semibold)', marginBottom: 'var(--space-2)', color: 'var(--color-text-primary)' }}>
                    Plate Number <span style={{ color: 'var(--color-error)' }}>*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={form.plate_number}
                    onChange={(e) => updateForm({ plate_number: e.target.value.toUpperCase() })}
                    placeholder="E.g., ABC123"
                    style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-lg)', fontWeight: 'var(--font-bold)' }}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: 'var(--text-sm)', fontWeight: 'var(--font-semibold)', marginBottom: 'var(--space-2)', color: 'var(--color-text-primary)' }}>
                    Zone <span style={{ color: 'var(--color-error)' }}>*</span>
                  </label>
                  <select
                    value={form.zone_id}
                    onChange={(e) => updateForm({ zone_id: e.target.value })}
                  >
                    {zones.length === 0 ? (
                      <option value="">No zones configured</option>
                    ) : (
                      zones.map((z) => (
                        <option key={z.id} value={z.id}>
                          {z.name}
                        </option>
                      ))
                    )}
                  </select>
                </div>
              </form>

              {selectedZone && (
                <div
                  style={{
                    padding: 'var(--space-4)',
                    backgroundColor: 'var(--color-bg-primary)',
                    borderRadius: 'var(--radius-md)',
                    marginBottom: 'var(--space-6)',
                    fontSize: 'var(--text-sm)',
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  <strong>Zone Rules:</strong> {selectedZone.nightly_limit_consecutive ?? 'No'} consecutive-night limit · {selectedZone.nightly_limit_monthly ?? 'No'} monthly limit {selectedZone.scv_required ? ' · SCV required' : ''}
                </div>
              )}

              {checkError && (
                <div className="alert alert-error" style={{ marginBottom: 'var(--space-6)' }} role="alert">
                  {checkError}
                </div>
              )}

              {/* Compliance verdict card */}
              {verdict && (
                <div style={{ marginBottom: 'var(--space-6)' }}>
                  <ComplianceCard
                    plate={form.plate_number}
                    verdict={verdict}
                    loading={recording}
                    onSubmit={async () => {
                      if (!profile?.id || !profile?.organizationId || !form.plate_number.trim() || !verdict) return;

                      try {
                        setRecording(true);
                        setError(null);

                        const { data, error } = await supabase.functions.invoke('process-officer-scan', {
                          body: {
                            plate_number: form.plate_number.toUpperCase(),
                            zone_id: form.zone_id,
                            module_key: 'freedom_camping',
                          },
                        });

                        if (error) throw error;
                        if (!data?.success) throw new Error(data?.error || 'Failed to record observation');

                        await loadData();
                        setForm({ plate_number: '', zone_id: form.zone_id });
                        setVerdict(null);
                        setShowForm(false);
                      } catch (err) {
                        setError(err instanceof Error ? err.message : 'Failed to record observation');
                      } finally {
                        setRecording(false);
                      }
                    }}
                  />
                </div>
              )}

              {/* Check button */}
              {!verdict && (
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ width: '100%', padding: 'var(--space-3)' }}
                  disabled={checking || !form.plate_number.trim() || !form.zone_id}
                  onClick={handleCheckCompliance}
                >
                  {checking ? 'Checking Compliance…' : 'Check Compliance'}
                </button>
              )}
            </div>
          )}

          {/* Observations list */}
          <div>
            <h2 style={{ margin: '0 0 var(--space-4) 0', fontSize: 'var(--text-2xl)', fontWeight: 'var(--font-bold)' }}>
              Recent Observations
            </h2>
            <ObservationList
              observations={observations.map((o) => ({
                ...o,
                zone_name: zones.find((z) => z.id === form.zone_id)?.name || '',
              }))}
              loading={loading}
              filter={filter}
              plateFilter={plateFilter}
              onFilterChange={setFilter}
              onPlateFilterChange={setPlateFilter}
            />
          </div>
        </div>
      </main>
    </div>
  );
};

export default OfficerFreedomCampingPage;
