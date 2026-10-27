/**
 * NztaRegisterPage.tsx — NZTA s241 Motor Vehicle Register readiness.
 *
 * Canonical schema (supabase/migrations/20261101160000_nzta_s241_readiness.sql):
 * - nzta_register_lookups via record_nzta_register_lookup,
 *   set_nzta_register_lookup_outcome, list_nzta_register_lookups (T&C 13-16)
 * - nzta_register_access_log via list_nzta_register_access_log
 * - nzta_access_attestations via record_nzta_access_attestation,
 *   withdraw_nzta_access_attestation, get_nzta_access_holders (T&C 11-12)
 * - nzta_access_reviews via record_nzta_access_review, list_nzta_access_reviews
 * - get_nzta_s241_summary for the annual report (T&C 19) with signage evidence
 *   per zone and report-only retention counts.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ClipboardList, Download, FileText, Printer, RefreshCw, Search, ShieldCheck, Users } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { ShellLayout } from '../layouts/ShellLayout';
import { supabase } from '../lib/supabase';
import {
  LOOKUP_OUTCOMES, LOOKUP_PURPOSES, MIN_EXPLANATION, NZTA_USE_NOTICE, downloadCsv, formatNzDateTime, nztaLabel, toCsv,
  type LookupOutcome, type LookupPurpose,
} from '../lib/nztaRegister';
import './NztaRegisterPage.css';

type Tab = 'lookups' | 'access' | 'people' | 'reviews' | 'summary';

const TABS: Array<{ id: Tab; label: string; hint: string }> = [
  { id: 'lookups', label: 'Lookup register', hint: 'Every Motochek lookup, its purpose and outcome' },
  { id: 'access', label: 'Access log', hint: 'Who viewed NZTA information in this app, and why' },
  { id: 'people', label: 'People & training', hint: 'Authorised staff, training and confidentiality' },
  { id: 'reviews', label: 'Quarterly reviews', hint: 'Who still needs access' },
  { id: 'summary', label: 'Annual summary', hint: 'Report figures, signage and retention' },
];

export interface LookupRow {
  entry_kind: 'lookup' | 'historical_check';
  entry_id: string;
  looked_up_at: string;
  plate_number: string | null;
  vin: string | null;
  motochek_user: string | null;
  purpose: LookupPurpose | null;
  explanation: string | null;
  outcome: LookupOutcome | null;
  outcome_notes: string | null;
  place_name: string | null;
  observation_id: string | null;
  notice_number: string | null;
  vehicle_identity_check_id: string | null;
  recorded_by_name: string | null;
  recorded_at: string;
  can_edit: boolean;
}

interface AccessLogRow {
  log_id: string;
  revealed_at: string;
  expires_at: string;
  actor_name: string | null;
  subject_type: 'vehicle' | 'person';
  subject_label: string | null;
  purpose: string;
  explanation: string;
  notice_number: string | null;
  lookup_id: string | null;
  training_current: boolean;
  confidentiality_current: boolean;
}

interface Holder {
  user_id: string;
  display_name: string | null;
  role: string;
  via_role: boolean;
  direct: boolean;
  via_preset: boolean;
  holds_access: boolean;
  home_organization: boolean;
  granted_at: string | null;
  training_completed_on: string | null;
  training_expires_on: string | null;
  training_current: boolean;
  confidentiality_completed_on: string | null;
  confidentiality_expires_on: string | null;
  confidentiality_current: boolean;
}

interface Attestation {
  id: string;
  user_id: string;
  attestation_type: 'training' | 'confidentiality';
  completed_on: string;
  expires_on: string;
  provider: string | null;
  notes: string | null;
  created_at: string;
  withdrawn_at: string | null;
  withdrawn_reason: string | null;
}

interface Review {
  review_id: string;
  period_start: string;
  period_end: string;
  reviewed_at: string;
  reviewed_by_name: string | null;
  holder_count: number;
  findings: string;
  actions: string | null;
}

interface Summary {
  period: { from: string; to: string };
  lookups: { total: number; by_purpose: Record<string, number>; by_outcome: Record<string, number>; historical_checks_without_purpose: number };
  reveals: { total: number; by_purpose: Record<string, number>; without_current_training: number };
  holders: { total: number; training_current: number; confidentiality_current: number };
  reviews: { in_period: number; last_reviewed_at: string | null };
  signage: Array<{ zone_id: string; zone_name: string; evidence_count: number; sign_types: string[]; latest_captured_at: string | null }>;
  retention: {
    note: string;
    checks_older_than_18_months: number;
    checks_older_than_2_years: number;
    checks_older_than_5_years: number;
    lookups_older_than_18_months: number;
    lookups_older_than_2_years: number;
    lookups_older_than_5_years: number;
    reveals_older_than_18_months: number;
    reveals_older_than_2_years: number;
    reveals_older_than_5_years: number;
  };
}

const pad = (value: number) => String(value).padStart(2, '0');
// Local (NZ) calendar dates; toISOString would shift to UTC and be a day off.
const localDate = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const localDateTime = (date: Date) => `${localDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
const today = () => localDate(new Date());
const daysAgo = (days: number) => { const date = new Date(); date.setDate(date.getDate() - days); return localDate(date); };
const startOf = (date: string) => (date ? new Date(`${date}T00:00:00`).toISOString() : null);
const endOf = (date: string) => { if (!date) return null; const end = new Date(`${date}T00:00:00`); end.setDate(end.getDate() + 1); return end.toISOString(); };
const nzDate = (value: string | null | undefined) => (value ? new Date(value.length === 10 ? `${value}T00:00:00` : value).toLocaleDateString('en-NZ') : '—');
const friendlyError = (message: string | undefined, fallback: string) =>
  message && !/^(fetch|network|TypeError)/i.test(message) ? message : fallback;

const StateMessage: React.FC<{ kind: 'loading' | 'empty' | 'error'; children: React.ReactNode; onRetry?: () => void }> = ({ kind, children, onRetry }) => (
  <div className={`nzta-state is-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
    {kind === 'loading' ? <RefreshCw size={16} className="is-spinning" aria-hidden="true" /> : kind === 'error' ? <AlertTriangle size={16} aria-hidden="true" /> : <ClipboardList size={16} aria-hidden="true" />}
    <span>{children}</span>
    {onRetry && <button type="button" className="btn btn-sm btn-secondary" onClick={onRetry}>Retry</button>}
  </div>
);

const PeriodFilter: React.FC<{ from: string; to: string; onChange: (from: string, to: string) => void; search?: string; onSearch?: (value: string) => void; searchLabel?: string }> = ({ from, to, onChange, search, onSearch, searchLabel }) => (
  <div className="nzta-filters" role="group" aria-label="Filters">
    <label>From<input type="date" value={from} max={to || undefined} onChange={(event) => onChange(event.target.value, to)} /></label>
    <label>To<input type="date" value={to} min={from || undefined} max={today()} onChange={(event) => onChange(from, event.target.value)} /></label>
    {onSearch && (
      <label className="nzta-filters__search">{searchLabel ?? 'Search'}
        <span><Search size={15} aria-hidden="true" /><input type="search" value={search ?? ''} onChange={(event) => onSearch(event.target.value)} placeholder="Plate, VIN, user or reason" /></span>
      </label>
    )}
  </div>
);

// ---------------------------------------------------------------- Lookups --

const EMPTY_LOOKUP = { looked_up_at: '', plate_number: '', vin: '', motochek_user: '', purpose: '' as LookupPurpose | '', explanation: '', location_id: '' };

const LookupRegister: React.FC<{ organizationId: string }> = ({ organizationId }) => {
  const [from, setFrom] = useState(daysAgo(90));
  const [to, setTo] = useState(today());
  const [search, setSearch] = useState('');
  const [purposeFilter, setPurposeFilter] = useState<'all' | LookupPurpose | 'missing'>('all');
  const [outcomeFilter, setOutcomeFilter] = useState<'all' | LookupOutcome>('all');
  const [rows, setRows] = useState<LookupRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_LOOKUP);
  const [formTouched, setFormTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [places, setPlaces] = useState<Array<{ id: string; name: string }>>([]);
  const [editing, setEditing] = useState<{ id: string; outcome: LookupOutcome; notes: string } | null>(null);

  // ATLAS CALLS: list_nzta_register_lookups
  const load = useCallback(async () => {
    setRows(null);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc('list_nzta_register_lookups', {
      p_organization_id: organizationId, p_from: startOf(from), p_to: endOf(to), p_limit: 2000,
    });
    if (rpcError) { setError(friendlyError(rpcError.message, 'The lookup register could not be loaded.')); return; }
    setRows((data ?? []) as LookupRow[]);
  }, [from, organizationId, to]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!formOpen || places.length > 0) return;
    void supabase.from('locations').select('id, name').eq('organization_id', organizationId).order('name').limit(1000)
      .then(({ data }) => setPlaces((data ?? []) as Array<{ id: string; name: string }>));
  }, [formOpen, organizationId, places.length]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (rows ?? []).filter((row) => {
      if (purposeFilter === 'missing' ? row.purpose !== null : purposeFilter !== 'all' && row.purpose !== purposeFilter) return false;
      if (outcomeFilter !== 'all' && row.outcome !== outcomeFilter) return false;
      if (!term) return true;
      return [row.plate_number, row.vin, row.motochek_user, row.explanation, row.place_name, row.notice_number, row.recorded_by_name]
        .some((value) => value?.toLowerCase().includes(term));
    });
  }, [outcomeFilter, purposeFilter, rows, search]);

  const missingPurpose = (rows ?? []).filter((row) => row.entry_kind === 'historical_check').length;
  const plateOrVin = form.plate_number.trim() || form.vin.trim();
  const formProblems = [
    !form.looked_up_at && 'Enter when the lookup was made.',
    form.looked_up_at && new Date(form.looked_up_at) > new Date() && 'The lookup time cannot be in the future.',
    !plateOrVin && 'Enter the plate or the VIN that was looked up.',
    form.motochek_user.trim().length < 2 && 'Enter the individual Motochek user who made the lookup.',
    !form.purpose && 'Choose the Gazette purpose.',
    form.explanation.trim().length < MIN_EXPLANATION && `Explain the reason in at least ${MIN_EXPLANATION} characters.`,
  ].filter(Boolean) as string[];

  // ATLAS CALLS: record_nzta_register_lookup
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormTouched(true);
    if (formProblems.length > 0) return;
    setSaving(true);
    setFormError(null);
    const { error: rpcError } = await supabase.rpc('record_nzta_register_lookup', {
      p_organization_id: organizationId,
      p_looked_up_at: new Date(form.looked_up_at).toISOString(),
      p_plate_number: form.plate_number.trim() || null,
      p_vin: form.vin.trim() || null,
      p_motochek_user: form.motochek_user.trim(),
      p_purpose: form.purpose,
      p_explanation: form.explanation.trim(),
      p_location_id: form.location_id || null,
    });
    setSaving(false);
    if (rpcError) { setFormError(friendlyError(rpcError.message, 'The lookup could not be recorded. Try again.')); return; }
    setNotice(`Lookup for ${form.plate_number.trim().toUpperCase() || form.vin.trim().toUpperCase()} recorded. Set the outcome once you know it.`);
    setForm({ ...EMPTY_LOOKUP, motochek_user: form.motochek_user });
    setFormTouched(false);
    setFormOpen(false);
    await load();
  };

  // ATLAS CALLS: set_nzta_register_lookup_outcome
  const saveOutcome = async () => {
    if (!editing) return;
    setSaving(true);
    const { error: rpcError } = await supabase.rpc('set_nzta_register_lookup_outcome', {
      p_lookup_id: editing.id, p_outcome: editing.outcome, p_notes: editing.notes.trim() || null,
    });
    setSaving(false);
    if (rpcError) { setError(friendlyError(rpcError.message, 'The outcome could not be saved.')); return; }
    setNotice('Outcome saved.');
    setEditing(null);
    await load();
  };

  const exportCsv = () => downloadCsv(`nzta-lookup-register-${from}-to-${to}.csv`, toCsv(filtered.map((row) => ({
    ...row, looked_up_at: new Date(row.looked_up_at).toISOString(), purpose: row.purpose ? nztaLabel(row.purpose) : 'Not recorded (historical check)',
    outcome: row.outcome ? nztaLabel(row.outcome) : '',
  })), [
    ['looked_up_at', 'Date and time'], ['plate_number', 'Plate'], ['vin', 'VIN'], ['motochek_user', 'Motochek user'],
    ['purpose', 'Purpose'], ['explanation', 'Explanation'], ['place_name', 'Property'], ['notice_number', 'Notice'],
    ['outcome', 'Outcome'], ['outcome_notes', 'Outcome notes'], ['recorded_by_name', 'Recorded by'],
  ]));

  return (
    <section className="nzta-panel" aria-labelledby="nzta-lookups-title">
      <header className="nzta-panel__head">
        <div><h2 id="nzta-lookups-title">Lookup register</h2><p>Record every Motochek lookup with the individual user, the Gazette purpose and what happened next. NZTA can ask for this register at any time; keep it for at least 18 months.</p></div>
        <div className="nzta-panel__actions">
          <button type="button" className="btn btn-secondary" onClick={exportCsv} disabled={!rows || filtered.length === 0}><Download size={16} aria-hidden="true" /> Export CSV</button>
          <button type="button" className="btn btn-primary" aria-expanded={formOpen} onClick={() => { setFormOpen((open) => !open); setFormError(null); }}>{formOpen ? 'Close form' : 'Record a lookup'}</button>
        </div>
      </header>
      {notice && <p className="nzta-banner is-success" role="status"><CheckCircle2 size={16} aria-hidden="true" /> {notice}</p>}
      {missingPurpose > 0 && <p className="nzta-banner is-watch" role="note"><AlertTriangle size={16} aria-hidden="true" /> {missingPurpose} historical NZTA check{missingPurpose === 1 ? '' : 's'} in this period {missingPurpose === 1 ? 'has' : 'have'} no recorded purpose. They are listed for completeness and counted separately in the annual summary.</p>}

      {formOpen && (
        <form className="nzta-form" onSubmit={(event) => void submit(event)} noValidate aria-labelledby="nzta-lookup-form-title">
          <h3 id="nzta-lookup-form-title">Record a Motochek lookup</h3>
          <fieldset disabled={saving}>
            <div className="nzta-form__grid">
              <label>Date and time of lookup<input type="datetime-local" required value={form.looked_up_at} max={localDateTime(new Date())} onChange={(event) => setForm({ ...form, looked_up_at: event.target.value })} /></label>
              <label>Plate<input value={form.plate_number} maxLength={12} autoCapitalize="characters" onChange={(event) => setForm({ ...form, plate_number: event.target.value })} placeholder="ABC123" /></label>
              <label>VIN (if no plate)<input value={form.vin} maxLength={32} autoCapitalize="characters" onChange={(event) => setForm({ ...form, vin: event.target.value })} /></label>
              <label>Motochek user<input required value={form.motochek_user} maxLength={120} onChange={(event) => setForm({ ...form, motochek_user: event.target.value })} placeholder="The individual login used, not a shared account" /></label>
              <label>Property (optional)
                <select value={form.location_id} onChange={(event) => setForm({ ...form, location_id: event.target.value })}>
                  <option value="">Not linked to a property</option>
                  {places.map((place) => <option key={place.id} value={place.id}>{place.name}</option>)}
                </select>
              </label>
            </div>
            <fieldset className="nzta-form__purposes">
              <legend>Gazette purpose</legend>
              {LOOKUP_PURPOSES.map((option) => (
                <label key={option.id}><input type="radio" name="nzta-lookup-purpose" checked={form.purpose === option.id} onChange={() => setForm({ ...form, purpose: option.id })} />
                  <span><strong>{option.label}</strong><small>{option.hint}</small></span></label>
              ))}
            </fieldset>
            <label>Explanation<textarea required rows={3} maxLength={2000} value={form.explanation} onChange={(event) => setForm({ ...form, explanation: event.target.value })} placeholder="What happened and why the lookup was needed" /></label>
            <p className="nzta-hint">{NZTA_USE_NOTICE} Permit vetting and general investigations are not authorised purposes.</p>
            {formTouched && formProblems.length > 0 && <ul className="nzta-banner is-error" role="alert">{formProblems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
            {formError && <p className="nzta-banner is-error" role="alert">{formError}</p>}
            <div className="nzta-form__actions">
              <button type="button" className="btn btn-secondary" onClick={() => setFormOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">{saving ? 'Recording…' : 'Record lookup'}</button>
            </div>
          </fieldset>
        </form>
      )}

      <PeriodFilter from={from} to={to} onChange={(nextFrom, nextTo) => { setFrom(nextFrom); setTo(nextTo); }} search={search} onSearch={setSearch} />
      <div className="nzta-filters" role="group" aria-label="Purpose and outcome filters">
        <label>Purpose
          <select value={purposeFilter} onChange={(event) => setPurposeFilter(event.target.value as typeof purposeFilter)}>
            <option value="all">All purposes</option>
            {LOOKUP_PURPOSES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            <option value="missing">No purpose recorded (historical)</option>
          </select>
        </label>
        <label>Outcome
          <select value={outcomeFilter} onChange={(event) => setOutcomeFilter(event.target.value as typeof outcomeFilter)}>
            <option value="all">All outcomes</option>
            {LOOKUP_OUTCOMES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </label>
      </div>

      {error ? <StateMessage kind="error" onRetry={() => void load()}>{error}</StateMessage>
        : rows === null ? <StateMessage kind="loading">Loading the lookup register…</StateMessage>
          : filtered.length === 0 ? <StateMessage kind="empty">{rows.length === 0 ? 'No lookups are recorded for this period. Use “Record a lookup” after each Motochek search.' : 'No lookups match these filters.'}</StateMessage>
            : (
              <div className="nzta-table-wrap">
                <table className="nzta-table">
                  <caption className="sr-only">Motochek lookups, newest first</caption>
                  <thead><tr><th scope="col">When</th><th scope="col">Vehicle</th><th scope="col">Motochek user</th><th scope="col">Purpose and reason</th><th scope="col">Outcome</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>{filtered.map((row) => (
                    <tr key={`${row.entry_kind}-${row.entry_id}`} className={row.entry_kind === 'historical_check' ? 'is-historical' : undefined}>
                      <td data-label="When">{formatNzDateTime(row.looked_up_at)}<small>{row.place_name ?? ''}</small></td>
                      <td data-label="Vehicle"><strong>{row.plate_number ?? '—'}</strong>{row.vin && <small>VIN {row.vin}</small>}</td>
                      <td data-label="Motochek user">{row.motochek_user ?? <em>Not recorded</em>}<small>Recorded by {row.recorded_by_name ?? 'staff'}</small></td>
                      <td data-label="Purpose">{row.purpose ? nztaLabel(row.purpose) : <span className="nzta-badge is-watch">No purpose recorded</span>}<small>{row.explanation ?? 'Historical NZTA check imported before the register existed.'}</small></td>
                      <td data-label="Outcome">
                        {editing && editing.id === row.entry_id ? (
                          <div className="nzta-outcome-edit">
                            <label className="sr-only" htmlFor={`outcome-${row.entry_id}`}>Outcome</label>
                            <select id={`outcome-${row.entry_id}`} value={editing.outcome} onChange={(event) => setEditing({ ...editing, outcome: event.target.value as LookupOutcome })}>
                              {LOOKUP_OUTCOMES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                            </select>
                            <label className="sr-only" htmlFor={`outcome-notes-${row.entry_id}`}>Outcome notes</label>
                            <input id={`outcome-notes-${row.entry_id}`} value={editing.notes} maxLength={2000} placeholder="Notes (optional)" onChange={(event) => setEditing({ ...editing, notes: event.target.value })} />
                            <div><button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => void saveOutcome()}>Save</button><button type="button" className="btn btn-sm btn-secondary" onClick={() => setEditing(null)}>Cancel</button></div>
                          </div>
                        ) : row.outcome ? <><span className={`nzta-badge ${row.outcome === 'pending' ? 'is-watch' : 'is-normal'}`}>{nztaLabel(row.outcome)}</span>{row.notice_number && <small>Notice {row.notice_number}</small>}{row.outcome_notes && <small>{row.outcome_notes}</small>}</> : '—'}
                      </td>
                      <td data-label="">{row.entry_kind === 'lookup' && row.can_edit && editing?.id !== row.entry_id && (
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => setEditing({ id: row.entry_id, outcome: row.outcome ?? 'pending', notes: row.outcome_notes ?? '' })} aria-label={`Set outcome for ${row.plate_number ?? row.vin ?? 'lookup'}`}>Set outcome</button>
                      )}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
      {rows && <p className="nzta-count">{filtered.length.toLocaleString('en-NZ')} of {rows.length.toLocaleString('en-NZ')} entries shown</p>}
    </section>
  );
};

// ------------------------------------------------------------- Access log --

const AccessLog: React.FC<{ organizationId: string }> = ({ organizationId }) => {
  const [from, setFrom] = useState(daysAgo(90));
  const [to, setTo] = useState(today());
  const [search, setSearch] = useState('');
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [rows, setRows] = useState<AccessLogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ATLAS CALLS: list_nzta_register_access_log
  const load = useCallback(async () => {
    setRows(null);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc('list_nzta_register_access_log', {
      p_organization_id: organizationId, p_from: startOf(from), p_to: endOf(to), p_limit: 5000,
    });
    if (rpcError) { setError(friendlyError(rpcError.message, 'The access log could not be loaded.')); return; }
    setRows((data ?? []) as AccessLogRow[]);
  }, [from, organizationId, to]);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (rows ?? []).filter((row) => (!flaggedOnly || !row.training_current || !row.confidentiality_current)
      && (!term || [row.actor_name, row.subject_label, row.explanation, row.notice_number].some((value) => value?.toLowerCase().includes(term))));
  }, [flaggedOnly, rows, search]);

  const exportCsv = () => downloadCsv(`nzta-access-log-${from}-to-${to}.csv`, toCsv(filtered.map((row) => ({
    ...row, revealed_at: new Date(row.revealed_at).toISOString(), purpose: nztaLabel(row.purpose),
    training_current: row.training_current ? 'Yes' : 'No', confidentiality_current: row.confidentiality_current ? 'Yes' : 'No',
  })), [
    ['revealed_at', 'Viewed at'], ['actor_name', 'User'], ['subject_type', 'Subject type'], ['subject_label', 'Subject'],
    ['purpose', 'Purpose'], ['explanation', 'Reason'], ['notice_number', 'Notice'], ['training_current', 'Training current'],
    ['confidentiality_current', 'Confidentiality current'],
  ]));

  return (
    <section className="nzta-panel" aria-labelledby="nzta-access-title">
      <header className="nzta-panel__head">
        <div><h2 id="nzta-access-title">Access log</h2><p>Every time someone revealed an NZTA person–vehicle link in this app: who, when, the subject, and the stated purpose. Entries cannot be edited or removed.</p></div>
        <div className="nzta-panel__actions"><button type="button" className="btn btn-secondary" onClick={exportCsv} disabled={!rows || filtered.length === 0}><Download size={16} aria-hidden="true" /> Export CSV</button></div>
      </header>
      <PeriodFilter from={from} to={to} onChange={(nextFrom, nextTo) => { setFrom(nextFrom); setTo(nextTo); }} search={search} onSearch={setSearch} searchLabel="Search user, subject or reason" />
      <label className="nzta-check"><input type="checkbox" checked={flaggedOnly} onChange={(event) => setFlaggedOnly(event.target.checked)} /> Only views by people without current training or confidentiality</label>
      {error ? <StateMessage kind="error" onRetry={() => void load()}>{error}</StateMessage>
        : rows === null ? <StateMessage kind="loading">Loading the access log…</StateMessage>
          : filtered.length === 0 ? <StateMessage kind="empty">{rows.length === 0 ? 'No one has revealed NZTA information in this period.' : 'No views match these filters.'}</StateMessage>
            : (
              <div className="nzta-table-wrap">
                <table className="nzta-table">
                  <caption className="sr-only">NZTA information views, newest first</caption>
                  <thead><tr><th scope="col">Viewed</th><th scope="col">User</th><th scope="col">Subject</th><th scope="col">Purpose and reason</th><th scope="col">Readiness</th></tr></thead>
                  <tbody>{filtered.map((row) => (
                    <tr key={row.log_id}>
                      <td data-label="Viewed">{formatNzDateTime(row.revealed_at)}</td>
                      <td data-label="User">{row.actor_name ?? 'Unknown user'}</td>
                      <td data-label="Subject"><strong>{row.subject_label ?? '—'}</strong><small>{row.subject_type === 'vehicle' ? 'Vehicle' : 'Person'}</small></td>
                      <td data-label="Purpose">{nztaLabel(row.purpose)}<small>{row.explanation}{row.notice_number ? ` · Notice ${row.notice_number}` : ''}</small></td>
                      <td data-label="Readiness">{row.training_current && row.confidentiality_current
                        ? <span className="nzta-badge is-normal">Ready</span>
                        : <span className="nzta-badge is-watch">{[!row.training_current && 'No training', !row.confidentiality_current && 'No confidentiality'].filter(Boolean).join(' · ')}</span>}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
      {rows && <p className="nzta-count">{filtered.length.toLocaleString('en-NZ')} of {rows.length.toLocaleString('en-NZ')} views shown</p>}
    </section>
  );
};

// ------------------------------------------------------- People & training --

const People: React.FC<{ organizationId: string; currentUserId: string | undefined }> = ({ organizationId, currentUserId }) => {
  const [holders, setHolders] = useState<Holder[] | null>(null);
  const [history, setHistory] = useState<Attestation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'not_ready' | 'without_access'>('all');
  const [recording, setRecording] = useState<{ user: Holder; type: 'training' | 'confidentiality' } | null>(null);
  const [completedOn, setCompletedOn] = useState(today());
  const [expiresOn, setExpiresOn] = useState('');
  const [provider, setProvider] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // ATLAS CALLS: get_nzta_access_holders
  const load = useCallback(async () => {
    setHolders(null);
    setError(null);
    const [holderResult, historyResult] = await Promise.all([
      supabase.rpc('get_nzta_access_holders', { p_organization_id: organizationId }),
      supabase.from('nzta_access_attestations')
        .select('id, user_id, attestation_type, completed_on, expires_on, provider, notes, created_at, withdrawn_at, withdrawn_reason')
        .eq('organization_id', organizationId).order('completed_on', { ascending: false }).limit(2000),
    ]);
    if (holderResult.error) { setError(friendlyError(holderResult.error.message, 'Authorised staff could not be loaded.')); return; }
    setHolders((holderResult.data ?? []) as Holder[]);
    setHistory(historyResult.error ? [] : (historyResult.data ?? []) as Attestation[]);
  }, [organizationId]);

  useEffect(() => { void load(); }, [load]);

  const isReady = (holder: Holder) => holder.training_current && holder.confidentiality_current;
  const withAccess = (holders ?? []).filter((holder) => holder.holds_access);
  const withoutAccess = (holders ?? []).filter((holder) => !holder.holds_access);
  const visible = filter === 'without_access' ? withoutAccess
    : withAccess.filter((holder) => filter === 'all' || !isReady(holder));
  const notReady = withAccess.filter((holder) => !isReady(holder)).length;

  const openRecord = (user: Holder, type: 'training' | 'confidentiality') => {
    setRecording({ user, type });
    setCompletedOn(today());
    setExpiresOn('');
    setProvider('');
    setNotes('');
    setFormError(null);
  };

  const maxExpiry = (() => {
    const date = new Date(`${completedOn}T00:00:00`);
    date.setFullYear(date.getFullYear() + 1);
    return localDate(date);
  })();

  // ATLAS CALLS: record_nzta_access_attestation
  const saveAttestation = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!recording) return;
    if (!completedOn || completedOn > today()) { setFormError('Enter the completion date; it cannot be in the future.'); return; }
    if (expiresOn && (expiresOn <= completedOn || expiresOn > maxExpiry)) { setFormError('The refresh date must be after completion and within 12 months.'); return; }
    setSaving(true);
    setFormError(null);
    const { error: rpcError } = await supabase.rpc('record_nzta_access_attestation', {
      p_user_id: recording.user.user_id, p_attestation_type: recording.type, p_completed_on: completedOn,
      p_expires_on: expiresOn || null, p_provider: provider.trim() || null, p_notes: notes.trim() || null,
    });
    setSaving(false);
    if (rpcError) { setFormError(friendlyError(rpcError.message, 'The record could not be saved.')); return; }
    setNotice(`${recording.type === 'training' ? 'Training' : 'Confidentiality acceptance'} recorded for ${recording.user.display_name ?? 'this person'}.`);
    setRecording(null);
    await load();
  };

  // ATLAS CALLS: withdraw_nzta_access_attestation
  const withdraw = async (attestation: Attestation) => {
    const reason = window.prompt('Why is this record being withdrawn? (at least 5 characters)');
    if (!reason || reason.trim().length < 5) return;
    const { error: rpcError } = await supabase.rpc('withdraw_nzta_access_attestation', { p_attestation_id: attestation.id, p_reason: reason.trim() });
    if (rpcError) { setError(friendlyError(rpcError.message, 'The record could not be withdrawn.')); return; }
    setNotice('Record withdrawn. It stays in the history for audit.');
    await load();
  };

  const status = (current: boolean, expires: string | null) => current
    ? <span className="nzta-badge is-normal">Current to {nzDate(expires)}</span>
    : <span className="nzta-badge is-watch">{expires ? `Expired ${nzDate(expires)}` : 'Not recorded'}</span>;

  const accessVia = (holder: Holder) => holder.holds_access
    ? [holder.via_role && `${holder.role.replace(/_/g, ' ')} role`, holder.direct && 'direct grant', holder.via_preset && 'access preset'].filter(Boolean).join(', ')
      + (holder.home_organization ? '' : ' (another organisation)')
    : 'No access yet';

  return (
    <section className="nzta-panel" aria-labelledby="nzta-people-title">
      <header className="nzta-panel__head">
        <div><h2 id="nzta-people-title">People & training</h2><p>Everyone who can see NZTA register information, with their training and confidentiality acceptance. Both must be refreshed at least every 12 months. New access cannot be granted until both are current — use “Staff without access” to record them first.</p></div>
        <div className="nzta-panel__actions"><button type="button" className="btn btn-secondary" onClick={() => void load()}><RefreshCw size={16} aria-hidden="true" /> Refresh</button></div>
      </header>
      {notice && <p className="nzta-banner is-success" role="status"><CheckCircle2 size={16} aria-hidden="true" /> {notice}</p>}
      {holders && notReady > 0 && <p className="nzta-banner is-watch" role="note"><AlertTriangle size={16} aria-hidden="true" /> {notReady} of {withAccess.length} authorised {withAccess.length === 1 ? 'person is' : 'people are'} not NZTA-ready. Their views are still logged and flagged.</p>}
      <div className="nzta-filters" role="group" aria-label="Filter people">
        <label>Show
          <select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
            <option value="all">Everyone with access ({withAccess.length})</option>
            <option value="not_ready">Not NZTA-ready ({notReady})</option>
            <option value="without_access">Staff without access ({withoutAccess.length})</option>
          </select>
        </label>
      </div>
      {error ? <StateMessage kind="error" onRetry={() => void load()}>{error}</StateMessage>
        : holders === null ? <StateMessage kind="loading">Loading authorised staff…</StateMessage>
          : visible.length === 0 ? <StateMessage kind="empty">{filter === 'without_access' ? 'Every active staff member in this organisation already holds access.' : withAccess.length === 0 ? 'No one in this organisation holds NZTA register access.' : 'Everyone with access is NZTA-ready.'}</StateMessage>
            : (
              <div className="nzta-table-wrap">
                <table className="nzta-table">
                  <caption className="sr-only">People with NZTA register access</caption>
                  <thead><tr><th scope="col">Person</th><th scope="col">Access through</th><th scope="col">Training</th><th scope="col">Confidentiality</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>{visible.map((holder) => (
                    <tr key={holder.user_id}>
                      <td data-label="Person"><strong>{holder.display_name ?? 'Unnamed user'}</strong>{holder.user_id === currentUserId && <small>You</small>}</td>
                      <td data-label="Access through">{accessVia(holder) || '—'}</td>
                      <td data-label="Training">{status(holder.training_current, holder.training_expires_on)}</td>
                      <td data-label="Confidentiality">{status(holder.confidentiality_current, holder.confidentiality_expires_on)}</td>
                      <td data-label="" className="nzta-row-actions">
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => openRecord(holder, 'training')} aria-label={`Record training for ${holder.display_name ?? 'user'}`}>Record training</button>
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => openRecord(holder, 'confidentiality')} aria-label={`Record confidentiality for ${holder.display_name ?? 'user'}`}>Record confidentiality</button>
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}

      {recording && (
        <form className="nzta-form" onSubmit={(event) => void saveAttestation(event)} aria-labelledby="nzta-attest-title" noValidate>
          <h3 id="nzta-attest-title">{recording.type === 'training' ? 'Record NZTA register training' : 'Record confidentiality acceptance'} — {recording.user.display_name ?? 'user'}</h3>
          <fieldset disabled={saving}>
            <div className="nzta-form__grid">
              <label>Completed on<input type="date" required value={completedOn} max={today()} onChange={(event) => setCompletedOn(event.target.value)} /></label>
              <label>Refresh due (optional)<input type="date" value={expiresOn} min={completedOn} max={maxExpiry} onChange={(event) => setExpiresOn(event.target.value)} /><small>Leave blank for 12 months ({nzDate(maxExpiry)}).</small></label>
              <label>{recording.type === 'training' ? 'Course or provider' : 'Document accepted'}<input value={provider} maxLength={200} onChange={(event) => setProvider(event.target.value)} placeholder={recording.type === 'training' ? 'For example: R&M privacy and MVR induction' : 'For example: R&M confidentiality agreement v3'} /></label>
            </div>
            <label>Notes (optional)<textarea rows={2} maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
            {formError && <p className="nzta-banner is-error" role="alert">{formError}</p>}
            <div className="nzta-form__actions">
              <button type="button" className="btn btn-secondary" onClick={() => setRecording(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary">{saving ? 'Saving…' : 'Save record'}</button>
            </div>
          </fieldset>
        </form>
      )}

      {history.length > 0 && (
        <details className="nzta-history">
          <summary>Training and confidentiality history ({history.length})</summary>
          <div className="nzta-table-wrap">
            <table className="nzta-table">
              <thead><tr><th scope="col">Person</th><th scope="col">Type</th><th scope="col">Completed</th><th scope="col">Refresh due</th><th scope="col">Provider / document</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>{history.map((item) => (
                <tr key={item.id} className={item.withdrawn_at ? 'is-withdrawn' : undefined}>
                  <td data-label="Person">{holders?.find((holder) => holder.user_id === item.user_id)?.display_name ?? 'Former holder'}</td>
                  <td data-label="Type">{item.attestation_type === 'training' ? 'Training' : 'Confidentiality'}</td>
                  <td data-label="Completed">{nzDate(item.completed_on)}</td>
                  <td data-label="Refresh due">{nzDate(item.expires_on)}</td>
                  <td data-label="Provider">{item.provider ?? '—'}{item.withdrawn_at && <small>Withdrawn: {item.withdrawn_reason}</small>}</td>
                  <td data-label="">{!item.withdrawn_at && <button type="button" className="btn btn-sm btn-secondary" onClick={() => void withdraw(item)}>Withdraw</button>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
};

// --------------------------------------------------------- Quarterly reviews --

const lastQuarter = () => {
  const now = new Date();
  const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3;
  const end = new Date(now.getFullYear(), quarterStartMonth, 0);
  const start = new Date(end.getFullYear(), end.getMonth() - 2, 1);
  const iso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return { start: iso(start), end: iso(end) };
};

const Reviews: React.FC<{ organizationId: string }> = ({ organizationId }) => {
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [period, setPeriod] = useState(lastQuarter());
  const [findings, setFindings] = useState('');
  const [actions, setActions] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // ATLAS CALLS: list_nzta_access_reviews
  const load = useCallback(async () => {
    setReviews(null);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc('list_nzta_access_reviews', { p_organization_id: organizationId });
    if (rpcError) { setError(friendlyError(rpcError.message, 'Reviews could not be loaded.')); return; }
    setReviews((data ?? []) as Review[]);
  }, [organizationId]);

  useEffect(() => { void load(); }, [load]);

  const lastReview = reviews?.[0];
  const overdue = !lastReview || (Date.now() - new Date(lastReview.reviewed_at).getTime()) > 100 * 86_400_000;

  // ATLAS CALLS: record_nzta_access_review
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!period.start || !period.end || period.end < period.start) { setFormError('Enter a valid review period.'); return; }
    if (period.end > today()) { setFormError('The review period cannot end in the future.'); return; }
    if (findings.trim().length < 10) { setFormError('Record what was reviewed and found (at least 10 characters).'); return; }
    setSaving(true);
    setFormError(null);
    const { error: rpcError } = await supabase.rpc('record_nzta_access_review', {
      p_organization_id: organizationId, p_period_start: period.start, p_period_end: period.end,
      p_findings: findings.trim(), p_actions: actions.trim() || null,
    });
    setSaving(false);
    if (rpcError) { setFormError(friendlyError(rpcError.message, 'The review could not be saved.')); return; }
    setNotice('Review recorded with a snapshot of everyone who held access today.');
    setFindings('');
    setActions('');
    setFormOpen(false);
    await load();
  };

  return (
    <section className="nzta-panel" aria-labelledby="nzta-reviews-title">
      <header className="nzta-panel__head">
        <div><h2 id="nzta-reviews-title">Quarterly reviews</h2><p>Each quarter, confirm who still needs NZTA register access and remove anyone who does not. Saving a review keeps a snapshot of the current access list.</p></div>
        <div className="nzta-panel__actions"><button type="button" className="btn btn-primary" aria-expanded={formOpen} onClick={() => { setFormOpen((open) => !open); setFormError(null); }}>{formOpen ? 'Close form' : 'Record a review'}</button></div>
      </header>
      {notice && <p className="nzta-banner is-success" role="status"><CheckCircle2 size={16} aria-hidden="true" /> {notice}</p>}
      {reviews && overdue && <p className="nzta-banner is-watch" role="note"><AlertTriangle size={16} aria-hidden="true" /> {lastReview ? `The last review was on ${nzDate(lastReview.reviewed_at)}. A quarterly review is due.` : 'No access review has been recorded yet.'} Check People & training, remove access no longer needed under Users, then record the review here.</p>}
      {formOpen && (
        <form className="nzta-form" onSubmit={(event) => void submit(event)} aria-labelledby="nzta-review-form-title" noValidate>
          <h3 id="nzta-review-form-title">Record an access review</h3>
          <fieldset disabled={saving}>
            <div className="nzta-form__grid">
              <label>Period start<input type="date" required value={period.start} max={period.end} onChange={(event) => setPeriod({ ...period, start: event.target.value })} /></label>
              <label>Period end<input type="date" required value={period.end} min={period.start} max={today()} onChange={(event) => setPeriod({ ...period, end: event.target.value })} /></label>
            </div>
            <label>What was reviewed and found<textarea required rows={3} maxLength={4000} value={findings} onChange={(event) => setFindings(event.target.value)} placeholder="For example: 6 holders reviewed against duties; 1 no longer in an investigations role." /></label>
            <label>Actions taken (optional)<textarea rows={2} maxLength={4000} value={actions} onChange={(event) => setActions(event.target.value)} placeholder="For example: removed access for J. Smith on 3 Oct; training booked for 2 people." /></label>
            {formError && <p className="nzta-banner is-error" role="alert">{formError}</p>}
            <div className="nzta-form__actions">
              <button type="button" className="btn btn-secondary" onClick={() => setFormOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">{saving ? 'Saving…' : 'Save review'}</button>
            </div>
          </fieldset>
        </form>
      )}
      {error ? <StateMessage kind="error" onRetry={() => void load()}>{error}</StateMessage>
        : reviews === null ? <StateMessage kind="loading">Loading reviews…</StateMessage>
          : reviews.length === 0 ? <StateMessage kind="empty">No reviews recorded yet.</StateMessage>
            : (
              <ol className="nzta-review-list">{reviews.map((review) => (
                <li key={review.review_id}>
                  <header><strong>{nzDate(review.period_start)} – {nzDate(review.period_end)}</strong><span>{review.holder_count} with access · reviewed {nzDate(review.reviewed_at)} by {review.reviewed_by_name ?? 'administrator'}</span></header>
                  <p>{review.findings}</p>
                  {review.actions && <p><em>Actions:</em> {review.actions}</p>}
                </li>
              ))}</ol>
            )}
    </section>
  );
};

// ---------------------------------------------------------- Annual summary --

const SummaryView: React.FC<{ organizationId: string }> = ({ organizationId }) => {
  const [from, setFrom] = useState(daysAgo(365));
  const [to, setTo] = useState(today());
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // ATLAS CALLS: get_nzta_s241_summary
  const load = useCallback(async () => {
    if (!from || !to || to < from) { setError('Enter a valid reporting period.'); setLoading(false); return; }
    setLoading(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc('get_nzta_s241_summary', { p_organization_id: organizationId, p_from: from, p_to: to });
    setLoading(false);
    if (rpcError) { setError(friendlyError(rpcError.message, 'The summary could not be prepared.')); return; }
    setSummary(data as Summary);
  }, [from, organizationId, to]);

  useEffect(() => { void load(); }, [load]);

  const exportCsv = () => {
    if (!summary) return;
    const rows: Array<Record<string, unknown>> = [
      { section: 'Period', item: 'From', value: summary.period.from },
      { section: 'Period', item: 'To', value: summary.period.to },
      { section: 'Lookups', item: 'Total', value: summary.lookups.total },
      ...Object.entries(summary.lookups.by_purpose).map(([key, value]) => ({ section: 'Lookups by purpose', item: nztaLabel(key), value })),
      ...Object.entries(summary.lookups.by_outcome).map(([key, value]) => ({ section: 'Lookups by outcome', item: nztaLabel(key), value })),
      { section: 'Lookups', item: 'Historical checks without a recorded purpose', value: summary.lookups.historical_checks_without_purpose },
      { section: 'In-app views', item: 'Total', value: summary.reveals.total },
      ...Object.entries(summary.reveals.by_purpose).map(([key, value]) => ({ section: 'In-app views by purpose', item: nztaLabel(key), value })),
      { section: 'In-app views', item: 'By people without current training', value: summary.reveals.without_current_training },
      { section: 'Authorised staff', item: 'Total', value: summary.holders.total },
      { section: 'Authorised staff', item: 'Training current', value: summary.holders.training_current },
      { section: 'Authorised staff', item: 'Confidentiality current', value: summary.holders.confidentiality_current },
      { section: 'Access reviews', item: 'In period', value: summary.reviews.in_period },
      ...summary.signage.map((zone) => ({ section: 'Signage evidence', item: zone.zone_name, value: `${zone.evidence_count} photo(s); latest ${zone.latest_captured_at ? nzDate(zone.latest_captured_at) : 'none'}` })),
      { section: 'Retention (report only)', item: 'NZTA checks older than 18 months', value: summary.retention.checks_older_than_18_months },
      { section: 'Retention (report only)', item: 'NZTA checks older than 2 years', value: summary.retention.checks_older_than_2_years },
      { section: 'Retention (report only)', item: 'NZTA checks older than 5 years', value: summary.retention.checks_older_than_5_years },
      { section: 'Retention (report only)', item: 'Lookups older than 18 months', value: summary.retention.lookups_older_than_18_months },
      { section: 'Retention (report only)', item: 'Lookups older than 2 years', value: summary.retention.lookups_older_than_2_years },
      { section: 'Retention (report only)', item: 'Lookups older than 5 years', value: summary.retention.lookups_older_than_5_years },
      { section: 'Retention (report only)', item: 'Views older than 18 months', value: summary.retention.reveals_older_than_18_months },
      { section: 'Retention (report only)', item: 'Views older than 2 years', value: summary.retention.reveals_older_than_2_years },
      { section: 'Retention (report only)', item: 'Views older than 5 years', value: summary.retention.reveals_older_than_5_years },
    ];
    downloadCsv(`nzta-s241-summary-${from}-to-${to}.csv`, toCsv(rows, [['section', 'Section'], ['item', 'Item'], ['value', 'Value']]));
  };

  const zonesWithout = summary?.signage.filter((zone) => zone.evidence_count === 0).length ?? 0;

  return (
    <section className="nzta-panel nzta-summary" aria-labelledby="nzta-summary-title">
      <header className="nzta-panel__head">
        <div><h2 id="nzta-summary-title">Annual summary</h2><p>Figures for the yearly report to NZTA: lookups by purpose and outcome, in-app views, staff readiness, access reviews, signage evidence for each patrolled zone, and records due for a retention decision.</p></div>
        <div className="nzta-panel__actions">
          <button type="button" className="btn btn-secondary" onClick={() => window.print()} disabled={!summary}><Printer size={16} aria-hidden="true" /> Print</button>
          <button type="button" className="btn btn-secondary" onClick={exportCsv} disabled={!summary}><Download size={16} aria-hidden="true" /> Export CSV</button>
        </div>
      </header>
      <PeriodFilter from={from} to={to} onChange={(nextFrom, nextTo) => { setFrom(nextFrom); setTo(nextTo); }} />
      {error ? <StateMessage kind="error" onRetry={() => void load()}>{error}</StateMessage>
        : loading || !summary ? <StateMessage kind="loading">Preparing the summary…</StateMessage>
          : (
            <>
              <div className="nzta-cards">
                <div><span>Motochek lookups</span><strong>{summary.lookups.total}</strong><small>{summary.lookups.historical_checks_without_purpose} historical check{summary.lookups.historical_checks_without_purpose === 1 ? '' : 's'} without a purpose</small></div>
                <div><span>In-app views</span><strong>{summary.reveals.total}</strong><small>{summary.reveals.without_current_training} by people without current training</small></div>
                <div><span>Authorised staff</span><strong>{summary.holders.total}</strong><small>{summary.holders.training_current} trained · {summary.holders.confidentiality_current} confidentiality</small></div>
                <div><span>Access reviews</span><strong>{summary.reviews.in_period}</strong><small>Last {summary.reviews.last_reviewed_at ? nzDate(summary.reviews.last_reviewed_at) : 'never'}</small></div>
              </div>
              <div className="nzta-summary__grid">
                <section aria-labelledby="nzta-by-purpose"><h3 id="nzta-by-purpose">Lookups by purpose</h3>
                  {Object.keys(summary.lookups.by_purpose).length === 0 ? <p className="nzta-muted">No lookups in this period.</p>
                    : <dl>{Object.entries(summary.lookups.by_purpose).map(([key, value]) => <div key={key}><dt>{nztaLabel(key)}</dt><dd>{value}</dd></div>)}</dl>}
                </section>
                <section aria-labelledby="nzta-by-outcome"><h3 id="nzta-by-outcome">Lookups by outcome</h3>
                  {Object.keys(summary.lookups.by_outcome).length === 0 ? <p className="nzta-muted">No outcomes in this period.</p>
                    : <dl>{Object.entries(summary.lookups.by_outcome).map(([key, value]) => <div key={key}><dt>{nztaLabel(key)}</dt><dd>{value}</dd></div>)}</dl>}
                </section>
              </div>
              <section aria-labelledby="nzta-signage"><h3 id="nzta-signage">Signage evidence by zone</h3>
                {summary.signage.length === 0 ? <p className="nzta-muted">No zones are set up for this organisation yet. Add zones and signage photos under Places.</p> : (
                  <>
                    {zonesWithout > 0 && <p className="nzta-banner is-watch" role="note"><AlertTriangle size={16} aria-hidden="true" /> {zonesWithout} zone{zonesWithout === 1 ? ' has' : 's have'} no signage photo. Conditions of entry must be signposted for the CCTV and patrol purpose.</p>}
                    <div className="nzta-table-wrap">
                      <table className="nzta-table">
                        <thead><tr><th scope="col">Zone</th><th scope="col">Signage photos</th><th scope="col">Sign types</th><th scope="col">Latest photo</th></tr></thead>
                        <tbody>{summary.signage.map((zone) => (
                          <tr key={zone.zone_id}>
                            <td data-label="Zone">{zone.zone_name}</td>
                            <td data-label="Photos">{zone.evidence_count === 0 ? <span className="nzta-badge is-watch">None</span> : zone.evidence_count}</td>
                            <td data-label="Sign types">{zone.sign_types.length ? zone.sign_types.map((type) => type.replace(/_/g, ' ')).join(', ') : '—'}</td>
                            <td data-label="Latest">{zone.latest_captured_at ? nzDate(zone.latest_captured_at) : '—'}</td>
                          </tr>
                        ))}</tbody>
                      </table>
                    </div>
                  </>
                )}
              </section>
              <section aria-labelledby="nzta-retention" className="nzta-retention"><h3 id="nzta-retention">Retention (report only)</h3>
                <p className="nzta-muted">{summary.retention.note}</p>
                <dl>
                  <div><dt>NZTA checks older than 18 months</dt><dd>{summary.retention.checks_older_than_18_months}</dd></div>
                  <div><dt>NZTA checks older than 2 years</dt><dd>{summary.retention.checks_older_than_2_years}</dd></div>
                  <div><dt>NZTA checks older than 5 years</dt><dd>{summary.retention.checks_older_than_5_years}</dd></div>
                  <div><dt>Lookups older than 18 months</dt><dd>{summary.retention.lookups_older_than_18_months}</dd></div>
                  <div><dt>Lookups older than 2 years</dt><dd>{summary.retention.lookups_older_than_2_years}</dd></div>
                  <div><dt>Lookups older than 5 years</dt><dd>{summary.retention.lookups_older_than_5_years}</dd></div>
                  <div><dt>Views older than 18 months</dt><dd>{summary.retention.reveals_older_than_18_months}</dd></div>
                  <div><dt>Views older than 2 years</dt><dd>{summary.retention.reveals_older_than_2_years}</dd></div>
                  <div><dt>Views older than 5 years</dt><dd>{summary.retention.reveals_older_than_5_years}</dd></div>
                </dl>
              </section>
            </>
          )}
    </section>
  );
};

// -------------------------------------------------------------------- Page --

export const NztaRegisterContent: React.FC = () => {
  const { operatingOrganizationId, profile } = useAuth();
  const [tab, setTab] = useState<Tab>('lookups');
  const active = TABS.find((item) => item.id === tab) ?? TABS[0];

  if (!operatingOrganizationId) {
    return <StateMessage kind="empty">Choose an operating organisation to manage its NZTA register records.</StateMessage>;
  }

  return (
    <div className="nzta-page">
      <header className="nzta-page__head">
        <div>
          <span className="nzta-eyebrow"><ShieldCheck size={14} aria-hidden="true" /> Section 241 · Motor Vehicle Register</span>
          <h1>NZTA register</h1>
          <p>Keep the records NZTA expects from an authorised organisation: lookups, in-app views, staff training, access reviews and the annual report.</p>
        </div>
      </header>
      <div className="nzta-tabs" role="tablist" aria-label="NZTA register sections">
        {TABS.map((item) => (
          <button key={item.id} id={`nzta-tab-${item.id}`} type="button" role="tab" aria-selected={tab === item.id} aria-controls="nzta-tabpanel"
            className={tab === item.id ? 'is-active' : undefined} onClick={() => setTab(item.id)}>
            {item.id === 'people' ? <Users size={15} aria-hidden="true" /> : item.id === 'summary' ? <FileText size={15} aria-hidden="true" /> : null}
            <span>{item.label}</span>
          </button>
        ))}
      </div>
      <div id="nzta-tabpanel" role="tabpanel" aria-labelledby={`nzta-tab-${tab}`}>
        <p className="nzta-muted nzta-tab-hint">{active.hint}</p>
        {tab === 'lookups' && <LookupRegister organizationId={operatingOrganizationId} />}
        {tab === 'access' && <AccessLog organizationId={operatingOrganizationId} />}
        {tab === 'people' && <People organizationId={operatingOrganizationId} currentUserId={profile?.id} />}
        {tab === 'reviews' && <Reviews organizationId={operatingOrganizationId} />}
        {tab === 'summary' && <SummaryView organizationId={operatingOrganizationId} />}
      </div>
    </div>
  );
};

const NztaRegisterPage: React.FC = () => (
  <ShellLayout shell="admin" className="nzta-shell">
    <NztaRegisterContent />
  </ShellLayout>
);

export default NztaRegisterPage;
