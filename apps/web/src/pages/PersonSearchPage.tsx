/**
 * PersonSearchPage.tsx (shared operations and authorized officer lookup)
 *
 * Canonical schema:
 * - search_people (canonical_people + person_record_aliases + notices +
 *   entity_links + person_permits, scoped to the caller's organisations;
 *   private contacts only for operations roles; NZTA separately authorized,
 *   then hidden until reveal_nzta_registered_person opens a logged window;
 *   a permit holder is found by name, alias or exact permit number)
 * - get_notice_expiry_register (issued trespass/warning notices expiring soon
 *   or recently expired; fed daily into notifications by
 *   sweep_notice_expiry_alerts)
 * - get_safety_warnings via SafetyWarningsPanel (platform-wide, redacted)
 *
 * Cross-links: `?person=<canonical_person_id>` with router state
 * `{ personQuery }` opens one person from a vehicle owner card (the name stays
 * out of the URL); linked vehicles open vehicle search by canonical id.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Car, RefreshCw, Search, ShieldAlert } from 'lucide-react';
import { SafetyWarningsPanel } from '../components/SafetyWarningsPanel';
import { PermitAccessCard } from '../components/PermitAccessCard';
import { NztaRevealDialog, nztaWarningText, type NztaRevealResult } from '../components/NztaRevealDialog';
import { supabase } from '../lib/supabase';
import { useNztaRevealExpiry } from '../lib/useNztaRevealExpiry';
import { permitIsCurrent, permitValidity } from '../lib/permits';
import {
  describeDaysRemaining,
  formatNzDate,
  noticeExpiryLabel,
  noticeStillBarsEntry,
  noticeTypeLabel,
  personPermitSummaries,
  personSearchQueryIsValid,
  type NoticeRegisterRow,
  type PersonMatch,
} from '../lib/personSearch';
import './PageStyles.css';
import './PersonSearchPage.css';

type PersonFilter = 'all' | 'in_force' | 'notice_history' | 'permits' | 'vehicles';

const PERSON_FILTERS: Array<{ id: PersonFilter; label: string }> = [
  { id: 'all', label: 'All people' },
  { id: 'in_force', label: 'Notice in force' },
  { id: 'notice_history', label: 'Notice history' },
  { id: 'permits', label: 'Permit holder' },
  { id: 'vehicles', label: 'Linked vehicle' },
];

const currentPermitCount = (match: PersonMatch) =>
  (match.permits ?? []).filter((permit) => permitIsCurrent(permitValidity(permit))).length;

const PersonSearchPage: React.FC<{ officer?: boolean }> = ({ officer = false }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const routedPersonId = searchParams.get('person');
  const routedState = location.state as { personQuery?: unknown } | null;
  const routedQuery = typeof routedState?.personQuery === 'string' ? routedState.personQuery : null;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PersonMatch[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<PersonFilter>('all');
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [register, setRegister] = useState<NoticeRegisterRow[] | null>(null);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registerRefreshing, setRegisterRefreshing] = useState(false);
  const [registerUpdatedAt, setRegisterUpdatedAt] = useState<string | null>(null);
  const [revealOpen, setRevealOpen] = useState(false);
  const [nztaReveal, setNztaReveal] = useState<(NztaRevealResult & { personId: string }) | null>(null);

  const loadRegister = useCallback(async () => {
    setRegisterRefreshing(true);
    setRegisterError(null);
    try {
      const { data, error: rpcError } = await supabase.rpc('get_notice_expiry_register', { p_window_days: 30, p_expired_days: 90 });
      if (rpcError) {
        setRegisterError('The notice expiry register could not be refreshed. Retry, or continue with the last successfully loaded results.');
        return;
      }
      setRegister((data ?? []) as NoticeRegisterRow[]);
      setRegisterUpdatedAt(new Date().toISOString());
    } catch {
      setRegisterError('The notice expiry register could not be refreshed. Check your connection and retry.');
    } finally {
      setRegisterRefreshing(false);
    }
  }, []);

  useEffect(() => { if (!officer) void loadRegister(); }, [loadRegister, officer]);

  // quiet: refresh in place (used to remask NZTA data) without clearing the view first.
  const runSearch = useCallback(async (text: string, focusPersonId?: string | null, quiet = false) => {
    if (!personSearchQueryIsValid(text)) {
      setError('Enter at least two letters or numbers of a name, alias or permit number.');
      return;
    }
    setSearching(true);
    setError(null);
    if (!quiet) {
      setResults(null);
      setSelectedId(null);
      setFilter('all');
    }
    try {
      const { data, error: rpcError } = await supabase.rpc('search_people', { p_query: text, p_limit: 25 });
      if (rpcError) {
        if (quiet) { setResults(null); setSelectedId(null); }
        setError('Person search did not complete. Check your access or connection, then retry.');
        return;
      }
      const matches = ((data ?? []) as PersonMatch[]).map((match) => ({ ...match, permits: match.permits ?? [] }));
      setResults(matches);
      const focus = focusPersonId && matches.some((match) => match.canonical_person_id === focusPersonId)
        ? focusPersonId
        : matches.length === 1 ? matches[0].canonical_person_id : null;
      setSelectedId(focus);
    } catch {
      if (quiet) { setResults(null); setSelectedId(null); }
      setError('Person search did not complete. Check your connection and retry.');
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    if (!routedQuery || !personSearchQueryIsValid(routedQuery)) return;
    setQuery(routedQuery);
    void runSearch(routedQuery, routedPersonId);
  }, [routedPersonId, routedQuery, runSearch]);

  const openVehicle = (canonicalVehicleId: string, plateNumber: string) => {
    navigate(officer
      ? `/officer/vehicle_lookup?plate=${encodeURIComponent(plateNumber)}`
      : `/admin/field-ops?area=vehicle-search&vehicle=${encodeURIComponent(canonicalVehicleId)}`);
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void runSearch(query);
  };

  const openFromRegister = (row: NoticeRegisterRow) => {
    if (!row.person_display_name) return;
    setQuery(row.person_display_name);
    void runSearch(row.person_display_name, row.canonical_person_id);
  };

  const filterCounts = useMemo(() => ({
    all: results?.length ?? 0,
    in_force: results?.filter((match) => match.notices.some((notice) => noticeStillBarsEntry(notice.expiry_state))).length ?? 0,
    notice_history: results?.filter((match) => match.notices.length > 0).length ?? 0,
    permits: results?.filter((match) => (match.permits ?? []).length > 0).length ?? 0,
    vehicles: results?.filter((match) => match.vehicles.length > 0).length ?? 0,
  }), [results]);
  const filteredMatches = useMemo(() => (results ?? []).filter((match) => {
    if (filter === 'in_force') return match.notices.some((notice) => noticeStillBarsEntry(notice.expiry_state));
    if (filter === 'notice_history') return match.notices.length > 0;
    if (filter === 'permits') return (match.permits ?? []).length > 0;
    if (filter === 'vehicles') return match.vehicles.length > 0;
    return true;
  }), [filter, results]);
  const selected = filteredMatches.find((match) => match.canonical_person_id === selectedId) ?? null;
  const selectedPermits = useMemo(() => (selected ? personPermitSummaries(selected) : []), [selected]);
  const selectedNztaVisible = Boolean(selected && (selected.nzta || nztaReveal?.personId === selected.canonical_person_id));
  useNztaRevealExpiry({
    subjectType: 'person', subjectId: selected?.canonical_person_id, enabled: selectedNztaVisible,
    onExpire: () => {
      if (!selected) return;
      setNztaReveal(null);
      void runSearch(query.trim() || selected.display_name, selected.canonical_person_id, true);
    },
  });
  const expiringCount = register?.filter((row) => row.expiry_state === 'expiring_soon').length ?? 0;
  const expiredCount = register?.filter((row) => row.expiry_state === 'expired').length ?? 0;

  return (
    <main className="page-container person-search-page">
      <header className="page-header person-search-header">
        <div>
          <p className="eyebrow">Field operations / identity registry</p>
          <h1>Person search</h1>
          <p className="subtitle">Review a person’s notice history, expiry status, access permits and linked vehicles across organisations you can access.</p>
        </div>
        <aside className="person-search-scope" aria-label="Search scope">
          <span>Search scope</span>
          <strong>Authorised organisations</strong>
          <small>{officer ? 'Read-only notice and permit checks. Personal addresses and contact details require administrator authority in either portal.' : 'Results and restricted identity details follow your organisation access.'}</small>
        </aside>
      </header>

      <section className="person-search-command" aria-labelledby="person-search-title">
        <div className="person-search-command__intro">
          <div>
            <h2 id="person-search-title">Find a person</h2>
            <p id="person-search-help">Search by full or partial name, surname first or last, a known alias, or an exact permit number. People with an active or expiring notice appear first.</p>
          </div>
        </div>
        <form className="person-search-form" onSubmit={handleSubmit} role="search">
          <label htmlFor="person-search-input" className="sr-only">Name, alias or permit number</label>
          <div className="person-search-input-wrap">
            <Search size={18} aria-hidden="true" />
            <input
              id="person-search-input"
              type="search"
              autoComplete="off"
              aria-invalid={Boolean(error && !personSearchQueryIsValid(query))}
              aria-describedby={error ? 'person-search-help person-search-error' : 'person-search-help'}
              placeholder="Name, alias or permit number"
              value={query}
              disabled={searching}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={searching}>
            {searching ? <><RefreshCw size={16} className="is-spinning" aria-hidden="true" /> Searching</> : 'Search'}
          </button>
          {query && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={searching}
              onClick={() => {
                setQuery('');
                setResults(null);
                setSelectedId(null);
                setFilter('all');
                setError(null);
              }}
            >
              Clear
            </button>
          )}
        </form>
        {error && <div id="person-search-error" className="alert alert-error person-search-error" role="alert">{error}</div>}
        {routedPersonId && !routedQuery && results === null && !searching && (
          <p className="person-search-handoff" role="status">This link opens a specific person record, but the name was not passed with it. Search by name to open the record.</p>
        )}
      </section>

      <section className="person-search-workspace" aria-label="Person search results and details">
        <section className="person-search-matches" aria-labelledby="person-search-matches-title">
          <header className="person-search-section-head">
            <div>
              <p className="eyebrow">Search results</p>
              <h2 id="person-search-matches-title">Matching people</h2>
            </div>
            {results !== null && !searching && <span className="person-search-count">{results.length} found</span>}
          </header>

          {searching && <p className="person-search-state" role="status"><RefreshCw size={16} className="is-spinning" aria-hidden="true" /> Searching authorised records…</p>}
          {!searching && results === null && (
            <div className="person-search-empty">
              <Search size={20} aria-hidden="true" />
              <strong>Search to open a person record</strong>
              <p>Enter at least two letters or numbers. Use filters after searching to narrow the first 25 matches.</p>
            </div>
          )}
          {!searching && results?.length === 0 && (
            <div className="person-search-empty" role="status">
              <strong>No matching people found</strong>
              <p>Check the spelling, or try a known alias or the exact permit number. Search is limited to organisations you are authorised to access.</p>
            </div>
          )}
          {!searching && results && results.length > 0 && (
            <>
              <p className="person-search-result-count" role="status">
                {results.length === 25 ? 'Showing the first 25 matches. Refine the name, alias or permit number to find another record.' : `${results.length} ${results.length === 1 ? 'person' : 'people'} matched.`}
              </p>
              <div className="person-search-filters" role="group" aria-label="Filter matching people">
                {PERSON_FILTERS.map((option) => (
                  <button
                    type="button"
                    key={option.id}
                    className={`person-search-filter${filter === option.id ? ' is-active' : ''}`}
                    aria-pressed={filter === option.id}
                    disabled={option.id !== 'all' && filterCounts[option.id] === 0}
                    onClick={() => {
                      setFilter(option.id);
                      setSelectedId(null);
                    }}
                  >
                    {option.label}<span>{filterCounts[option.id]}</span>
                  </button>
                ))}
              </div>
              {filteredMatches.length === 0 ? (
                <p className="person-search-empty-filter" role="status">No matches have this information on record.</p>
              ) : (
                <ul className="person-search-results">
                  {filteredMatches.map((match) => {
                    const barring = match.notices.filter((notice) => noticeStillBarsEntry(notice.expiry_state));
                    const permitCount = (match.permits ?? []).length;
                    const currentPermits = currentPermitCount(match);
                    const recordStatus = barring.length > 0
                      ? `${barring.length} notice${barring.length === 1 ? '' : 's'} in force`
                      : match.notices.length > 0 ? `${match.notices.length} notice${match.notices.length === 1 ? '' : 's'} on record` : 'No notices on record';
                    const badge = barring.length > 0 ? 'Notice in force' : currentPermits > 0 ? 'Current permit' : permitCount > 0 ? 'Permit holder' : 'Record';
                    return (
                      <li key={match.canonical_person_id}>
                        <button
                          type="button"
                          className={`person-search-result${selectedId === match.canonical_person_id ? ' is-selected' : ''}${barring.length > 0 ? ' has-notice' : ''}`}
                          aria-pressed={selectedId === match.canonical_person_id}
                          onClick={() => setSelectedId(match.canonical_person_id)}
                        >
                          <span className="person-search-result__top">
                            <strong>{match.display_name}</strong>
                            <span className={`person-search-result__notice${barring.length > 0 ? ' is-active' : currentPermits > 0 ? ' is-permit' : ''}`}>{badge}</span>
                          </span>
                          <span>
                            {recordStatus}
                            {permitCount > 0 ? ` · ${permitCount} permit${permitCount === 1 ? '' : 's'}` : ''}
                            {match.vehicles.length > 0 ? ` · ${match.vehicles.length} linked vehicle${match.vehicles.length === 1 ? '' : 's'}` : ''}
                          </span>
                          <small>{match.organizations.join(', ') || 'Organisation not recorded'}</small>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </section>

        <section className="person-search-detail" aria-label="Selected person details">
          {!selected && (
            <div className="person-search-detail-empty">
              <strong>{searching ? 'Loading person records' : results?.length ? 'Select a person' : 'Person record'}</strong>
              <p>{searching
                ? 'The previous result has been cleared while the new search completes.'
                : results?.length ? 'Choose a match to review their notices, access permits, linked vehicles and permitted identity details.'
                  : 'A selected record will show notice status, source dates and linked operational information here.'}</p>
            </div>
          )}
          {selected && (
            <article className="person-search-profile" aria-labelledby="person-search-profile-name">
              <header className="person-search-profile-head">
                <div>
                  <p className="eyebrow">Canonical person record</p>
                  <h2 id="person-search-profile-name">{selected.display_name}</h2>
                  {selected.aliases.length > 0 && <p className="person-search-aliases">Also known as: {selected.aliases.join(', ')}</p>}
                  <p className="person-search-organisations">Recorded in {selected.organizations.join(', ') || 'no organisation recorded'}</p>
                </div>
                <span className={`person-search-identity-state${selected.review_state === 'verified' ? ' is-verified' : ' is-review'}`}>
                  {selected.review_state === 'verified' ? 'Identity verified' : selected.review_state ? `Review required · ${selected.review_state.replace(/_/g, ' ')}` : 'Identity status not recorded'}
                </span>
              </header>

              <SafetyWarningsPanel entityType="person" entityId={selected.canonical_person_id} entityLabel="this person" />

              <section className="person-search-profile-section" aria-labelledby="person-notices-title">
                <header className="person-search-section-head">
                  <div><p className="eyebrow">Restrictions and correspondence</p><h3 id="person-notices-title">Notices and letters</h3></div>
                  <span className="person-search-count">{selected.notices.length}</span>
                </header>
                {selected.notices.length === 0 ? <p className="person-search-section-empty">No notices or letters are recorded in your authorised organisations.</p> : (
                  <ul className="person-notice-list">
                    {selected.notices.map((notice) => (
                      <li key={notice.notice_id} className={`person-notice is-${notice.expiry_state}`}>
                        <div className="person-notice__head">
                          <div>
                            <strong>{noticeTypeLabel(notice.notice_type)}{notice.notice_number ? ` · ${notice.notice_number}` : ''}</strong>
                            <p>{notice.organization_name}{notice.location_name ? ` · ${notice.location_name}` : ''}</p>
                          </div>
                          <span className={`person-notice-badge is-${notice.expiry_state}`}>{noticeExpiryLabel(notice.expiry_state)}</span>
                        </div>
                        <dl className="person-notice__dates">
                          <div><dt>Issued</dt><dd>{formatNzDate(notice.issued_at)}</dd></div>
                          <div><dt>Expires</dt><dd>{formatNzDate(notice.expires_at)}</dd></div>
                        </dl>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="person-search-legal-note">Only issued trespass and warning notices count as entry restrictions. Permit refusal and contact request letters are shown for context.</p>
              </section>

              <section className="person-search-profile-section" aria-labelledby="person-permits-title">
                <header className="person-search-section-head">
                  <div><p className="eyebrow">Access permissions</p><h3 id="person-permits-title">Forest and site access permits</h3></div>
                  <span className="person-search-count">{selectedPermits.length}</span>
                </header>
                {selectedPermits.length === 0 ? <p className="person-search-section-empty">No access permits are recorded in your authorised organisations.</p> : (
                  <ul className="person-permit-list">
                    {selectedPermits.map((permit) => (
                      <li key={permit.id}>
                        <PermitAccessCard
                          permit={permit}
                          showContact={selected.contact_details_authorised === true}
                          actionsDisabled={searching}
                          onOpenVehicle={(vehicle) => {
                            if (vehicle.canonical_vehicle_id) openVehicle(vehicle.canonical_vehicle_id, vehicle.plate_number);
                          }}
                        />
                      </li>
                    ))}
                  </ul>
                )}
                {selectedPermits.length > 0 && (
                  <p className="person-search-legal-note">Validity is worked out from the permit dates in New Zealand time; the finishing date is the last valid day. {selected.contact_details_authorised ? 'Contact details are as captured on the application and may not be current.' : 'For contact details, ask the administration team.'}</p>
                )}
              </section>

              <section className="person-search-profile-section" aria-labelledby="person-vehicles-title">
                <header className="person-search-section-head">
                  <div><p className="eyebrow">Canonical links</p><h3 id="person-vehicles-title">Linked vehicles</h3></div>
                  <span className="person-search-count">{selected.vehicles.length}</span>
                </header>
                {selected.vehicles.length === 0 ? <p className="person-search-section-empty">No vehicles are linked to this person in your authorised organisations.</p> : (
                  <ul className="person-vehicle-list">
                    {selected.vehicles.map((vehicle) => {
                      const nztaObservation = vehicle.source === 'nzta_mvr' && vehicle.source_checked_at;
                      return (
                        <li key={`${vehicle.canonical_vehicle_id}-${vehicle.relationship ?? ''}`}>
                          <div className="person-vehicle__main">
                            <strong className="person-vehicle-plate">{vehicle.plate_number}</strong>
                            <span>{[vehicle.colour, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Vehicle details not recorded'}</span>
                          </div>
                          <p>{vehicle.relationship ? vehicle.relationship.replace(/_/g, ' ') : 'Vehicle link'}
                            {nztaObservation
                              ? ` · NZTA observation ${formatNzDate(vehicle.source_checked_at)} (not a legal transfer date)`
                              : vehicle.since ? ` · Recorded from ${formatNzDate(vehicle.since)}` : ''}</p>
                          <button
                            type="button"
                            className="btn btn-sm btn-secondary person-vehicle__open"
                            aria-label={`Open vehicle ${vehicle.plate_number} in vehicle search`}
                            onClick={() => openVehicle(vehicle.canonical_vehicle_id, vehicle.plate_number)}
                          >
                            <Car size={14} aria-hidden="true" /> Open vehicle
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              {selected.nzta_authorised ? (
                <section className="person-search-profile-section person-search-nzta" aria-labelledby="person-nzta-title">
                  <header className="person-search-section-head">
                    <div><p className="eyebrow">Restricted identity information</p><h3 id="person-nzta-title">NZTA register details</h3></div>
                  </header>
                  <p className="person-search-privacy"><ShieldAlert size={16} aria-hidden="true" /> NZTA information is restricted to authorised users and lawful purposes. Do not share it outside your organisation.</p>
                  {nztaReveal?.personId === selected.canonical_person_id && <p className="person-search-privacy" role="status">Visible until {new Date(nztaReveal.revealed_until).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}. Your access has been logged.{nztaWarningText(nztaReveal.warnings) ? ` ${nztaWarningText(nztaReveal.warnings)}` : ''}</p>}
                  {selected.nzta_reveal_required && (
                    <div className="person-search-section-empty">
                      <p>{selected.nzta
                        ? 'More NZTA register information is held for this person by another organisation you are authorised for. It stays hidden until you state why you need it, and each view is logged.'
                        : 'NZTA register information is held for this person. It stays hidden until you state why you need it, and each view is logged.'}</p>
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => setRevealOpen(true)}>Reveal with a stated purpose</button>
                    </div>
                  )}
                  {!selected.nzta ? (!selected.nzta_reveal_required && <p className="person-search-section-empty">No NZTA register check is recorded for this person.</p>) : (
                    <>
                      <dl className="person-nzta-facts">
                        {selected.contact_details_authorised === true && <div><dt>Address at last check</dt><dd>{selected.nzta.address ?? 'Not recorded'}</dd></div>}
                        <div><dt>Last checked</dt><dd>{formatNzDate(selected.nzta.last_checked_at)}</dd></div>
                      </dl>
                      {selected.nzta.checks.length > 0 && (
                        <div className="reports-table-wrapper person-nzta-history">
                          <table className="reports-table">
                            <caption>NZTA source-check observations; these are not legal transfer dates</caption>
                            <thead><tr><th>Plate</th><th>Checked</th></tr></thead>
                            <tbody>{selected.nzta.checks.map((check, index) => (
                              <tr key={`${check.plate_number}-${check.checked_at}-${index}`}>
                                <td>{check.plate_number}</td><td>{formatNzDate(check.checked_at)}</td>
                              </tr>
                            ))}</tbody>
                          </table>
                        </div>
                      )}
                    </>
                  )}
                </section>
              ) : (
                <p className="person-search-restricted-note"><ShieldAlert size={16} aria-hidden="true" /> NZTA register details are restricted and are not available in your current access scope.</p>
              )}
              {revealOpen && (
                <NztaRevealDialog
                  subjectType="person"
                  subjectId={selected.canonical_person_id}
                  subjectLabel={selected.display_name}
                  onClose={() => setRevealOpen(false)}
                  onRevealed={(result) => {
                    const personId = selected.canonical_person_id;
                    setRevealOpen(false);
                    setNztaReveal({ ...result, personId });
                    void runSearch(query.trim() || selected.display_name, personId);
                  }}
                />
              )}
            </article>
          )}
        </section>
      </section>

      {!officer && <section className="person-search-register" aria-labelledby="person-search-register-title">
        <header className="person-search-register-head">
          <div>
            <p className="eyebrow">Expiry monitoring</p>
            <h2 id="person-search-register-title">Notice review queue</h2>
            <p>Issued trespass and warning notices expiring in the next 30 days or expired in the last 90 days.</p>
          </div>
          <button type="button" className="btn btn-secondary person-search-refresh" onClick={() => void loadRegister()} disabled={registerRefreshing}>
            <RefreshCw size={16} className={registerRefreshing ? 'is-spinning' : undefined} aria-hidden="true" />
            {registerRefreshing ? 'Refreshing…' : 'Refresh queue'}
          </button>
        </header>
        <div className="person-search-register-summary" role="group" aria-label="Notice review queue summary">
          <div><strong>{register === null ? '—' : expiringCount}</strong><span>Expiring within 30 days</span></div>
          <div><strong>{register === null ? '—' : expiredCount}</strong><span>Expired in the last 90 days</span></div>
        </div>
        {registerUpdatedAt && (
          <p className="person-search-freshness" role="status">
            Last successfully refreshed {new Date(registerUpdatedAt).toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland' })}
            {registerError ? ' · Showing the last successful results.' : ''}
          </p>
        )}
        {registerError && (
          <div className="person-search-register-error" role="alert">
            <span>{registerError}</span>
            <button type="button" className="btn btn-secondary" onClick={() => void loadRegister()} disabled={registerRefreshing}>Retry</button>
          </div>
        )}
        {register === null && !registerError && <p className="person-search-state" role="status"><RefreshCw size={16} className="is-spinning" aria-hidden="true" /> Loading expiry queue…</p>}
        {register !== null && register.length === 0 && !registerRefreshing && (
          <p className="person-search-section-empty" role="status">No notices are in this review window. Admins also receive the daily expiry alert.</p>
        )}
        {register !== null && register.length > 0 && (
          <div className="reports-table-wrapper person-search-register-table-wrap" role="region" tabIndex={0} aria-label="Notice expiry review queue">
            <table className="reports-table person-search-register-table">
              <thead><tr><th>Person</th><th>Notice</th><th>Client</th><th>Place</th><th>Expiry</th></tr></thead>
              <tbody>{register.map((row) => (
                <tr key={row.notice_id}>
                  <td data-label="Person">{row.person_display_name
                    ? <button type="button" className="person-search-register-person" disabled={searching} onClick={() => openFromRegister(row)}>{row.person_display_name}</button>
                    : <span className="person-search-unlinked">Person not linked</span>}</td>
                  <td data-label="Notice">{noticeTypeLabel(row.notice_type)}{row.notice_number ? ` · ${row.notice_number}` : ''}</td>
                  <td data-label="Client">{row.organization_name}</td>
                  <td data-label="Place">{row.location_name ?? 'Not recorded'}</td>
                  <td data-label="Expiry"><span className={`person-notice-badge is-${row.expiry_state}`}>{noticeExpiryLabel(row.expiry_state)}</span>
                    <span className="person-search-expiry-date">{formatNzDate(row.expires_at)}{row.days_remaining !== null ? ` · ${describeDaysRemaining(row.days_remaining)}` : ''}</span></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>}
    </main>
  );
};

export default PersonSearchPage;
