/**
 * OfficerTimesheetPage.tsx (Officer module: 'timesheet')
 *
 * Canonical schema: timesheets (staff_id, period_start/end, scheduled_hours,
 * actual_hours, status). The officer's worked time comes from the shifts they
 * started and ended in the app (get_officer_timesheet_work); they check it and
 * send it for approval. Approval is an admin/HR action (RosterHRPage), not here.
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { loadOfficerTimesheetWork, resubmitRejectedTimesheetFromWork, submitOfficerTimesheetFromWork, type TimesheetWorkEntry } from '../lib/officerTimesheetWork';
import { plainWords, plural, submittedWords } from '../lib/rosterWords';
import { timesheetMismatchReasons } from '../lib/timesheetTolerances';
import { timesheetPaidHours, timesheetWorkedHours } from '../lib/timesheetHours';
import './PageStyles.css';

interface Timesheet {
  id: string;
  period_start: string;
  period_end: string;
  scheduled_hours: number | null;
  work_derived_hours: number | null;
  actual_hours: number | null;
  overtime_hours: number;
  status: string;
  review_notes: string | null;
  approved_at: string | null;
  submitted_at: string | null;
}

type WorkPreview =
  | { key: string; status: 'loading' }
  | { key: string; status: 'ready'; entries: TimesheetWorkEntry[] }
  | { key: string; status: 'error' };

const TIMESHEET_STATUS_LABELS: Record<string, string> = {
  draft: 'Not sent yet',
  submitted: 'Waiting for review',
  branch_checked: 'Checked by your branch',
  approved: 'Approved',
  rejected: 'Sent back to you',
  paid: 'Paid',
};
export const timesheetStatusLabel = (status: string): string => TIMESHEET_STATUS_LABELS[status] ?? plainWords(status);

const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
/** Monday of the current week through today: the period most officers mean by "this week's hours". */
export const thisWeekSoFar = (now = new Date()) => {
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  return { periodStart: localDate(monday), periodEnd: localDate(now) };
};
export const hoursAndMinutes = (minutes: number) => `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
const dateWords = (value: string) => new Date(value).toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' });
const timeWords = (value: string) => new Date(value).toLocaleTimeString('en-NZ', { hour: 'numeric', minute: '2-digit' });
const hours = (value: number | null | undefined) => value == null ? '–' : `${Number(value).toFixed(2)} h`;
const TIMESHEET_COLUMNS = 'id, period_start, period_end, scheduled_hours, work_derived_hours, actual_hours, overtime_hours, status, review_notes, approved_at, submitted_at';

const OfficerTimesheetPage: React.FC = () => {
  const location = useLocation();
  const requestedTimesheetId = new URLSearchParams(location.search).get('timesheet');
  const { profile } = useAuth();
  const [timesheets, setTimesheets] = useState<Timesheet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({ ...thisWeekSoFar(), adjustmentHours: '0', notes: '' });
  const [preview, setPreview] = useState<WorkPreview | null>(null);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [listUnavailable, setListUnavailable] = useState(false);
  const [refreshingList, setRefreshingList] = useState(false);
  const [unconfirmedCorrectionId, setUnconfirmedCorrectionId] = useState<string | null>(null);
  const eventIdRef = useRef<{ id: string; fingerprint: string } | null>(null);

  const readTimesheets = useCallback(async () => {
    if (!profile?.id || !profile.organizationId) throw new Error('Organisation access could not be confirmed. Timesheets are unavailable.');
    const { data: staff, error: staffError } = await supabase
      .from('staff_profiles')
      .select('id')
      .eq('organization_id', profile.organizationId)
      .or(`user_id.eq.${profile.id},id.eq.${profile.id}`);
    if (staffError) throw staffError;
    if (!Array.isArray(staff) || staff.some((row) => !row || typeof row.id !== 'string' || row.id.length === 0)) throw new Error('Staff access could not be confirmed. Timesheets are unavailable.');
    if (staff.length === 0) throw new Error('No staff profile is linked to your account. Contact payroll.');
    const staffIds: string[] = staff.map((row) => row.id);
    const { data, error: err } = await supabase
      .from('timesheets')
      .select(TIMESHEET_COLUMNS)
      .eq('organization_id', profile.organizationId)
      .in('staff_id', staffIds)
      .order('period_start', { ascending: false });
    if (err) throw err;
    if (!Array.isArray(data)) throw new Error('Timesheets could not be loaded.');
    return data as Timesheet[];
  }, [profile?.id, profile?.organizationId]);

  // ATLAS READS: staff_profiles, timesheets
  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!profile?.id || !profile.organizationId) {
        setTimesheets([]);
        setListUnavailable(true);
        setError('Organisation access could not be confirmed. Timesheets are unavailable.');
        setLoading(false);
        return;
      }
      try {
        setLoading(true);
        setError(null);

        const rows = await readTimesheets();
        if (active) { setTimesheets(rows); setListUnavailable(false); }
      } catch (err) {
        if (active) {
          setTimesheets([]);
          setListUnavailable(true);
          setError(err instanceof Error ? err.message : 'Failed to load timesheets');
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    void load();
    return () => { active = false; };
  }, [profile?.id, profile?.organizationId, readTimesheets]);

  useEffect(() => { if (requestedTimesheetId) document.getElementById(`officer-timesheet-${requestedTimesheetId}`)?.scrollIntoView({ block: 'center' }); }, [requestedTimesheetId, timesheets]);

  const periodValid = Boolean(form.periodStart && form.periodEnd && form.periodStart <= form.periodEnd);
  const previewKey = JSON.stringify([profile?.id, profile?.organizationId, form.periodStart, form.periodEnd]);
  const currentPreview = preview?.key === previewKey ? preview : null;
  const previewReady = periodValid && currentPreview?.status === 'ready';
  const workLoading = periodValid && Boolean(profile?.id && profile.organizationId) && (!currentPreview || currentPreview.status === 'loading');
  const workEntries = previewReady && currentPreview?.status === 'ready' ? currentPreview.entries : [];

  useEffect(() => {
    if (!profile?.id || !profile.organizationId || !periodValid) return;
    let active = true;
    setPreview({ key: previewKey, status: 'loading' });
    // ATLAS READS: get_officer_timesheet_work (shift actual start/end across every branch, unpaid breaks taken off)
    void loadOfficerTimesheetWork(form.periodStart, form.periodEnd).then(
      (entries) => { if (active) setPreview({ key: previewKey, status: 'ready', entries }); },
      () => { if (active) setPreview({ key: previewKey, status: 'error' }); },
    );
    return () => { active = false; };
  }, [profile?.id, profile?.organizationId, periodValid, previewKey, previewRetry, form.periodStart, form.periodEnd]);

  const workedMinutes = workEntries.reduce((total, entry) => total + entry.calculated_minutes, 0);
  const sumTimesheetHours = (getHours: (timesheet: Timesheet) => number | null): number | null => {
    if (loading || listUnavailable || refreshingList) return null;
    return timesheets.reduce<number | null>((total, timesheet) => {
      const value = getHours(timesheet);
      return total === null || value === null || !Number.isFinite(value) ? null : total + value;
    }, 0);
  };
  const workedHours = sumTimesheetHours(timesheetWorkedHours);
  const paidHours = sumTimesheetHours(timesheetPaidHours);
  const shiftCount = workEntries.filter((entry) => entry.source_type === 'shift').length;

  const handleApproveTimesheet = (_id: string) => {
    setNotice('Timesheet approvals are handled in the admin review flow.');
  };

  const handleCancelTimesheet = (_id: string) => {
    setNotice('Timesheet approvals are handled in the admin review flow.');
  };

  const handleEditTimesheet = (id: string) => {
    const selected = timesheets.find((timesheet) => timesheet.id === id);
    if (!selected) return;
    setForm((current) => ({
      ...current,
      periodStart: selected.period_start,
      periodEnd: selected.period_end,
      adjustmentHours: String(selected.actual_hours ?? selected.work_derived_hours ?? 0),
    }));
    setNotice('Loaded this timesheet into the submission form for editing.');
  };
  const jobCount = workEntries.length - shiftCount;
  const rejectedForPeriod = timesheets.find((timesheet) => timesheet.status === 'rejected' && timesheet.period_start === form.periodStart && timesheet.period_end === form.periodEnd);
  const alreadyCovering = timesheets.find((timesheet) => timesheet.status !== 'rejected' && timesheet.period_start <= form.periodEnd && timesheet.period_end >= form.periodStart);

  const submitTimesheet = async (event: React.FormEvent) => {
    event.preventDefault();
    if (listUnavailable || refreshingList) {
      setError('Refresh the timesheet list before sending.');
      return;
    }
    if (!profile?.id || !previewReady || submitting || (alreadyCovering && !rejectedForPeriod)) {
      setError('Review the finished work for this period before sending your timesheet.');
      return;
    }
    setSubmitting(true); setError(null); setNotice(null);
    try {
      const adjustmentHours = Number(form.adjustmentHours || 0);
      const fingerprint = JSON.stringify([profile.id, profile.organizationId, form.periodStart, form.periodEnd, adjustmentHours, form.notes.trim()]);
      if (!eventIdRef.current || eventIdRef.current.fingerprint !== fingerprint) {
        eventIdRef.current = { id: crypto.randomUUID(), fingerprint };
      }
      const result = rejectedForPeriod
        ? await resubmitRejectedTimesheetFromWork(rejectedForPeriod.id, adjustmentHours, form.notes)
        : await submitOfficerTimesheetFromWork(eventIdRef.current.id, form.periodStart, form.periodEnd, adjustmentHours, form.notes);
      setNotice(`Timesheet sent for approval: ${result.actual_hours} hours from ${plural(result.source_count, 'work record')} · receipt ${result.id.slice(0, 8)}`);
      setForm({ ...thisWeekSoFar(), adjustmentHours: '0', notes: '' }); eventIdRef.current = null;
      setRefreshingList(true);
      try {
        setTimesheets(await readTimesheets());
        setListUnavailable(false);
      } catch {
        setListUnavailable(true);
        setError('Your timesheet was sent, but the list could not be refreshed. Retry the list below.');
      } finally { setRefreshingList(false); }
    } catch (err) {
      if (!rejectedForPeriod) {
        setError(err instanceof Error ? err.message : 'Timesheet receipt was not confirmed. Your entries remain available for retry.');
      } else {
        setUnconfirmedCorrectionId(rejectedForPeriod.id);
        setError('Correction receipt was not confirmed. Checking the current timesheet status.');
        setRefreshingList(true);
        try {
          const rows = await readTimesheets();
          const current = rows.find((row) => row.id === rejectedForPeriod.id);
          if (!current) {
            setListUnavailable(true);
            setError('Correction receipt was not confirmed and the timesheet could not be found. Check the list before retrying.');
          } else {
            setTimesheets(rows);
            setListUnavailable(false);
            setUnconfirmedCorrectionId(null);
            setError(current.status === 'rejected'
              ? 'Correction receipt was not confirmed. Check the timesheet below and retry if it is still sent back to you.'
              : 'Correction receipt was not confirmed. The timesheet status has changed; check it below before trying again.');
          }
        } catch {
          setListUnavailable(true);
          setError('Correction receipt was not confirmed and the timesheet list could not be refreshed. Retry the list before trying again.');
        } finally { setRefreshingList(false); }
      }
    }
    finally { setSubmitting(false); }
  };

  const refreshTimesheets = async () => {
    setRefreshingList(true);
    try {
      const rows = await readTimesheets();
      if (unconfirmedCorrectionId && !rows.some((row) => row.id === unconfirmedCorrectionId)) {
        setListUnavailable(true);
        setError('The unconfirmed correction could not be found in your timesheet list. Contact payroll before trying again.');
        return;
      }
      setTimesheets(rows);
      setListUnavailable(false);
      setError(unconfirmedCorrectionId ? 'Correction receipt was not confirmed. Check its current status below before trying again.' : null);
      setUnconfirmedCorrectionId(null);
    } catch {
      setListUnavailable(true);
      setError('Your timesheet list could not be refreshed. Try again.');
    } finally { setRefreshingList(false); }
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading your timesheet…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>My timesheet</h1>
        <p className="subtitle">Your worked time comes from the shifts you started and ended in the app. Check it, then send it for approval.</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      {notice && <div className="alert alert-success" role="status">{notice}</div>}

      <form className="assessment-form officer-timesheet-form" onSubmit={submitTimesheet}>
        <h2>{rejectedForPeriod ? 'Send the corrected timesheet' : 'Send worked time for approval'}</h2>
        <div className="form-row"><div className="form-group"><label htmlFor="period-start">From</label><input id="period-start" type="date" required disabled={submitting} value={form.periodStart} onChange={(event) => setForm({ ...form, periodStart: event.target.value })} /></div><div className="form-group"><label htmlFor="period-end">To</label><input id="period-end" type="date" required disabled={submitting} value={form.periodEnd} onChange={(event) => setForm({ ...form, periodEnd: event.target.value })} /></div></div>
        <div className="form-group officer-timesheet-work" aria-live="polite">
          <strong>{!periodValid ? 'Choose a period: the "To" date must not be before "From".' : currentPreview?.status === 'error' ? 'We could not load your finished work for this period.' : workLoading || !previewReady ? 'Checking your finished shifts…' : workEntries.length === 0 ? 'No finished shifts in this period yet.' : `Worked time: ${hoursAndMinutes(workedMinutes)} across ${plural(shiftCount, 'shift')}${jobCount ? ` and ${plural(jobCount, 'stand-alone job')}` : ''}`}</strong>
          {currentPreview?.status === 'error' && <button type="button" className="btn btn-secondary" disabled={submitting} onClick={() => setPreviewRetry((value) => value + 1)}>Retry work preview</button>}
          {previewReady && workEntries.length === 0 && <small className="form-hint">A shift counts once you have started and ended it in the app. If you worked but the shift is still open, end it from your schedule first.</small>}
          {previewReady && workEntries.length > 0 && <ul className="officer-timesheet-entries">
            {workEntries.map((entry) => {
              const unpaidBreak = Number(entry.metadata?.unpaid_break_minutes ?? 0);
              const endedEarly = entry.metadata?.ended_reason === 'superseded_by_next_shift';
              const mismatchReasons = timesheetMismatchReasons(entry.metadata);
              const actualStart = entry.metadata?.actual_start;
              const actualEnd = entry.metadata?.actual_end;
              return <li key={`${entry.source_type}-${entry.source_id}`} className={mismatchReasons.length ? 'timesheet-mismatch' : undefined}>
                <span><strong>{plainWords(entry.label)}</strong> · {dateWords(entry.started_at)}, {timeWords(entry.started_at)} – {timeWords(entry.ended_at)}</span>
                <span>{hoursAndMinutes(entry.calculated_minutes)}{unpaidBreak > 0 ? ` (${unpaidBreak} min ${entry.metadata?.break_snapped === true ? 'rostered' : 'recorded'} unpaid break deducted)` : ''}{endedEarly ? ' · ended when your next shift started' : ''}</span>
                {typeof actualStart === 'string' && typeof actualEnd === 'string' && <small>Recorded: {dateWords(actualStart)}, {timeWords(actualStart)} – {dateWords(actualEnd)}, {timeWords(actualEnd)}{entry.metadata?.recorded_unpaid_break_minutes !== undefined ? ` · unpaid break ${Number(entry.metadata.recorded_unpaid_break_minutes).toFixed(1)} min` : ''}</small>}
                {mismatchReasons.length > 0 && <small className="timesheet-mismatch-note">{mismatchReasons.join('; ')}</small>}
              </li>;
            })}
          </ul>}
        </div>
        <div className="form-group"><label htmlFor="adjustment-hours">Adjustment (hours)</label><input id="adjustment-hours" type="number" min="-744" max="744" step="0.25" disabled={submitting} value={form.adjustmentHours} onChange={(event) => setForm({ ...form, adjustmentHours: event.target.value })} /><small className="form-hint">Only if payroll has asked for one. Your hours come from your shifts, not from what you type here.</small></div>
        <div className="form-group"><label htmlFor="timesheet-notes">Anything payroll should know</label><textarea id="timesheet-notes" rows={3} disabled={submitting} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder="e.g. stayed on for the handover, callout allowance, travel" /></div>
        {alreadyCovering && !rejectedForPeriod && <p className="form-hint" role="note">You already sent a timesheet covering {dateWords(alreadyCovering.period_start)} – {dateWords(alreadyCovering.period_end)} ({timesheetStatusLabel(alreadyCovering.status).toLowerCase()}). Pick dates outside it.</p>}
        <button type="submit" className="btn btn-primary" disabled={submitting || !previewReady || listUnavailable || refreshingList || Boolean(alreadyCovering && !rejectedForPeriod)}>{submitting ? 'Sending…' : rejectedForPeriod ? 'Send corrected timesheet' : 'Send for approval'}</button>
      </form>

      {listUnavailable && <div className="alert alert-error" role="alert">Your timesheet list is unavailable. <button type="button" className="btn btn-secondary" disabled={refreshingList} onClick={() => void refreshTimesheets()}>{refreshingList ? 'Refreshing…' : 'Retry timesheet list'}</button></div>}
      <div className="reports-table-wrapper">
        <table className="reports-table">
          <thead>
            <tr>
              <th>Period</th>
              <th>Rostered</th>
              <th>Hours worked</th>
              <th>Paid hours</th>
              <th>Overtime</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {refreshingList ? (
              <tr><td colSpan={6} className="text-center">Refreshing the timesheet list…</td></tr>
            ) : listUnavailable ? (
              <tr><td colSpan={6} className="text-center">Timesheets could not be loaded.</td></tr>
            ) : timesheets.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center">
                  Nothing sent yet. Your first timesheet will appear here once you send it.
                </td>
              </tr>
            ) : (
              timesheets.map((t) => (
                <tr key={t.id} id={`officer-timesheet-${t.id}`} className={t.id === requestedTimesheetId ? 'is-context-focus' : undefined}>
                  <td>
                    {new Date(t.period_start).toLocaleDateString()} – {new Date(t.period_end).toLocaleDateString()}
                  </td>
                  <td>{hours(t.scheduled_hours)}</td>
                  <td>{hours(timesheetWorkedHours(t))}</td>
                  <td>{hours(timesheetPaidHours(t))}</td>
                  <td>{hours(t.overtime_hours)}</td>
                              <td>
              <span className={`status-badge status-${t.status}`}>{timesheetStatusLabel(t.status)}</span>
              {t.submitted_at && <small className="timesheet-review-note">{submittedWords(t.submitted_at)}</small>}
              {t.review_notes && <small className="timesheet-review-note"><strong>Review note:</strong> {t.review_notes}{t.approved_at ? ` · ${new Date(t.approved_at).toLocaleString('en-NZ')}` : ''}</small>}
              <div className="action-buttons">
                {t.status === 'pending' && <button className="btn btn-sm btn-secondary" onClick={() => handleApproveTimesheet(t.id)}>Approve</button>}
                {t.status === 'approved' && <button className="btn btn-sm btn-danger" onClick={() => handleCancelTimesheet(t.id)}>Cancel</button>}
                {t.status === 'rejected' && <button className="btn btn-sm btn-primary" onClick={() => handleEditTimesheet(t.id)}>Edit</button>}
              </div>
            </td>
                </tr>
              ))
            )}
                     </tbody>
         </table>
       </div>
       <div className="totals">
         <div>
            <strong>Total hours worked:</strong> {hours(workedHours)}
         </div>
         <div>
           <strong>Total paid hours:</strong> {hours(paidHours)}
         </div>
       </div>
     </div>
   );
  };

 export default OfficerTimesheetPage;
