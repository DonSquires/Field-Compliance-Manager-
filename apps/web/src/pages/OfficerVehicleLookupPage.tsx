/**
 * OfficerVehicleLookupPage.tsx (Officer module: 'vehicle_lookup')
 *
 * Canonical schema:
 * - canonical_vehicle_public (plate registry projection: rego/wof/cof status,
 *   homeless_status signal; the canonical_vehicles table itself stays Bob-only
 *   and its owner name / welfare notes are never sent to the field)
 * - canonical_scv_public (NZSCV self-containment certificate status & expiry)
 * - get_safety_warnings / raise_entity_flag (platform-wide, redacted H&S
 *   warnings — every organisation's hazards, hazard class + severity + contact
 *   path only)
 * - entity_flags (this organisation's own of-interest flags, RLS-scoped)
 * - observations (recent scan/observation history with zone context)
 * - breach_alerts (compliance breaches recorded for this vehicle)
 */

import React, { useState } from 'react';
import { SafetyWarningsPanel } from '../components/SafetyWarningsPanel';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { normalizePlateNumber, vehicleHistoryOrFilter } from '../lib/canonicalIdentity';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

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

const OfficerVehicleLookupPage: React.FC = () => {
  const { selectedAgreementZones } = useServiceRelationships();
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

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanPlate = normalizePlateNumber(plate);
    if (!cleanPlate) return;

    try {
      setLoading(true);
      setError(null);
      setSearched(true);
      setVehicle(null);
      setScv(null);
      setFlags([]);
      setObservations([]);
      setBreaches([]);
      setPermits([]);
      const activeZoneIds = selectedAgreementZones.length > 0 ? selectedAgreementZones.map((zone) => zone.id) : null;

      // ATLAS READS: canonical_vehicle_public, canonical_scv_public, person_permits_fieldwork, observations, breach_alerts
      // Resolve the canonical vehicle first so observation history follows the
      // global identity link, not only the plate text recorded at scan time.
      const [vehRes, scvRes, permitRes] = await Promise.all([
        supabase
          .from('canonical_vehicle_public')
          .select(
            'id, plate_number, make, model, year, colour, body_type, rego_status, rego_expiry, wof_status, wof_expiry, cof_status, cof_expiry, homeless_status, external_data_source_name, external_data_source_url, external_data_source_location, external_data_source_checked_at'
          )
          .ilike('plate_number', cleanPlate)
          .maybeSingle(),
        supabase
          .from('canonical_scv_public')
          .select('id, certificate_number, certificate_status, expiry_date, issued_date')
          .ilike('plate_number', cleanPlate)
          .maybeSingle(),
        supabase
          .from('person_permits_fieldwork')
          .select('id, holder_name, permit_number, permit_type, forest_areas, date_from, date_to, status, firearm_licence_valid, conditions, vehicle_plates')
          .contains('vehicle_plates', [cleanPlate])
          .order('date_to', { ascending: false }),
      ]);
      const canonicalVehicleId = (vehRes.data as Vehicle | null)?.id ?? null;
      const historyFilter = vehicleHistoryOrFilter(cleanPlate, canonicalVehicleId);
      const [obsRes, breachRes] = await Promise.all([
        (activeZoneIds && activeZoneIds.length > 0
          ? supabase
              .from('observations')
              .select('id, observed_at, is_compliant, compliance_reason, nights_this_zone, zone:zone_id(name)')
              .or(historyFilter)
              .in('zone_id', activeZoneIds)
              .order('observed_at', { ascending: false })
              .limit(10)
          : supabase
          .from('observations')
          .select('id, observed_at, is_compliant, compliance_reason, nights_this_zone, zone:zone_id(name)')
          .or(historyFilter)
          .order('observed_at', { ascending: false })
          .limit(10)),
        (activeZoneIds && activeZoneIds.length > 0
          ? supabase
              .from('breach_alerts')
              .select('id, breach_type, status, nights_count, notes, created_at, zone:location_zones!breach_alerts_zone_id_fkey(name)')
              .ilike('plate_number', cleanPlate)
              .in('zone_id', activeZoneIds)
              .order('created_at', { ascending: false })
              .limit(10)
          : supabase
          .from('breach_alerts')
          .select('id, breach_type, status, nights_count, notes, created_at, zone:location_zones!breach_alerts_zone_id_fkey(name)')
          .ilike('plate_number', cleanPlate)
          .order('created_at', { ascending: false })
          .limit(10)),
      ]);

      const queryError = vehRes.error ?? scvRes.error ?? permitRes.error ?? obsRes.error ?? breachRes.error;
      if (queryError) throw new Error(queryError.message);
      const vehData = vehRes.data as Vehicle | null;
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
        // ATLAS READS: entity_flags — this organisation's own of-interest flags only.
        // Safety warnings (hazard_class set) come through SafetyWarningsPanel so
        // every organisation's hazards are shown, redacted.
        const { data: flagData, error: flagErr } = await supabase
          .from('entity_flags')
          .select('id, flag_type, alert_level, reason, active')
          .eq('entity_type', 'vehicle')
          .eq('entity_id', vehData.id)
          .eq('active', true)
          .is('hazard_class', null);

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
  };

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Vehicle Lookup</h1>
        <p className="subtitle">Search canonical registry, SCV certification, flags, and history</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      <form onSubmit={handleSearch} style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
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

      {searched && !loading && !error && (
        <div style={{ marginTop: '20px' }}>
          {!vehicle && !scv && permits.length === 0 && observations.length === 0 && breaches.length === 0 ? (
            <div className="empty-state">
              <p>No vehicle records, SCV certifications, permits, or observations found for "{plate}".</p>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: '16px' }}>
              {/* Header card with Plate & Safety Flags */}
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

                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    {/* SCV Badge */}
                    {scv ? (
                      <span className={`badge ${scv.certificate_status === 'active' ? 'badge-success' : 'badge-danger'}`}>
                        SCV: {scv.certificate_status.toUpperCase()}
                      </span>
                    ) : (
                      <span className="badge badge-warning">SCV: NO RECORD</span>
                    )}

                    {/* Homeless / Vulnerability indicator */}
                    {vehicle?.homeless_status && vehicle.homeless_status !== 'none' && (
                      <span className="badge badge-warning">
                        HOMELESS: {vehicle.homeless_status.toUpperCase()}
                      </span>
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

                {/* Welfare signal: status only — the welfare notes stay with the organisation that holds them */}
                {vehicle?.homeless_status && vehicle.homeless_status !== 'none' && (
                  <div style={{ marginTop: '12px', padding: '10px 12px', background: 'var(--color-warning-bg)', border: '1px solid var(--color-warning)', borderRadius: '6px', fontSize: '13px' }}>
                    <strong>Welfare:</strong> someone may be living in this vehicle ({vehicle.homeless_status}). Approach with care and follow your welfare procedure.
                  </div>
                )}

                {/* This organisation's own of-interest flags */}
                {flags.length > 0 && (
                  <div style={{ marginTop: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    {flags.map((f) => (
                      <span
                        key={f.id}
                        className={`badge ${f.alert_level === 'critical' || f.alert_level === 'high' ? 'badge-danger' : 'badge-warning'}`}
                        style={{ padding: '6px 10px', fontSize: '12px' }}
                      >
                        ⚠️ {f.flag_type.toUpperCase()}: {f.reason || 'Flag active'} ({f.alert_level || 'normal'})
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Platform-wide H&S warnings (redacted across organisations) */}
              <SafetyWarningsPanel entityType="vehicle" entityId={vehicle?.id ?? null} entityLabel="this vehicle" />

              {/* Compliance & Registration Specs */}
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
                        <span>Cert #{scv.certificate_number || 'N/A'}</span>
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
                <h3 style={{ margin: '0 0 8px 0', fontSize: '15px' }}>Recent Observations ({observations.length})</h3>
                {observations.length === 0 ? (
                  <div className="empty-state" style={{ padding: '16px' }}>
                    <p style={{ margin: 0 }}>No prior scan observations recorded for this plate.</p>
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
                            {obs.zone_name || 'General Area'} · {new Date(obs.observed_at).toLocaleString()}
                          </div>
                          <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginTop: '2px' }}>
                            {obs.nights_this_zone ? `${obs.nights_this_zone} night(s) in zone` : ''}
                            {obs.compliance_reason ? ` · ${obs.compliance_reason}` : ''}
                          </div>
                        </div>
                        <div>
                          <span
                            className={`badge ${obs.is_compliant === true ? 'badge-success' : obs.is_compliant === false ? 'badge-danger' : 'badge-info'}`}
                          >
                            {obs.is_compliant === null ? 'LOGGED' : obs.is_compliant ? 'COMPLIANT' : 'BREACH'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Recorded Breaches */}
              {breaches.length > 0 && (
                <div className="contact-card">
                  <h3 style={{ margin: '0 0 8px 0', fontSize: '15px' }}>Compliance Breaches ({breaches.length})</h3>
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

export default OfficerVehicleLookupPage;
