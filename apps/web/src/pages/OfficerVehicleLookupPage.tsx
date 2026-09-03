/**
 * OfficerVehicleLookupPage.tsx (Officer module: 'vehicle_lookup')
 *
 * Canonical schema:
 * - canonical_vehicles (plate registry, rego/wof/cof status, homeless_status)
 * - canonical_scv (NZSCV self-containment warrant records & expiry)
 * - entity_flags (active vehicle safety/warning alerts)
 * - observations (recent scan/observation history with zone context)
 * - breach_alerts (compliance breaches recorded for this vehicle)
 */

import React, { useState } from 'react';
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
  homeless_notes: string | null;
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

const OfficerVehicleLookupPage: React.FC = () => {
  const [plate, setPlate] = useState('');
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [scv, setScv] = useState<ScvRecord | null>(null);
  const [flags, setFlags] = useState<EntityFlag[]>([]);
  const [observations, setObservations] = useState<RecentObservation[]>([]);
  const [breaches, setBreaches] = useState<VehicleBreach[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanPlate = plate.trim().toUpperCase();
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

      // ATLAS READS: canonical_vehicles, canonical_scv, observations, breach_alerts
      const [vehRes, scvRes, obsRes, breachRes] = await Promise.all([
        supabase
          .from('canonical_vehicles')
          .select(
            'id, plate_number, make, model, year, colour, body_type, rego_status, rego_expiry, wof_status, wof_expiry, cof_status, cof_expiry, homeless_status, homeless_notes'
          )
          .ilike('plate_number', cleanPlate)
          .maybeSingle(),
        supabase
          .from('canonical_scv')
          .select('id, certificate_number, certificate_status, expiry_date, issued_date')
          .ilike('plate_number', cleanPlate)
          .maybeSingle(),
        supabase
          .from('observations')
          .select('id, observed_at, is_compliant, compliance_reason, nights_this_zone, zone:zone_id(name)')
          .ilike('plate_number', cleanPlate)
          .order('observed_at', { ascending: false })
          .limit(10),
        supabase
          .from('breach_alerts')
          .select('id, breach_type, status, nights_count, notes, created_at, zone:zone_id(name)')
          .ilike('plate_number', cleanPlate)
          .order('created_at', { ascending: false })
          .limit(10),
      ]);

      const queryError = vehRes.error ?? scvRes.error ?? obsRes.error ?? breachRes.error;
      if (queryError) throw new Error(queryError.message);
      const vehData = vehRes.data as Vehicle | null;
      setVehicle(vehData);
      setScv((scvRes.data as ScvRecord) || null);

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
        // ATLAS READS: entity_flags
        const { data: flagData, error: flagErr } = await supabase
          .from('entity_flags')
          .select('id, flag_type, alert_level, reason, active')
          .eq('entity_type', 'vehicle')
          .eq('entity_id', vehData.id)
          .eq('active', true);

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
          {!vehicle && !scv && observations.length === 0 && breaches.length === 0 ? (
            <div className="empty-state">
              <p>No vehicle records, SCV certifications, or observations found for "{plate}".</p>
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

                {/* Homeless notes callout */}
                {vehicle?.homeless_notes && (
                  <div style={{ marginTop: '12px', padding: '10px 12px', background: 'var(--color-warning-bg)', border: '1px solid var(--color-warning)', borderRadius: '6px', fontSize: '13px' }}>
                    <strong>Vulnerability Notes:</strong> {vehicle.homeless_notes}
                  </div>
                )}

                {/* Active Safety Flags */}
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
