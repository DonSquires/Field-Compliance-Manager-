/**
 * OfficerTimesheetPage.tsx (Officer module: 'timesheet')
 *
 * Canonical schema: timesheets (staff_id, period_start/end, scheduled_hours,
 * actual_hours, status). Officer-scoped read-only view of own timesheets;
 * approval is an admin/HR action (see RosterHRPage), not done here.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface Timesheet {
  id: string;
  period_start: string;
  period_end: string;
  scheduled_hours: number | null;
  actual_hours: number | null;
  overtime_hours: number;
  status: string;
}

const OfficerTimesheetPage: React.FC = () => {
  const { profile } = useAuth();
  const [timesheets, setTimesheets] = useState<Timesheet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ATLAS READS: timesheets
  useEffect(() => {
    const load = async () => {
      if (!profile?.id) return;
      try {
        setLoading(true);
        setError(null);

        const { data, error: err } = await supabase
          .from('timesheets')
          .select('id, period_start, period_end, scheduled_hours, actual_hours, overtime_hours, status')
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
                <tr key={t.id}>
                  <td>
                    {new Date(t.period_start).toLocaleDateString()} – {new Date(t.period_end).toLocaleDateString()}
                  </td>
                  <td>{t.scheduled_hours ?? '-'}</td>
                  <td>{t.actual_hours ?? '-'}</td>
                  <td>{t.overtime_hours}</td>
                  <td>
                    <span className={`status-badge status-${t.status}`}>{t.status}</span>
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
