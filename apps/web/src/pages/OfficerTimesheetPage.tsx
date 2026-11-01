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
import './PageStyles.css';

interface Timesheet {
  id: string;
  period_start: string;
  period_end: string;
  scheduled_hours: number | null;
  actual_hours: number | null;
  overtime_hours: number;
  status: string;
  review_notes: string | null;
  approved_at: string | null;
  submitted_at: string | null;
}

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
const TIMESHEET_COLUMNS = 'id, period_start, period_end, scheduled_hours, actual_hours, overtime_hours, status, review_notes, approved_at, submitted_at';

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
  const [workEntries, setWorkEntries] = useState<TimesheetWorkEntry[]>([]);
  const [workLoading, setWorkLoading] = useState(false);
  const eventIdRef = useRef(crypto.randomUUID());

  // ATLAS READS: timesheets
  useEffect(() => {
    const load = async () => {
      if (!profile?.id || !profile.organizationId) {
        setTimesheets([]);
        setWorkEntries([]);
        setError('Organisation access could not be confirmed. Timesheets are unavailable.');
        setLoading(false);
        return;
      }
      try {
        setLoading(true);
        setError(null);

        const { data, error: err } = await supabase
          .from('timesheets')
          .select(TIMESHEET_COLUMNS)
          .eq('staff_id', profile.id)
          .order('period_start', { ascending: false });

        if (err) throw err;
        setTimesheets((data as Timesheet[]) || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load timesheets');
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [profile?.id]);

  useEffect(() => { if (requestedTimesheetId) document.getElementById(`officer-timesheet-${requestedTimesheetId}`)?.scrollIntoView({ block: 'center' }); }, [requestedTimesheetId, timesheets]);

  const periodValid = Boolean(form.periodStart && form.periodEnd && form.periodStart <= form.periodEnd);
  const previewWork = useCallback(async (periodStart: string, periodEnd: string) => {
    if (!periodStart || !periodEnd || periodStart > periodEnd) { setWorkEntries([]); return; }
    setWorkLoading(true);
    // ATLAS READS: get_officer_timesheet_work (shift actual start/end across every branch, unpaid breaks taken off)
    try { setWorkEntries(await loadOfficerTimesheetWork(periodStart, periodEnd)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Your finished shifts could not be loaded.'); }
    finally { setWorkLoading(false); }
  }, []);
  useEffect(() => { if (profile?.id && profile.organizationId) void previewWork(form.periodStart, form.periodEnd); }, [profile?.id, profile?.organizationId, form.periodStart, form.periodEnd, previewWork]);

  const workedMinutes = workEntries.reduce((total, entry) => total + entry.calculated_minutes, 0);
  const shiftCount = workEntries.filter((entry) => entry.source_type === 'shift').length;
  const jobCount = workEntries.length - shiftCount;
  const rejectedForPeriod = timesheets.find((timesheet) => timesheet.status === 'rejected' && timesheet.period_start === form.periodStart && timesheet.period_end === form.periodEnd);
  const alreadyCovering = timesheets.find((timesheet) => timesheet.status !== 'rejected' && timesheet.period_start <= form.periodEnd && timesheet.period_end >= form.periodStart);

  const submitTimesheet = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true); setError(null); setNotice(null);
    try {
      const result = rejectedForPeriod
        ? await resubmitRejectedTimesheetFromWork(rejectedForPeriod.id, Number(form.adjustmentHours || 0), form.notes)
        : await submitOfficerTimesheetFromWork(eventIdRef.current, form.periodStart, form.periodEnd, Number(form.adjustmentHours || 0), form.notes);
      setNotice(`Timesheet sent for approval: ${result.actual_hours} hours from ${plural(result.source_count, 'work record')} · receipt ${result.id.slice(0, 8)}`);
      setForm({ ...thisWeekSoFar(), adjustmentHours: '0', notes: '' }); setWorkEntries([]); eventIdRef.current = crypto.randomUUID();
      const { data } = await supabase.from('timesheets').select(TIMESHEET_COLUMNS).eq('staff_id', profile?.id ?? '').order('period_start', { ascending: false });
      if (data) setTimesheets(data as Timesheet[]);
    } catch (err) { setError(err instanceof Error ? err.message : 'Timesheet receipt was not confirmed. Your entries remain available for retry.'); }
    finally { setSubmitting(false); }
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
        <div className="form-row"><div className="form-group"><label htmlFor="period-start">From</label><input id="period-start" type="date" required value={form.periodStart} onChange={(event) => setForm({ ...form, periodStart: event.target.value })} /></div><div className="form-group"><label htmlFor="period-end">To</label><input id="period-end" type="date" required value={form.periodEnd} onChange={(event) => setForm({ ...form, periodEnd: event.target.value })} /></div></div>
        <div className="form-group officer-timesheet-work" aria-live="polite">
          <strong>{workLoading ? 'Checking your finished shifts…' : !periodValid ? 'Choose a period: the "To" date must not be before "From".' : workEntries.length === 0 ? 'No finished shifts in this period yet.' : `Worked time: ${hoursAndMinutes(workedMinutes)} across ${plural(shiftCount, 'shift')}${jobCount ? ` and ${plural(jobCount, 'stand-alone job')}` : ''}`}</strong>
          {!workLoading && periodValid && workEntries.length === 0 && <small className="form-hint">A shift counts once you have started and ended it in the app. If you worked but the shift is still open, end it from your schedule first.</small>}
          {workEntries.length > 0 && <ul className="officer-timesheet-entries">
            {workEntries.map((entry) => {
              const unpaidBreak = Number(entry.metadata?.unpaid_break_minutes ?? 0);
              const endedEarly = entry.metadata?.ended_reason === 'superseded_by_next_shift';
              return <li key={`${entry.source_type}-${entry.source_id}`}>
                <span><strong>{plainWords(entry.label)}</strong> · {dateWords(entry.started_at)}, {timeWords(entry.started_at)} – {timeWords(entry.ended_at)}</span>
                <span>{hoursAndMinutes(entry.calculated_minutes)}{unpaidBreak > 0 ? ` (${unpaidBreak} min unpaid break taken off)` : ''}{endedEarly ? ' · ended when your next shift started' : ''}</span>
              </li>;
            })}
          </ul>}
        </div>
        <div className="form-group"><label htmlFor="adjustment-hours">Adjustment (hours)</label><input id="adjustment-hours" type="number" min="-744" max="744" step="0.25" value={form.adjustmentHours} onChange={(event) => setForm({ ...form, adjustmentHours: event.target.value })} /><small className="form-hint">Only if payroll has asked for one. Your hours come from your shifts, not from what you type here.</small></div>
        <div className="form-group"><label htmlFor="timesheet-notes">Anything payroll should know</label><textarea id="timesheet-notes" rows={3} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder="e.g. stayed on for the handover, callout allowance, travel" /></div>
        {alreadyCovering && !rejectedForPeriod && <p className="form-hint" role="note">You already sent a timesheet covering {dateWords(alreadyCovering.period_start)} – {dateWords(alreadyCovering.period_end)} ({timesheetStatusLabel(alreadyCovering.status).toLowerCase()}). Pick dates outside it.</p>}
        <button type="submit" className="btn btn-primary" disabled={submitting || !periodValid || workLoading || Boolean(alreadyCovering && !rejectedForPeriod)}>{submitting ? 'Sending…' : rejectedForPeriod ? 'Send corrected timesheet' : 'Send for approval'}</button>
      </form>

      <div className="reports-table-wrapper">
        <table className="reports-table">
          <thead>
            <tr>
              <th>Period</th>
              <th>Rostered</th>
              <th>Worked</th>
              <th>Overtime</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {timesheets.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-center">
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
                  <td>{hours(t.actual_hours)}</td>
                  <td>{hours(t.overtime_hours)}</td>
                  <td>
                    <span className={`status-badge status-${t.status}`}>{timesheetStatusLabel(t.status)}</span>
                    {t.submitted_at && <small className="timesheet-review-note">{submittedWords(t.submitted_at)}</small>}
                    {t.review_notes && <small className="timesheet-review-note"><strong>Review note:</strong> {t.review_notes}{t.approved_at ? ` · ${new Date(t.approved_at).toLocaleString('en-NZ')}` : ''}</small>}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default OfficerTimesheetPage;
