/**
 * OfficerPersonLookupPage.tsx (Officer module: 'person_lookup')
 *
 * Canonical schema:
 * - persons (canonical person registry: welfare_flag/notes, homeless_status)
 * - entity_flags (active entity_type='person' people-of-interest flags)
 *
 * Read-only mirror of OfficerVehicleLookupPage for the person entity type.
 */

import React, { useState } from 'react';
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
}

const OfficerPersonLookupPage: React.FC = () => {
  const [name, setName] = useState('');
  const [results, setResults] = useState<Person[]>([]);
  const [flagsByPerson, setFlagsByPerson] = useState<Record<string, EntityFlag[]>>({});
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const query = name.trim();
    if (!query) return;

    try {
      setLoading(true);
      setError(null);
      setSearched(true);

      // ATLAS READS: persons
      const { data, error: err } = await supabase
        .from('persons')
        .select('id, display_name, date_of_birth, welfare_flag, welfare_notes, homeless_status, homeless_notes')
        .ilike('display_name', `%${query}%`)
        .order('display_name')
        .limit(20);

      if (err) throw err;
      const people = (data as Person[]) ?? [];
      setResults(people);

      if (people.length > 0) {
        // ATLAS READS: entity_flags
        const { data: flagData, error: flagErr } = await supabase
          .from('entity_flags')
          .select('id, entity_id, flag_type, alert_level, reason')
          .eq('entity_type', 'person')
          .eq('active', true)
          .in('entity_id', people.map((p) => p.id));

        if (flagErr) throw flagErr;
        const grouped: Record<string, EntityFlag[]> = {};
        for (const row of (flagData as Array<EntityFlag & { entity_id: string }>) ?? []) {
          (grouped[row.entity_id] ??= []).push(row);
        }
        setFlagsByPerson(grouped);
      } else {
        setFlagsByPerson({});
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to search persons');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Person Lookup</h1>
        <p className="subtitle">Search the person registry for active flags and welfare notes</p>
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
        <div className="contacts-list" style={{ marginTop: '20px' }}>
          {results.length === 0 ? (
            <div className="empty-state">
              <p>No person records found for "{name}".</p>
            </div>
          ) : (
            results.map((person) => {
              const flags = flagsByPerson[person.id] ?? [];
              return (
                <div key={person.id} className="contact-card">
                  <div className="contact-header">
                    <h3>{person.display_name || 'Unnamed record'}</h3>
                    {flags.length > 0 && <span className="badge is-alert">{flags.length} active flag(s)</span>}
                  </div>
                  {person.date_of_birth && <p className="contact-meta">DOB {person.date_of_birth}</p>}
                  {person.homeless_status !== 'none' && (
                    <p className="contact-meta">Homeless/vulnerable status: {person.homeless_status}</p>
                  )}
                  {person.welfare_flag && <p className="contact-meta">Welfare concern: {person.welfare_notes || 'noted'}</p>}
                  {flags.map((flag) => (
                    <div key={flag.id} className="contact-details">
                      <p className="contact-meta">
                        <strong>{flag.flag_type.replaceAll('_', ' ')}</strong> ({flag.alert_level}){flag.reason ? ` — ${flag.reason}` : ''}
                      </p>
                    </div>
                  ))}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};

export default OfficerPersonLookupPage;
