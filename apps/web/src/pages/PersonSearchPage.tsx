/**
 * PersonSearchPage.tsx (Admin field-ops sub-area: 'person-search')
 *
 * Canonical schema:
 * - persons (canonical person registry: display_name, date_of_birth,
 *   welfare_flag/notes, homeless_status)
 * - entity_flags (entity_type='person' - raise & resolve people-of-interest
 *   flags: trespass, welfare, repeat offender, banned from site, watchlist)
 *
 * Mirrors VehicleSearchPage's entity_flags pattern exactly, for the person
 * entity type. entity_flags replaced the retired standalone person_flags
 * table (0115) -- this is the current, correct home for "people of
 * interest" status, previously wired for vehicles only.
 *
 * DEFERRED: person_interactions has no INSERT RLS policy yet (SELECT-only),
 * so interaction history logging isn't wired here -- needs a migration
 * first. person_records/person_identity_documents/face_observations are a
 * separate face/ID-inference review pipeline, not people-of-interest flags.
 */

import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface Person {
  id: string;
  display_name: string | null;
  date_of_birth: string | null;
  welfare_flag: boolean;
  welfare_notes: string | null;
  homeless_status: string;
  homeless_notes: string | null;
}

interface EntityFlag {
  id: string;
  flag_type: string;
  alert_level: string | null;
  reason: string | null;
  active: boolean;
  raised_at: string;
}

