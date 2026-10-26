/**
 * PersonSearchPage.tsx (Admin field-ops sub-area: 'person-search')
 *
 * Canonical schema:
 * - search_people (canonical_people + person_record_aliases + notices +
 *   entity_links, scoped to the caller's organisations; address and NZTA
 *   register checks only for vehicle-owner identity access)
 * - get_notice_expiry_register (issued trespass/warning notices expiring soon
 *   or recently expired; fed daily into notifications by
 *   sweep_notice_expiry_alerts)
 * - get_safety_warnings via SafetyWarningsPanel (platform-wide, redacted)
 */

import React, { useCallback, useEffect, useState } from 'react';
import { SafetyWarningsPanel } from '../components/SafetyWarningsPanel';
import { supabase } from '../lib/supabase';
import {
  describeDaysRemaining,
  formatNzDate,
  noticeExpiryLabel,
  noticeStillBarsEntry,
  noticeTypeLabel,
  personSearchQueryIsValid,
  type NoticeRegisterRow,
  type PersonMatch,
} from '../lib/personSearch';
import './PageStyles.css';
import './PersonSearchPage.css';

const PersonSearchPage: React.FC = () => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PersonMatch[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [register, setRegister] = useState<NoticeRegisterRow[] | null>(null);
  const [registerError, setRegisterError] = useState<string | null>(null);

  const loadRegister = useCallback(async () => {
    setRegisterError(null);
    const { data, error: rpcError } = await supabase.rpc('get_notice_expiry_register', { p_window_days: 30, p_expired_days: 90 });
    if (rpcError) {
      setRegister([]);
      setRegisterError('The notice expiry register could not be loaded. Try again shortly.');
      return;
    }
    setRegister((data ?? []) as NoticeRegisterRow[]);
  }, []);

  useEffect(() => { void loadRegister(); }, [loadRegister]);

  const runSearch = useCallback(async (text: string, focusPersonId?: string | null) => {
    if (!personSearchQueryIsValid(text)) {
      setError('Enter at least two letters or numbers of a name.');
      return;
    }
    setSearching(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc('search_people', { p_query: text, p_limit: 25 });
    setSearching(false);
    if (rpcError) {
      setResults(null);
      setError('Person search failed. Check your connection and try again.');
      return;
    }
    const matches = (data ?? []) as PersonMatch[];
    setResults(matches);
    const focus = focusPersonId && matches.some((match) => match.canonical_person_id === focusPersonId)
      ? focusPersonId
      : matches.length === 1 ? matches[0].canonical_person_id : null;
    setSelectedId(focus);
  }, []);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void runSearch(query);
  };

  const openFromRegister = (row: NoticeRegisterRow) => {
    if (!row.person_display_name) return;
    setQuery(row.person_display_name);
    void runSearch(row.person_display_name, row.canonical_person_id);
  };

  const selected = results?.find((match) => match.canonical_person_id === selectedId) ?? null;

  return (
    <div className="page-container person-search-page">
      <header className="page-header">
        <div>
          <h1>Person Search</h1>
          <p className="subtitle">Find a person, their trespass and warning notices and other letters, when notices expire, and linked vehicles.</p>
        </div>
      </header>

      <section className="person-search-register" aria-labelledby="person-search-register-title">
        <div className="person-search-register-head">
          <h2 id="person-search-register-title">Notices expiring or recently expired</h2>
          <button type="button" className="btn btn-secondary" onClick={() => void loadRegister()}>Refresh</button>
        </div>
        <p className="subtitle">Issued trespass and warning notices that expire within 30 days or expired in the last 90 days. Admins also get a daily alert.</p>
        {registerError && <div className="alert alert-error" role="alert">{registerError}</div>}
        {register === null ? <p role="status">Loading notices…</p>
          : register.length === 0 ? (!registerError && <p role="status">No notices are expiring in the next 30 days or expired in the last 90 days.</p>)
          : (
            <div className="reports-table-wrapper">
              <table className="reports-table">
                <thead><tr><th>Person</th><th>Notice</th><th>Client</th><th>Place</th><th>Expiry</th></tr></thead>
                <tbody>{register.map((row) => (
                  <tr key={row.notice_id}>
                    <td>{row.person_display_name
                      ? <button type="button" className="btn btn-secondary" disabled={searching} onClick={() => openFromRegister(row)}>{row.person_display_name}</button>
                      : 'Person not linked'}</td>
                    <td>{noticeTypeLabel(row.notice_type)}{row.notice_number ? ` ${row.notice_number}` : ''}</td>
                    <td>{row.organization_name}</td>
                    <td>{row.location_name ?? 'Not recorded'}</td>
                    <td><span className={`person-notice-badge is-${row.expiry_state}`}>{noticeExpiryLabel(row.expiry_state)}</span>{' '}
                      {formatNzDate(row.expires_at)} ({describeDaysRemaining(row.days_remaining)})</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
      </section>

      <form className="person-search-form" onSubmit={handleSubmit} role="search">
        <label htmlFor="person-search-input" className="sr-only">Name search</label>
        <input
          id="person-search-input"
          type="search"
          aria-describedby="person-search-help"
          placeholder="Name or alias, e.g. John Smith"
          value={query}
          disabled={searching}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={searching}>{searching ? 'Searching…' : 'Search'}</button>
      </form>
      <p id="person-search-help" className="subtitle">Search by full or partial name, surname first or last, or a known alias. People with a notice in force are listed first.</p>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">×</button>
          {error}
        </div>
      )}

      {results !== null && !searching && (
        <section aria-label="Matching people">
          <p role="status">{results.length === 0 ? 'No matching people found in your organisations.' : `${results.length} matching ${results.length === 1 ? 'person' : 'people'}${results.length === 25 ? ' (first 25 shown; refine your search to see others)' : ''}.`}</p>
          {results.length > 0 && (
            <ul className="person-search-results">
              {results.map((match) => {
                const barring = match.notices.filter((notice) => noticeStillBarsEntry(notice.expiry_state));
                return (
                  <li key={match.canonical_person_id}>
                    <button
                      type="button"
                      className={`person-search-result${selectedId === match.canonical_person_id ? ' is-selected' : ''}${barring.length > 0 ? ' has-notice' : ''}`}
                      aria-pressed={selectedId === match.canonical_person_id}
                      onClick={() => setSelectedId(match.canonical_person_id)}
                    >
                      <strong>{match.display_name}</strong>
                      <span>{barring.length > 0
                        ? `${barring.length} notice${barring.length === 1 ? '' : 's'} in force`
                        : `${match.notices.length} notice${match.notices.length === 1 ? '' : 's'} on record`}
                        {match.vehicles.length > 0 ? ` · ${match.vehicles.length} vehicle${match.vehicles.length === 1 ? '' : 's'}` : ''}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {selected && (
        <article className="person-search-profile" aria-labelledby="person-search-profile-name">
          <header className="contact-card">
            <h2 id="person-search-profile-name">{selected.display_name}</h2>
            {selected.aliases.length > 0 && <p>Also known as: {selected.aliases.join(', ')}</p>}
            <p className="subtitle">Recorded by: {selected.organizations.join(', ') || 'Not recorded'}</p>
            {selected.review_state && selected.review_state !== 'verified' && <p className="subtitle">Identity not yet verified ({selected.review_state.replace(/_/g, ' ')}).</p>}
          </header>

          <SafetyWarningsPanel entityType="person" entityId={selected.canonical_person_id} entityLabel="this person" />

          <section className="contact-card" aria-labelledby="person-notices-title">
            <h3 id="person-notices-title">Notices and letters ({selected.notices.length})</h3>
            {selected.notices.length === 0 ? <p>No notices on record in your organisations.</p> : (
              <ul className="person-notice-list">
                {selected.notices.map((notice) => (
                  <li key={notice.notice_id} className={`person-notice is-${notice.expiry_state}`}>
                    <div>
                      <strong>{noticeTypeLabel(notice.notice_type)}{notice.notice_number ? ` ${notice.notice_number}` : ''}</strong>
                      <span className={`person-notice-badge is-${notice.expiry_state}`}>{noticeExpiryLabel(notice.expiry_state)}</span>
                    </div>
                    <p>{notice.organization_name}{notice.location_name ? ` · ${notice.location_name}` : ''}</p>
                    <p>Issued {formatNzDate(notice.issued_at)} · Expires {formatNzDate(notice.expires_at)}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="contact-card" aria-labelledby="person-vehicles-title">
            <h3 id="person-vehicles-title">Linked vehicles ({selected.vehicles.length})</h3>
            {selected.vehicles.length === 0 ? <p>No vehicles linked.</p> : (
              <ul className="person-vehicle-list">
                {selected.vehicles.map((vehicle) => (
                  <li key={`${vehicle.canonical_vehicle_id}-${vehicle.relationship ?? ''}`}>
                    <strong className="person-vehicle-plate">{vehicle.plate_number}</strong>
                    {' '}{[vehicle.colour, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Vehicle details not recorded'}
                    {vehicle.relationship ? ` · ${vehicle.relationship.replace(/_/g, ' ')}` : ''}
                    {vehicle.since ? ` since ${formatNzDate(vehicle.since)}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {selected.nzta_authorised && (
            <section className="contact-card" aria-labelledby="person-nzta-title">
              <h3 id="person-nzta-title">NZTA register details (restricted)</h3>
              {!selected.nzta ? <p>No NZTA register check on record.</p> : (
                <>
                  <p>Address at last check: {selected.nzta.address ?? 'Not recorded'}</p>
                  <p>Last checked: {formatNzDate(selected.nzta.last_checked_at)}</p>
                  {selected.nzta.checks.length > 0 && (
                    <p>Checks: {selected.nzta.checks.map((check) => `${check.plate_number} (${formatNzDate(check.checked_at)})`).join(', ')}</p>
                  )}
                </>
              )}
            </section>
          )}
        </article>
      )}
    </div>
  );
};

export default PersonSearchPage;
