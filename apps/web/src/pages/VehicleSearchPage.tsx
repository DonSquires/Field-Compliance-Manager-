/**
 * VehicleSearchPage.tsx (Admin field-ops sub-area: 'vehicle-search')
 *
 * Canonical schema:
 * - canonical_vehicle_public (plate registry projection: rego/wof/cof status,
 *   homeless_status signal; canonical_vehicles itself stays Bob-only)
 * - canonical_scv_public (NZSCV certification status)
 * - entity_flags (this organisation's own of-interest flags, RLS-scoped) via
 *   raise_entity_flag / resolve_entity_flag (governed, audited)
 * - get_safety_warnings (platform-wide, redacted H&S warnings)
 * - observations (scan/observation history with zone context)
 * - breach_alerts (compliance breaches recorded for this vehicle)
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SafetyWarningsPanel } from '../components/SafetyWarningsPanel';
import { useAuth } from '../context/AuthContext';
import { normalizePlateNumber, vehicleHistoryOrFilter } from '../lib/canonicalIdentity';
import { supabase } from '../lib/supabase';
import './PageStyles.css';
import './VehicleSearchPage.css';

interface Vehicle {
  id: string;
  plate_number: string;
  make: string | null;
  model: string | null;
  year: number | null;
  colour: string | null;
  body_type: string | null;
  rego_status: string | null;
  rego_expiry: string | null;
  wof_status: string | null;
  wof_expiry: string | null;
  cof_status: string | null;
  cof_expiry: string | null;
  homeless_status: string;
  external_data_source_name: string | null;
  external_data_source_url: string | null;
  external_data_source_location: string | null;
  external_data_source_checked_at: string | null;
}

interface ScvRecord {
  id: string;
  certificate_number: string | null;
  certificate_status: string;
  expiry_date: string | null;
  issued_date: string | null;
}

interface EntityFlag {
  id: string;
  flag_type: string;
  alert_level: string | null;
  reason: string | null;
  active: boolean;
  raised_at: string;
}

interface RecentObservation {
  id: string;
  observed_at: string;
  is_compliant: boolean | null;
  compliance_reason: string | null;
  nights_this_zone: number | null;
  zone_name: string | null;
}

interface VehicleBreach {
  id: string;
  breach_type: string;
  status: string;
  nights_count: number | null;
  notes: string | null;
  created_at: string;
  zone_name: string | null;
}

interface PermitRecord {
  id: string;
  holder_name: string | null;
  permit_number: string;
  permit_type: string | null;
  forest_areas: string[] | null;
  date_from: string | null;
  date_to: string | null;
  status: string;
  firearm_licence_valid: boolean | null;
  conditions: string | null;
  vehicle_plates: string[] | null;
}

const VehicleSearchPage: React.FC = () => {
  const { profile } = useAuth();
  const [searchParams] = useSearchParams();
  const [plate, setPlate] = useState('');
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [scv, setScv] = useState<ScvRecord | null>(null);
  const [flags, setFlags] = useState<EntityFlag[]>([]);
  const [observations, setObservations] = useState<RecentObservation[]>([]);
  const [breaches, setBreaches] = useState<VehicleBreach[]>([]);
  const [permits, setPermits] = useState<PermitRecord[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFlagForm, setShowFlagForm] = useState(false);
  const [flagForm, setFlagForm] = useState({ flag_type: 'watchlist', alert_level: 'medium', reason: '' });

  const searchVehicle = useCallback(async (plateInput: string, canonicalVehicleId?: string) => {
    const cleanPlate = normalizePlateNumber(plateInput);
    if (!cleanPlate && !canonicalVehicleId) return;
    try {
      setLoading(true);
      setError(null);
      setSearched(true);

      // ATLAS READS: canonical_vehicle_public, canonical_scv_public, person_permits_fieldwork, observations, breach_alerts
      // Resolve the canonical vehicle first so observation history follows the
      // global identity link, not only the plate text recorded at scan time.
      let vehicleQuery = supabase
        .from('canonical_vehicle_public')
        .select('id, plate_number, make, model, year, colour, body_type, rego_status, rego_expiry, wof_status, wof_expiry, cof_status, cof_expiry, homeless_status, external_data_source_name, external_data_source_url, external_data_source_location, external_data_source_checked_at');
      vehicleQuery = canonicalVehicleId
        ? vehicleQuery.eq('id', canonicalVehicleId)
        : vehicleQuery.ilike('plate_number', cleanPlate);
      const vehRes = await vehicleQuery.maybeSingle();
      if (vehRes.error) throw vehRes.error;
      const vehData = vehRes.data as Vehicle | null;
      if (canonicalVehicleId && !vehData) throw new Error('The linked canonical vehicle is unavailable or you do not have access.');
      const resolvedPlate = normalizePlateNumber(vehData?.plate_number ?? cleanPlate);
      if (vehData?.plate_number) setPlate(vehData.plate_number);

      const historyFilter = vehicleHistoryOrFilter(resolvedPlate, vehData?.id ?? canonicalVehicleId ?? null);
      const [scvRes, permitRes, obsRes, breachRes] = await Promise.all([
        supabase
          .from('canonical_scv_public')
          .select('id, certificate_number, certificate_status, expiry_date, issued_date')
          .ilike('plate_number', resolvedPlate)
          .maybeSingle(),
        supabase
          .from('person_permits_fieldwork')
          .select('id, holder_name, permit_number, permit_type, forest_areas, date_from, date_to, status, firearm_licence_valid, conditions, vehicle_plates')
          .contains('vehicle_plates', [resolvedPlate])
          .order('date_to', { ascending: false }),
        supabase
          .from('observations')
          .select('id, observed_at, is_compliant, compliance_reason, nights_this_zone, zone:zone_id(name)')
          .or(historyFilter)
          .order('observed_at', { ascending: false })
          .limit(10),
        supabase
          .from('breach_alerts')
          .select('id, breach_type, status, nights_count, notes, created_at, zone:location_zones!breach_alerts_zone_id_fkey(name)')
          .ilike('plate_number', resolvedPlate)
          .order('created_at', { ascending: false })
          .limit(10),
      ]);

      if (permitRes.error) throw permitRes.error;
      setVehicle(vehData);
      setScv((scvRes.data as ScvRecord) || null);
      setPermits((permitRes.data as PermitRecord[]) || []);

      setObservations(
        ((obsRes.data as any[]) || []).map((row) => ({
          id: row.id,
          observed_at: row.observed_at,
          is_compliant: row.is_compliant,
          compliance_reason: row.compliance_reason,
          nights_this_zone: row.nights_this_zone,
          zone_name: row.zone?.name ?? null,
        }))
      );

      setBreaches(
        ((breachRes.data as any[]) || []).map((row) => ({
          id: row.id,
          breach_type: row.breach_type,
          status: row.status,
          nights_count: row.nights_count,
          notes: row.notes,
          created_at: row.created_at,
          zone_name: row.zone?.name ?? null,
        }))
      );

      if (vehData) {
        // ATLAS READS: entity_flags — this organisation's own of-interest flags (safety warnings are shown by SafetyWarningsPanel)
        const { data: flagData, error: flagErr } = await supabase
          .from('entity_flags')
          .select('id, flag_type, alert_level, reason, active, raised_at')
          .eq('entity_type', 'vehicle')
          .eq('entity_id', vehData.id)
          .is('hazard_class', null)
          .order('raised_at', { ascending: false });

        if (flagErr) throw flagErr;
        setFlags((flagData as EntityFlag[]) || []);
      } else {
        setFlags([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to search vehicle');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const canonicalVehicleId = searchParams.get('vehicle')?.trim();
    const routedPlate = searchParams.get('plate')?.trim();
    if (canonicalVehicleId) {
      void searchVehicle('', canonicalVehicleId);
    } else if (routedPlate) {
      setPlate(routedPlate);
      void searchVehicle(routedPlate);
    }
  }, [searchParams, searchVehicle]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    void searchVehicle(plate);
  };

  const handleRaiseFlag = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!vehicle || !profile?.organizationId || !profile?.id) return;

    try {
      // ATLAS CALLS: raise_entity_flag (governed write, idempotent, audited; no hazard class = of-interest flag)
      const { data, error } = await supabase.rpc('raise_entity_flag', {
        p_client_request_id: crypto.randomUUID(),
        p_entity_type: 'vehicle',
        p_entity_id: vehicle.id,
        p_flag_type: flagForm.flag_type,
        p_alert_level: flagForm.alert_level,
        p_reason: flagForm.reason || null,
        p_hazard_class: null,
      });

      if (error) throw error;
      setFlags([data as EntityFlag, ...flags]);
      setFlagForm({ flag_type: 'watchlist', alert_level: 'medium', reason: '' });
      setShowFlagForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to raise flag');
    }
  };

  const handleResolveFlag = async (flag: EntityFlag) => {
    try {
      // ATLAS CALLS: resolve_entity_flag (raiser or organisation admin; audited)
      const { error } = await supabase.rpc('resolve_entity_flag', { p_flag_id: flag.id, p_note: null });
      if (error) throw error;
      setFlags(flags.map((f) => (f.id === flag.id ? { ...f, active: false } : f)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve flag');
    }
  };

  return (
    <div className="page-container vehicle-search-page">
      <header className="page-header">
        <h1>Vehicle Search & Flags</h1>
        <p className="subtitle">Search vehicle register, inspect compliance history, manage VOI & safety flags</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      <form className="vehicle-search-form" onSubmit={handleSearch}>
        <input
          type="text"
          placeholder="Enter plate number (e.g. ABC123)"
          value={plate}
          onChange={(e) => setPlate(e.target.value.toUpperCase())}
          style={{
            flex: 1,
            padding: '10px 14px',
            borderRadius: '6px',
            border: '1px solid var(--color-border)',
            background: 'var(--color-bg-primary)',
            color: 'var(--color-text-primary)',
            fontSize: '15px',
            fontFamily: 'var(--font-mono)',
          }}
        />
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? 'Searching…' : 'Search Plate'}
        </button>
      </form>

      {searched && !loading && (
        <div className="vehicle-search-results">
          {!vehicle && !scv && permits.length === 0 && observations.length === 0 ? (
            <div className="empty-state">
              <p>No vehicle records, permits, or observations found for "{plate}".</p>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: '16px' }}>
              {/* Top Overview & Flag Action Card */}
              <div className="contact-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div className="plate-banner">{plate}</div>
                    <div>
                      <div style={{ fontSize: '16px', fontWeight: 700 }}>
                        {vehicle?.make || 'Unknown Make'} {vehicle?.model || ''}
                        {vehicle?.year ? ` (${vehicle.year})` : ''}
                      </div>
                      <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>
                        {vehicle?.colour || 'Colour not recorded'}
                        {vehicle?.body_type ? ` · ${vehicle.body_type}` : ''}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                    {vehicle && (
                      <button className="btn btn-sm btn-secondary" onClick={() => setShowFlagForm(!showFlagForm)}>
                        {showFlagForm ? 'Cancel' : '+ Raise of-interest flag'}
                      </button>
                    )}
                  </div>
                </div>

                {vehicle?.external_data_source_name || vehicle?.external_data_source_url || vehicle?.external_data_source_location ? (
                  <div style={{ marginTop: '12px', padding: '10px 12px', background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)', borderRadius: '6px', fontSize: '13px', color: 'var(--color-text-secondary)' }}>
                    <strong>Latest licensed enrichment receipt:</strong>{' '}
                    {vehicle.external_data_source_url ? (
                      <a href={vehicle.external_data_source_url} target="_blank" rel="noreferrer">
                        {vehicle.external_data_source_name || 'External source'}
                      </a>
                    ) : (
                      vehicle.external_data_source_name || 'External source'
                    )}
                    {vehicle.external_data_source_location ? ` · ${vehicle.external_data_source_location}` : ''}
                    {vehicle.external_data_source_checked_at ? ` · checked ${new Date(vehicle.external_data_source_checked_at).toLocaleString()}` : ''}
                    <div style={{ marginTop: '4px' }}>
                      This receipt records the latest licensed enrichment check; compliance status may come from a separate live provider.
                    </div>
                  </div>
                ) : null}

                {/* Welfare signal: status only — welfare notes stay with the organisation that holds them */}
                {vehicle?.homeless_status && vehicle.homeless_status !== 'none' && (
                  <div style={{ marginTop: '12px', padding: '10px 12px', background: 'var(--color-warning-bg)', border: '1px solid var(--color-warning)', borderRadius: '6px', fontSize: '13px' }}>
                    <strong>Welfare:</strong> someone may be living in this vehicle ({vehicle.homeless_status.toUpperCase()}). Approach with care and follow your welfare procedure.
                  </div>
                )}

                {/* Raise Flag Form */}
                {showFlagForm && (
                  <form className="assessment-form" onSubmit={handleRaiseFlag}>
                    <div className="form-row">
                      <div className="form-group">
                        <label>Flag Type</label>
                        <input
                          type="text"
                          required
                          placeholder="e.g. watchlist, aggressive_dog, trespass"
                          value={flagForm.flag_type}
                          onChange={(e) => setFlagForm({ ...flagForm, flag_type: e.target.value })}
                        />
                      </div>
                      <div className="form-group">
                        <label>Alert Level</label>
                        <select
                          value={flagForm.alert_level}
                          onChange={(e) => setFlagForm({ ...flagForm, alert_level: e.target.value })}
                        >
                          <option value="low">Low</option>
                          <option value="medium">Medium</option>
                          <option value="high">High</option>
                          <option value="critical">Critical</option>
                        </select>
                      </div>
                    </div>
                    <div className="form-group">
                      <label>Reason / Details</label>
                      <textarea
                        rows={2}
                        required
                        placeholder="Provide details for field officers..."
                        value={flagForm.reason}
                        onChange={(e) => setFlagForm({ ...flagForm, reason: e.target.value })}
                      />
                    </div>
                    <button type="submit" className="btn btn-primary btn-sm">
                      Confirm & Raise Flag
                    </button>
                  </form>
                )}

                {/* Active & Historical Flags list */}
                {flags.length > 0 && (
                  <div style={{ marginTop: '14px' }}>
                    <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: '6px' }}>
                      Your organisation's of-interest flags ({flags.length})
                    </div>
                    <div className="vehicle-search-flags" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      {flags.map((f) => (
                        <span
                          key={f.id}
                          className={`vehicle-search-flag badge ${f.active ? (f.alert_level === 'critical' || f.alert_level === 'high' ? 'badge-danger' : 'badge-warning') : 'badge-info'}`}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '6px 10px', fontSize: '12px' }}
                        >
                          <span>
                            {f.active ? '⚠️' : '✓'} {f.flag_type.toUpperCase()}: {f.reason || 'No details'}
                            {!f.active ? ' (Resolved)' : ''}
                          </span>
                          {f.active && (
                            <button
                              onClick={() => handleResolveFlag(f)}
                              title="Resolve this flag"
                              style={{
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                color: 'inherit',
                                fontWeight: 700,
                                padding: '0 2px',
                              }}
                            >
                              ✕
                            </button>
                          )}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Platform-wide H&S warnings (redacted across organisations) */}
              <SafetyWarningsPanel entityType="vehicle" entityId={vehicle?.id ?? null} entityLabel="this vehicle" />

              {/* Warrant & Certification Status */}
              <div className="contact-card">
                <h3 style={{ margin: '0 0 8px 0', fontSize: '15px' }}>Warrant & Certification Status</h3>
                <div className="spec-grid">
                  <div className="spec-item">
                    <div className="spec-label">Registration</div>
                    <div className="spec-value">
                      <span className={`badge ${vehicle?.rego_status === 'current' ? 'badge-success' : vehicle?.rego_status === 'expired' ? 'badge-danger' : 'badge-info'}`}>
                        {vehicle?.rego_status ? vehicle.rego_status.toUpperCase() : 'UNKNOWN'}
                      </span>
                    </div>
                    {vehicle?.rego_expiry && (
                      <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)', marginTop: '4px' }}>
                        Exp: {new Date(vehicle.rego_expiry).toLocaleDateString()}
                      </div>
                    )}
                  </div>

                  <div className="spec-item">
                    <div className="spec-label">WOF / COF</div>
                    <div className="spec-value">
                      <span className={`badge ${vehicle?.wof_status === 'current' || vehicle?.cof_status === 'current' ? 'badge-success' : vehicle?.wof_status === 'expired' || vehicle?.cof_status === 'expired' ? 'badge-danger' : 'badge-info'}`}>
                        {vehicle?.wof_status ? `WOF: ${vehicle.wof_status.toUpperCase()}` : vehicle?.cof_status ? `COF: ${vehicle.cof_status.toUpperCase()}` : 'UNKNOWN'}
                      </span>
                    </div>
                    {(vehicle?.wof_expiry || vehicle?.cof_expiry) && (
                      <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)', marginTop: '4px' }}>
                        Exp: {new Date(vehicle.wof_expiry || vehicle.cof_expiry!).toLocaleDateString()}
                      </div>
                    )}
                  </div>

                  <div className="spec-item">
                    <div className="spec-label">Self-Containment (NZSCV)</div>
                    <div className="spec-value">
                      {scv ? (
                        <span className={`badge ${scv.certificate_status === 'active' ? 'badge-success' : 'badge-danger'}`}>
                          {scv.certificate_status.toUpperCase()} (#{scv.certificate_number || 'N/A'})
                        </span>
                      ) : (
                        <span style={{ color: 'var(--color-text-muted)' }}>Not Certified</span>
                      )}
                    </div>
                    {scv?.expiry_date && (
                      <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)', marginTop: '4px' }}>
                        Exp: {new Date(scv.expiry_date).toLocaleDateString()}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Forest / Site Access Permits */}
              {permits.length > 0 && (
                <div className="contact-card">
                  <h3 style={{ margin: '0 0 8px 0', fontSize: '15px' }}>Forest / Site Access Permits ({permits.length})</h3>
                  <div style={{ display: 'grid', gap: '8px', marginTop: '8px' }}>
                    {permits.map((p) => (
                      <div
                        key={p.id}
                        style={{
                          background: 'var(--color-bg-primary)',
                          border: p.status === 'active' ? '1px solid var(--color-success)' : '1px solid var(--color-border)',
                          padding: '10px 14px',
                          borderRadius: '6px',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' }}>
                          <div>
                            <div style={{ fontSize: '13px', fontWeight: 600 }}>
                              Permit #{p.permit_number} {p.permit_type ? `· ${p.permit_type}` : ''}
                            </div>
                            <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginTop: '2px' }}>
                              {p.holder_name || 'Holder not recorded'}
                              {p.forest_areas && p.forest_areas.length > 0 ? ` · ${p.forest_areas.join(', ')}` : ''}
                            </div>
                            {(p.date_from || p.date_to) && (
                              <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginTop: '4px' }}>
                                Valid {p.date_from ? new Date(p.date_from).toLocaleDateString() : '?'} – {p.date_to ? new Date(p.date_to).toLocaleDateString() : 'no end date'}
                              </div>
                            )}
                          </div>
                          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                            <span className={`badge ${p.status === 'active' ? 'badge-success' : p.status === 'expired' ? 'badge-warning' : 'badge-danger'}`}>
                              {p.status.toUpperCase()}
                            </span>
                            {p.firearm_licence_valid === false && <span className="badge badge-danger">NO VALID FIREARMS LICENCE</span>}
                          </div>
                        </div>
                        {p.conditions && (
                          <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginTop: '8px', whiteSpace: 'pre-wrap' }}>{p.conditions}</div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Recent Observations Timeline */}
              <div className="contact-card">
                <h3 style={{ margin: '0 0 8px 0', fontSize: '15px' }}>Observation History ({observations.length})</h3>
                {observations.length === 0 ? (
                  <div className="empty-state" style={{ padding: '16px' }}>
                    <p style={{ margin: 0 }}>No scan observations recorded for this plate.</p>
                  </div>
                ) : (
                  <div style={{ display: 'grid', gap: '8px', marginTop: '8px' }}>
                    {observations.map((obs) => (
                      <div
                        key={obs.id}
                        className="timeline-card"
                        style={{
                          background: 'var(--color-bg-primary)',
                          padding: '10px 14px',
                          borderRadius: '6px',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <div>
                          <div style={{ fontSize: '13px', fontWeight: 600 }}>
                            {obs.zone_name || 'General Zone'} · {new Date(obs.observed_at).toLocaleString()}
                          </div>
                          <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginTop: '2px' }}>
                            {obs.nights_this_zone ? `${obs.nights_this_zone} night(s) in zone` : ''}
                            {obs.compliance_reason ? ` · ${obs.compliance_reason}` : ''}
                          </div>
                        </div>
                        <span
                          className={`badge ${obs.is_compliant === true ? 'badge-success' : obs.is_compliant === false ? 'badge-danger' : 'badge-info'}`}
                        >
                          {obs.is_compliant === null ? 'LOGGED' : obs.is_compliant ? 'COMPLIANT' : 'BREACH'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Recorded Breaches */}
              {breaches.length > 0 && (
                <div className="contact-card">
                  <h3 style={{ margin: '0 0 8px 0', fontSize: '15px' }}>Breach Alerts ({breaches.length})</h3>
                  <div style={{ display: 'grid', gap: '8px', marginTop: '8px' }}>
                    {breaches.map((b) => (
                      <div
                        key={b.id}
                        style={{
                          background: 'var(--color-bg-primary)',
                          border: '1px solid var(--color-danger)',
                          padding: '10px 14px',
                          borderRadius: '6px',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <div>
                          <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-danger)' }}>
                            {b.breach_type.replace(/_/g, ' ').toUpperCase()} {b.zone_name ? `· ${b.zone_name}` : ''}
                          </div>
                          <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginTop: '2px' }}>
                            {new Date(b.created_at).toLocaleDateString()} · Status: {b.status}
                            {b.nights_count ? ` · ${b.nights_count} nights` : ''}
                          </div>
                          {b.notes && (
                            <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginTop: '4px' }}>
                              {b.notes}
                            </div>
                          )}
                        </div>
                        <span className={`badge ${b.status === 'open' ? 'badge-danger' : 'badge-info'}`}>
                          {b.status.toUpperCase()}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default VehicleSearchPage;