const PersonSearchPage: React.FC = () => {
  const { profile } = useAuth();
  const [name, setName] = useState('');
  const [results, setResults] = useState<Person[]>([]);
  const [selected, setSelected] = useState<Person | null>(null);
  const [flags, setFlags] = useState<EntityFlag[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFlagForm, setShowFlagForm] = useState(false);
  const [flagForm, setFlagForm] = useState({ flag_type: 'watchlist', alert_level: 'medium', reason: '' });

  const loadFlags = async (personId: string) => {
    // ATLAS READS: entity_flags
    const { data, error: flagErr } = await supabase
      .from('entity_flags')
      .select('id, flag_type, alert_level, reason, active, raised_at')
      .eq('entity_type', 'person')
      .eq('entity_id', personId)
      .order('raised_at', { ascending: false });
    if (flagErr) throw flagErr;
    setFlags((data as EntityFlag[]) ?? []);
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const query = name.trim();
    if (!query) return;

    try {
      setLoading(true);
      setError(null);
      setSearched(true);
      setSelected(null);
      setFlags([]);

      // ATLAS READS: persons
      const { data, error: err } = await supabase
        .from('persons')
        .select('id, display_name, date_of_birth, welfare_flag, welfare_notes, homeless_status, homeless_notes')
        .ilike('display_name', `%${query}%`)
        .order('display_name')
        .limit(20);

      if (err) throw err;
      setResults((data as Person[]) ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to search persons');
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = async (person: Person) => {
    setSelected(person);
    setShowFlagForm(false);
    try {
      await loadFlags(person.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load flags');
    }
  };

  const handleRaiseFlag = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || !profile?.organizationId || !profile?.id) return;

    try {
      // ATLAS WRITES: entity_flags
      const { data, error: err } = await supabase
        .from('entity_flags')
        .insert([
          {
            organization_id: profile.organizationId,
            entity_type: 'person',
            entity_id: selected.id,
            flag_type: flagForm.flag_type,
            alert_level: flagForm.alert_level,
            reason: flagForm.reason || null,
            raised_by: profile.id,
          },
        ])
        .select('id, flag_type, alert_level, reason, active, raised_at')
        .single();

      if (err) throw err;
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
      const { error: err } = await supabase
        .from('entity_flags')
        .update({ active: false, resolved_at: new Date().toISOString() })
        .eq('id', flag.id);
      if (err) throw err;
      setFlags(flags.map((f) => (f.id === flag.id ? { ...f, active: false } : f)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve flag');
    }
  };

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Person Search &amp; Flags</h1>
        <p className="subtitle">Search the person registry and manage people-of-interest flags</p>
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
          placeholder="Enter a name to search"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ flex: 1, padding: '10px 14px', borderRadius: '6px', border: '1px solid var(--color-border)' }}
        />
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? 'Searching…' : 'Search'}
        </button>
      </form>

      {searched && !loading && (
        <div style={{ marginTop: '20px', display: 'grid', gap: '16px' }}>
          {results.length === 0 ? (
            <div className="empty-state">
              <p>No person records found for "{name}".</p>
            </div>
          ) : (
            <div className="contacts-list">
              {results.map((person) => (
                <div key={person.id} className={`contact-card ${selected?.id === person.id ? 'is-active' : ''}`} onClick={() => handleSelect(person)} style={{ cursor: 'pointer' }}>
                  <div className="contact-header">
                    <h3>{person.display_name || 'Unnamed record'}</h3>
                    {person.welfare_flag && <span className="badge is-alert">Welfare</span>}
                  </div>
                  {person.date_of_birth && <p className="contact-meta">DOB {person.date_of_birth}</p>}
                </div>
              ))}
            </div>
          )}

          {selected && (
            <div className="contact-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
                <h2>{selected.display_name || 'Unnamed record'}</h2>
                <button className="btn btn-sm btn-secondary" onClick={() => setShowFlagForm(!showFlagForm)}>
                  {showFlagForm ? 'Cancel' : '+ Raise Flag'}
                </button>
              </div>

              {selected.homeless_status !== 'none' && (
                <div style={{ marginTop: '12px', padding: '10px 12px', background: 'var(--color-warning-bg)', border: '1px solid var(--color-warning)', borderRadius: '6px', fontSize: '13px' }}>
                  <strong>Homeless / Vulnerable Status:</strong> {selected.homeless_status.toUpperCase()}
                  {selected.homeless_notes ? ` — ${selected.homeless_notes}` : ''}
                </div>
              )}
              {selected.welfare_flag && (
                <div style={{ marginTop: '8px', padding: '10px 12px', background: 'var(--color-warning-bg)', border: '1px solid var(--color-warning)', borderRadius: '6px', fontSize: '13px' }}>
                  <strong>Welfare concern:</strong> {selected.welfare_notes || 'No further notes recorded'}
                </div>
              )}

              {showFlagForm && (
                <form className="assessment-form" onSubmit={handleRaiseFlag}>
                  <div className="form-row">
                    <div className="form-group">
                      <label>Flag Type</label>
                      <input
                        type="text"
                        required
                        placeholder="e.g. trespass, banned_from_site, repeat_offender, watchlist"
                        value={flagForm.flag_type}
                        onChange={(e) => setFlagForm({ ...flagForm, flag_type: e.target.value })}
                      />
                    </div>
                    <div className="form-group">
                      <label>Alert Level</label>
                      <select value={flagForm.alert_level} onChange={(e) => setFlagForm({ ...flagForm, alert_level: e.target.value })}>
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
                      placeholder="Provide details for field officers…"
                      value={flagForm.reason}
                      onChange={(e) => setFlagForm({ ...flagForm, reason: e.target.value })}
                    />
                  </div>
                  <button type="submit" className="btn btn-primary btn-sm">
                    Confirm &amp; Raise Flag
                  </button>
                </form>
              )}

              <div className="contacts-list" style={{ marginTop: '12px' }}>
                {flags.length === 0 ? (
                  <p className="contact-meta">No flags recorded.</p>
                ) : (
                  flags.map((flag) => (
                    <div key={flag.id} className="contact-card">
                      <div className="contact-header">
                        <h3>{flag.flag_type.replaceAll('_', ' ')}</h3>
                        <span className={`badge ${flag.active ? 'is-alert' : ''}`}>{flag.active ? flag.alert_level : 'resolved'}</span>
                      </div>
                      {flag.reason && <p>{flag.reason}</p>}
                      <p className="contact-meta">{new Date(flag.raised_at).toLocaleString()}</p>
                      {flag.active && (
                        <button className="btn btn-sm btn-secondary" onClick={() => handleResolveFlag(flag)}>
                          Resolve
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default PersonSearchPage;
