/**
 * OfficerVehicleLookupPage.tsx (Officer module: 'vehicle_lookup')
 *
 * Canonical schema: canonical_vehicles (plate registry, rego/wof/cof status,
 * homeless_status) + entity_flags (entity_type='vehicle', alert_level,
 * reason — replaces a fabricated "vehicle_flags" table that does not exist).
 */

import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface Vehicle {
  id: string;
  plate_number: string;
  make: string | null;
  model: string | null;
  colour: string | null;
  rego_status: string | null;
  rego_expiry: string | null;
  wof_status: string | null;
  wof_expiry: string | null;
  homeless_status: string;
}

interface EntityFlag {
  id: string;
  flag_type: string;
  alert_level: string | null;
  reason: string | null;
  active: boolean;
}

const OfficerVehicleLookupPage: React.FC = () => {
  const [plate, setPlate] = useState('');
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [flags, setFlags] = useState<EntityFlag[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!plate.trim()) return;

    try {
      setLoading(true);
      setError(null);
      setSearched(true);

      // ATLAS READS: canonical_vehicles
      const { data, error: err } = await supabase
        .from('canonical_vehicles')
        .select('id, plate_number, make, model, colour, rego_status, rego_expiry, wof_status, wof_expiry, homeless_status')
        .ilike('plate_number', plate.trim())
        .maybeSingle();

      if (err) throw err;
      setVehicle((data as Vehicle) || null);

      if (data) {
        // ATLAS READS: entity_flags
        const { data: flagData, error: flagErr } = await supabase
          .from('entity_flags')
          .select('id, flag_type, alert_level, reason, active')
          .eq('entity_type', 'vehicle')
          .eq('entity_id', data.id)
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
        <p className="subtitle">Search by plate number</p>
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
          placeholder="Plate number"
          value={plate}
          onChange={(e) => setPlate(e.target.value.toUpperCase())}
          style={{ flex: 1, padding: '8px 12px', borderRadius: '4px', border: '1px solid var(--color-border)' }}
        />
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? 'Searching…' : 'Search'}
        </button>
      </form>

      {searched && !loading && (
        <div style={{ marginTop: '16px' }}>
          {!vehicle ? (
            <div className="empty-state">
              <p>No vehicle found for that plate.</p>
            </div>
          ) : (
            <div className="contact-card">
              <div className="contact-header">
                <h3>{vehicle.plate_number}</h3>
                {vehicle.homeless_status !== 'none' && (
                  <span className="severity-badge severity-medium">{vehicle.homeless_status}</span>
                )}
              </div>
              <div className="contact-details">
                <p>
                  {vehicle.make} {vehicle.model} · {vehicle.colour}
                </p>
                <p className="contact-meta">
                  Rego: {vehicle.rego_status || 'unknown'}
                  {vehicle.rego_expiry ? ` (expires ${new Date(vehicle.rego_expiry).toLocaleDateString()})` : ''}
                </p>
                <p className="contact-meta">
                  WOF: {vehicle.wof_status || 'unknown'}
                  {vehicle.wof_expiry ? ` (expires ${new Date(vehicle.wof_expiry).toLocaleDateString()})` : ''}
                </p>
              </div>
              {flags.length > 0 && (
                <div className="assessment-actions">
                  {flags.map((f) => (
                    <span key={f.id} className={`severity-badge severity-${f.alert_level || 'medium'}`}>
                      {f.flag_type}
                      {f.reason ? `: ${f.reason}` : ''}
                    </span>
                  ))}
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
