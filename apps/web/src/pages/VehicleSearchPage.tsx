/**
 * VehicleSearchPage.tsx (Admin field-ops sub-area: 'vehicle-search')
 *
 * Canonical schema: canonical_vehicles (plate registry) + entity_flags
 * (entity_type='vehicle'). Admin-side: search plus ability to raise a flag,
 * distinct from OfficerVehicleLookupPage which is read-only in the field.
 */

import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface Vehicle {
  id: string;
  plate_number: string;
  make: string | null;
  model: string | null;
  colour: string | null;
  rego_status: string | null;
  wof_status: string | null;
  homeless_status: string;
}

interface EntityFlag {
  id: string;
  flag_type: string;
  alert_level: string | null;
  reason: string | null;
  active: boolean;
}

const VehicleSearchPage: React.FC = () => {
  const { profile } = useAuth();
  const [plate, setPlate] = useState('');
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [flags, setFlags] = useState<EntityFlag[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFlagForm, setShowFlagForm] = useState(false);
  const [flagForm, setFlagForm] = useState({ flag_type: 'watchlist', alert_level: 'medium', reason: '' });

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
        .select('id, plate_number, make, model, colour, rego_status, wof_status, homeless_status')
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
          .eq('entity_id', data.id);

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

  const handleRaiseFlag = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!vehicle || !profile?.organizationId || !profile?.id) return;

    try {
      // ATLAS WRITES: entity_flags
      const { data, error } = await supabase
        .from('entity_flags')
        .insert([
          {
            organization_id: profile.organizationId,
            entity_type: 'vehicle',
            entity_id: vehicle.id,
            flag_type: flagForm.flag_type,
            alert_level: flagForm.alert_level,
            reason: flagForm.reason || null,
            raised_by: profile.id,
          },
        ])
        .select()
        .single();

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
      // ATLAS WRITES: entity_flags
      const { error } = await supabase
        .from('entity_flags')
        .update({ active: false, resolved_at: new Date().toISOString() })
        .eq('id', flag.id);
      if (error) throw error;
      setFlags(flags.map((f) => (f.id === flag.id ? { ...f, active: false } : f)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve flag');
    }
  };

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Vehicle Search</h1>
        <p className="subtitle">Search plates, manage flags</p>
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
                <button className="btn btn-sm btn-secondary" onClick={() => setShowFlagForm(!showFlagForm)}>
                  {showFlagForm ? 'Cancel' : '+ Raise Flag'}
                </button>
              </div>
              <div className="contact-details">
                <p>
                  {vehicle.make} {vehicle.model} · {vehicle.colour}
                </p>
                <p className="contact-meta">
                  Rego: {vehicle.rego_status || 'unknown'} · WOF: {vehicle.wof_status || 'unknown'}
                </p>
              </div>

              {showFlagForm && (
                <form className="assessment-form" onSubmit={handleRaiseFlag}>
                  <div className="form-row">
                    <div className="form-group">
                      <label>Flag Type</label>
                      <input
                        type="text"
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
                    <label>Reason</label>
                    <textarea
                      rows={2}
                      value={flagForm.reason}
                      onChange={(e) => setFlagForm({ ...flagForm, reason: e.target.value })}
                    />
                  </div>
                  <button type="submit" className="btn btn-primary btn-sm">
                    Raise Flag
                  </button>
                </form>
              )}

              {flags.length > 0 && (
                <div className="assessment-actions" style={{ flexWrap: 'wrap', marginTop: '12px' }}>
                  {flags.map((f) => (
                    <span
                      key={f.id}
                      className={`severity-badge severity-${f.alert_level || 'medium'}`}
                      style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                    >
                      {f.flag_type}
                      {f.reason ? `: ${f.reason}` : ''}
                      {f.active && (
                        <button
                          onClick={() => handleResolveFlag(f)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}
                        >
                          ✕
                        </button>
                      )}
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

export default VehicleSearchPage;
