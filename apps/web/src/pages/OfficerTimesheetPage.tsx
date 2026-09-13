/**
 * OfficerTimesheetPage.tsx (Officer module: 'timesheet')
 *
 * Canonical schema: timesheets (staff_id, period_start/end, scheduled_hours,
 * actual_hours, status). Officer-scoped read-only view of own timesheets;
 * approval is an admin/HR action (see RosterHRPage), not done here.
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { loadOfficerTimesheetWork, resubmitRejectedTimesheetFromWork, submitOfficerTimesheetFromWork, type TimesheetWorkEntry } from '../lib/officerTimesheetWork';
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
}

const OfficerTimesheetPage: React.FC = () => {
  const location = useLocation();
  const requestedTimesheetId = new URLSearchParams(location.search).get('timesheet');
  const { profile } = useAuth();
  const [timesheets, setTimesheets] = useState<Timesheet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({ periodStart: '', periodEnd: '', adjustmentHours: '0', notes: '' });
  const [workEntries, setWorkEntries] = useState<TimesheetWorkEntry[]>([]);
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
          .select('id, period_start, period_end, scheduled_hours, actual_hours, overtime_hours, status, review_notes, approved_at')
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

  const previewWork = async () => {
    if (!form.periodStart || !form.periodEnd || form.periodStart > form.periodEnd) { setWorkEntries([]); return; }
    try { setWorkEntries(await loadOfficerTimesheetWork(form.periodStart, form.periodEnd)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Completed work could not be loaded.'); }
  };

  const submitTimesheet = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true); setError(null); setNotice(null);
    try {
      const rejected = timesheets.find((timesheet) => timesheet.status === 'rejected' && timesheet.period_start === form.periodStart && timesheet.period_end === form.periodEnd);
      const result = rejected
        ? await resubmitRejectedTimesheetFromWork(rejected.id, Number(form.adjustmentHours || 0), form.notes)
        : await submitOfficerTimesheetFromWork(eventIdRef.current, form.periodStart, form.periodEnd, Number(form.adjustmentHours || 0), form.notes);
      setNotice(`Timesheet submitted · receipt ${result.id.slice(0, 8)} · ${result.actual_hours} hours from ${result.source_count} work records`);
      setForm({ periodStart: '', periodEnd: '', adjustmentHours: '0', notes: '' }); setWorkEntries([]); eventIdRef.current = crypto.randomUUID();
    } catch (err) { setError(err instanceof Error ? err.message : 'Timesheet receipt was not confirmed. Your entries remain available for retry.'); }
    finally { setSubmitting(false); }
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading timesheets...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Timesheets</h1>
        <p className="subtitle">{timesheets.length} periods</p>
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

      <form className="assessment-form" onSubmit={submitTimesheet}>
        <h2>Submit timesheet from completed shifts</h2>
        <div className="form-row"><div className="form-group"><label htmlFor="period-start">Period start</label><input id="period-start" type="date" required value={form.periodStart} onChange={(event) => setForm({ ...form, periodStart: event.target.value })} onBlur={() => void previewWork()} /></div><div className="form-group"><label htmlFor="period-end">Period end</label><input id="period-end" type="date" required value={form.periodEnd} onChange={(event) => setForm({ ...form, periodEnd: event.target.value })} onBlur={() => void previewWork()} /></div></div>
        <div className="form-group"><label htmlFor="adjustment-hours">Payroll adjustment hours</label><input id="adjustment-hours" type="number" min="-744" max="744" step="0.25" value={form.adjustmentHours} onChange={(event) => setForm({ ...form, adjustmentHours: event.target.value })} /><small className="form-hint">Optional exception only. Actual hours come from completed shifts and completed standalone dispatch jobs.</small></div>
        <div className="form-group"><strong>Derived completed work: {workEntries.reduce((total, entry) => total + entry.calculated_minutes, 0) / 60} hours across {workEntries.length} records</strong><button type="button" className="btn btn-secondary btn-sm" onClick={() => void previewWork()}>Refresh completed work</button>{workEntries.map((entry) => <small className="form-hint" key={`${entry.source_type}-${entry.source_id}`}>{entry.label} · completed · {entry.calculated_minutes} minutes</small>)}</div>
        <div className="form-group"><label htmlFor="timesheet-notes">Notes</label><textarea id="timesheet-notes" rows={3} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder="Exceptions, allowances, or context for payroll review" /></div>
        <button type="submit" className="btn btn-primary" disabled={submitting || !form.periodStart || !form.periodEnd || form.periodStart > form.periodEnd}>{submitting ? 'Submitting' : timesheets.some((timesheet) => timesheet.status === 'rejected' && timesheet.period_start === form.periodStart && timesheet.period_end === form.periodEnd) ? 'Resubmit corrected timesheet' : 'Submit derived hours for approval'}</button>
      </form>

      <div className="reports-table-wrapper">
        <table className="reports-table">
          <thead>
            <tr>
              <th>Period</th>
              <th>Scheduled</th>
              <th>Actual</th>
              <th>Overtime</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {timesheets.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-center">
                  No timesheets yet
                </td>
              </tr>
            ) : (
              timesheets.map((t) => (
                <tr key={t.id} id={`officer-timesheet-${t.id}`} className={t.id === requestedTimesheetId ? 'is-context-focus' : undefined}>
                  <td>
                    {new Date(t.period_start).toLocaleDateString()} – {new Date(t.period_end).toLocaleDateString()}
                  </td>
                  <td>{t.scheduled_hours ?? '-'}</td>
                  <td>{t.actual_hours ?? '-'}</td>
                  <td>{t.overtime_hours}</td>
                  <td>
                    <span className={`status-badge status-${t.status}`}>{t.status}</span>
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
