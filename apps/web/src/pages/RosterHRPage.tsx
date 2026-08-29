/**
 * RosterHRPage.tsx
 *
 * Canonical schema: user_profiles (identity/role) + staff_profiles (employment
 * detail, 1:1 via id) + staff_credentials (licences/warrants, expiry) +
 * shift_templates (recurring coverage patterns) + leave_requests (approval
 * queue) + timesheets (hours, approval, payroll export).
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

type RosterTab = 'staff' | 'credentials' | 'shift-templates' | 'leave' | 'timesheets';

interface StaffRow {
  id: string;
  display_name: string | null;
  role: string;
  email: string | null;
  phone: string | null;
  employment_type: string | null;
  start_date: string | null;
  work_ready: boolean | null;
}

interface CredentialRow {
  id: string;
  staff_id: string;
  credential_type: string;
  credential_number: string | null;
  expiry_date: string | null;
  verified: boolean;
}

interface ShiftTemplateRow {
  id: string;
  name: string;
  shift_type: string;
  start_time: string;
  end_time: string;
  recurrence_type: string;
  required_staff_count: number;
  is_active: boolean;
}

interface LeaveRequestRow {
  id: string;
  staff_id: string;
  leave_type: string;
  starts_on: string;
  ends_on: string;
  status: string;
  reason: string | null;
}

interface TimesheetRow {
  id: string;
  staff_id: string;
  period_start: string;
  period_end: string;
  scheduled_hours: number | null;
  actual_hours: number | null;
  status: string;
}

const TABS: { id: RosterTab; label: string }[] = [
  { id: 'staff', label: 'Staff' },
  { id: 'credentials', label: 'Credentials' },
  { id: 'shift-templates', label: 'Shift Templates' },
  { id: 'leave', label: 'Leave' },
  { id: 'timesheets', label: 'Timesheets' },
];

const RosterHRPage: React.FC = () => {
  const { profile } = useAuth();
  const [tab, setTab] = useState<RosterTab>('staff');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [credentials, setCredentials] = useState<CredentialRow[]>([]);
  const [shiftTemplates, setShiftTemplates] = useState<ShiftTemplateRow[]>([]);
  const [leaveRequests, setLeaveRequests] = useState<LeaveRequestRow[]>([]);
  const [timesheets, setTimesheets] = useState<TimesheetRow[]>([]);
  const [staffNames, setStaffNames] = useState<Record<string, string>>({});

  // ATLAS READS: user_profiles, staff_profiles, staff_credentials,
  // shift_templates, leave_requests, timesheets
  const loadAll = useCallback(async () => {
    const orgId = profile?.organizationId;
    if (!orgId) return;

    try {
      setLoading(true);
      setError(null);

      const [profilesRes, staffProfilesRes, credentialsRes, templatesRes, leaveRes, timesheetsRes] =
        await Promise.all([
          supabase
            .from('user_profiles')
            .select('id, display_name, role, email, phone')
            .eq('organization_id', orgId),
          supabase
            .from('staff_profiles')
            .select('id, employment_type, start_date, work_ready')
            .eq('organization_id', orgId),
          supabase
            .from('staff_credentials')
            .select('id, staff_id, credential_type, credential_number, expiry_date, verified')
            .eq('organization_id', orgId)
            .order('expiry_date', { ascending: true }),
          supabase
            .from('shift_templates')
            .select('id, name, shift_type, start_time, end_time, recurrence_type, required_staff_count, is_active')
            .eq('organization_id', orgId)
            .order('name', { ascending: true }),
          supabase
            .from('leave_requests')
            .select('id, staff_id, leave_type, starts_on, ends_on, status, reason')
            .eq('organization_id', orgId)
            .order('starts_on', { ascending: false }),
          supabase
            .from('timesheets')
            .select('id, staff_id, period_start, period_end, scheduled_hours, actual_hours, status')
            .eq('organization_id', orgId)
            .order('period_start', { ascending: false }),
        ]);

      if (profilesRes.error) throw profilesRes.error;
      if (staffProfilesRes.error) throw staffProfilesRes.error;
      if (credentialsRes.error) throw credentialsRes.error;
      if (templatesRes.error) throw templatesRes.error;
      if (leaveRes.error) throw leaveRes.error;
      if (timesheetsRes.error) throw timesheetsRes.error;

      const staffProfileById = new Map((staffProfilesRes.data || []).map((s: any) => [s.id, s]));
      const merged: StaffRow[] = (profilesRes.data || []).map((p: any) => ({
        id: p.id,
        display_name: p.display_name,
        role: p.role,
        email: p.email,
        phone: p.phone,
        employment_type: staffProfileById.get(p.id)?.employment_type ?? null,
        start_date: staffProfileById.get(p.id)?.start_date ?? null,
        work_ready: staffProfileById.get(p.id)?.work_ready ?? null,
      }));

      const names: Record<string, string> = {};
      merged.forEach((s) => {
        names[s.id] = s.display_name || s.email || s.id;
      });

      setStaff(merged);
      setStaffNames(names);
      setCredentials((credentialsRes.data as CredentialRow[]) || []);
      setShiftTemplates((templatesRes.data as ShiftTemplateRow[]) || []);
      setLeaveRequests((leaveRes.data as LeaveRequestRow[]) || []);
      setTimesheets((timesheetsRes.data as TimesheetRow[]) || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load roster data');
    } finally {
      setLoading(false);
    }
  }, [profile?.organizationId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleLeaveDecision = async (id: string, status: 'approved' | 'declined') => {
    if (!profile?.id) return;
    try {
      // ATLAS WRITES: leave_requests
      const { error } = await supabase
        .from('leave_requests')
        .update({ status, approved_by: profile.id, approved_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
      setLeaveRequests(leaveRequests.map((l) => (l.id === id ? { ...l, status } : l)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update leave request');
    }
  };

  const handleTimesheetDecision = async (id: string, status: 'approved' | 'rejected') => {
    if (!profile?.id) return;
    try {
      // ATLAS WRITES: timesheets
      const { error } = await supabase
        .from('timesheets')
        .update({ status, approved_by: profile.id, approved_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
      setTimesheets(timesheets.map((t) => (t.id === id ? { ...t, status } : t)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update timesheet');
    }
  };

  const isExpiringSoon = (expiryDate: string | null) => {
    if (!expiryDate) return false;
    const days = (new Date(expiryDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    return days <= 30;
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading roster & HR data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container roster-hr-page">
      <header className="page-header">
        <h1>Roster & HR</h1>
        <p className="subtitle">{staff.length} staff · Credentials, shifts, leave, timesheets</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      <div className="crm-branch-filter">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`btn btn-sm ${tab === t.id ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'staff' && (
        <section className="reports-section">
          <h2>Staff ({staff.length})</h2>
          <div className="contacts-list">
            {staff.length === 0 ? (
              <div className="empty-state">
                <p>No staff records for this organisation.</p>
              </div>
            ) : (
              staff.map((s) => (
                <div key={s.id} className="contact-card">
                  <div className="contact-header">
                    <h3>{s.display_name || s.email || 'Unnamed'}</h3>
                    <span className="contact-type-badge">{s.role}</span>
                  </div>
                  <div className="contact-details">
                    <p>{s.email}</p>
                    <p className="contact-meta">
                      {s.employment_type || 'employment type not set'}
                      {s.start_date ? ` · started ${new Date(s.start_date).toLocaleDateString()}` : ''}
                      {s.work_ready === false ? ' · NOT work ready' : ''}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      )}

      {tab === 'credentials' && (
        <section className="reports-section">
          <h2>Credentials ({credentials.length})</h2>
          <div className="reports-table-wrapper">
            <table className="reports-table">
              <thead>
                <tr>
                  <th>Staff</th>
                  <th>Type</th>
                  <th>Number</th>
                  <th>Expiry</th>
                  <th>Verified</th>
                </tr>
              </thead>
              <tbody>
                {credentials.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-center">
                      No credentials recorded
                    </td>
                  </tr>
                ) : (
                  credentials.map((c) => (
                    <tr key={c.id}>
                      <td>{staffNames[c.staff_id] || c.staff_id}</td>
                      <td>{c.credential_type}</td>
                      <td>{c.credential_number || '-'}</td>
                      <td>
                        <span className={isExpiringSoon(c.expiry_date) ? 'severity-badge severity-high' : ''}>
                          {c.expiry_date ? new Date(c.expiry_date).toLocaleDateString() : 'No expiry'}
                        </span>
                      </td>
                      <td>{c.verified ? '✓' : '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === 'shift-templates' && (
        <section className="reports-section">
          <h2>Shift Templates ({shiftTemplates.length})</h2>
          <div className="contacts-list">
            {shiftTemplates.length === 0 ? (
              <div className="empty-state">
                <p>No shift templates configured.</p>
              </div>
            ) : (
              shiftTemplates.map((t) => (
                <div key={t.id} className="contact-card">
                  <div className="contact-header">
                    <h3>{t.name}</h3>
                    <span className="contact-type-badge">{t.shift_type}</span>
                  </div>
                  <div className="contact-details">
                    <p>
                      {t.start_time} – {t.end_time} · {t.recurrence_type}
                    </p>
                    <p className="contact-meta">
                      Requires {t.required_staff_count} staff · {t.is_active ? 'Active' : 'Inactive'}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      )}

      {tab === 'leave' && (
        <section className="reports-section">
          <h2>Leave Requests ({leaveRequests.length})</h2>
          <div className="contacts-list">
            {leaveRequests.length === 0 ? (
              <div className="empty-state">
                <p>No leave requests.</p>
              </div>
            ) : (
              leaveRequests.map((l) => (
                <div key={l.id} className="contact-card">
                  <div className="contact-header">
                    <h3>{staffNames[l.staff_id] || l.staff_id}</h3>
                    <span className={`status-badge status-${l.status}`}>{l.status}</span>
                  </div>
                  <div className="contact-details">
                    <p>
                      {l.leave_type} · {new Date(l.starts_on).toLocaleDateString()} –{' '}
                      {new Date(l.ends_on).toLocaleDateString()}
                    </p>
                    {l.reason && <p className="contact-meta">{l.reason}</p>}
                  </div>
                  {l.status === 'pending' && (
                    <div className="assessment-actions">
                      <button className="btn btn-sm btn-secondary" onClick={() => handleLeaveDecision(l.id, 'approved')}>
                        Approve
                      </button>
                      <button className="btn btn-sm btn-danger" onClick={() => handleLeaveDecision(l.id, 'declined')}>
                        Decline
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </section>
      )}

      {tab === 'timesheets' && (
        <section className="reports-section">
          <h2>Timesheets ({timesheets.length})</h2>
          <div className="reports-table-wrapper">
            <table className="reports-table">
              <thead>
                <tr>
                  <th>Staff</th>
                  <th>Period</th>
                  <th>Scheduled</th>
                  <th>Actual</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {timesheets.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center">
                      No timesheets
                    </td>
                  </tr>
                ) : (
                  timesheets.map((t) => (
                    <tr key={t.id}>
                      <td>{staffNames[t.staff_id] || t.staff_id}</td>
                      <td>
                        {new Date(t.period_start).toLocaleDateString()} –{' '}
                        {new Date(t.period_end).toLocaleDateString()}
                      </td>
                      <td>{t.scheduled_hours ?? '-'}</td>
                      <td>{t.actual_hours ?? '-'}</td>
                      <td>
                        <span className={`status-badge status-${t.status}`}>{t.status}</span>
                      </td>
                      <td>
                        {t.status === 'submitted' && (
                          <>
                            <button
                              className="btn btn-sm btn-secondary"
                              onClick={() => handleTimesheetDecision(t.id, 'approved')}
                            >
                              Approve
                            </button>{' '}
                            <button
                              className="btn btn-sm btn-danger"
                              onClick={() => handleTimesheetDecision(t.id, 'rejected')}
                            >
                              Reject
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
};

export default RosterHRPage;
