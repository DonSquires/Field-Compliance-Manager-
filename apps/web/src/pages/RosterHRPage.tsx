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

type RosterTab = 'staff' | 'credentials' | 'shift-templates' | 'coverage' | 'leave' | 'timesheets';

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

interface CoverageRequestRow {
  id: string;
  shift_date: string;
  start_time: string;
  end_time: string;
  required_staff_count: number;
  urgency: string;
  status: string;
  notes: string | null;
  site_name: string | null;
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
  { id: 'coverage', label: 'Open Shifts' },
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
  const [coverageRequests, setCoverageRequests] = useState<CoverageRequestRow[]>([]);
  const [showCoverageForm, setShowCoverageForm] = useState(false);
  const [coverageForm, setCoverageForm] = useState({
    shift_date: '',
    start_time: '',
    end_time: '',
    required_staff_count: '1',
    urgency: 'normal',
    notes: '',
  });

  // ATLAS READS: user_profiles, staff_profiles, staff_credentials,
  // shift_templates, leave_requests, timesheets, shift_coverage_requests
  const loadAll = useCallback(async () => {
    const orgId = profile?.organizationId;
    if (!orgId) return;

    try {
      setLoading(true);
      setError(null);

      const [profilesRes, staffProfilesRes, credentialsRes, templatesRes, leaveRes, timesheetsRes, coverageRes] =
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
          supabase
            .from('shift_coverage_requests')
            .select('id, shift_date, start_time, end_time, required_staff_count, urgency, status, notes, site:site_id(name)')
            .eq('organization_id', orgId)
            .eq('status', 'open')
            .order('urgency', { ascending: false })
            .order('shift_date', { ascending: true }),
        ]);

      if (profilesRes.error) throw profilesRes.error;
      if (staffProfilesRes.error) throw staffProfilesRes.error;
      if (credentialsRes.error) throw credentialsRes.error;
      if (templatesRes.error) throw templatesRes.error;
      if (leaveRes.error) throw leaveRes.error;
      if (timesheetsRes.error) throw timesheetsRes.error;
      if (coverageRes.error) throw coverageRes.error;

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
      setCoverageRequests(
        ((coverageRes.data as any[]) || []).map((row) => ({
          id: row.id,
          shift_date: row.shift_date,
          start_time: row.start_time,
          end_time: row.end_time,
          required_staff_count: row.required_staff_count,
          urgency: row.urgency,
          status: row.status,
          notes: row.notes,
          site_name: row.site?.name ?? null,
        }))
      );
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

  const handleCreateCoverage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile?.id || !profile?.organizationId) return;
    if (!coverageForm.shift_date || !coverageForm.start_time || !coverageForm.end_time) return;

    try {
      // ATLAS WRITES: shift_coverage_requests (fires trg_notify_shift_coverage_open_created)
      const { data, error } = await supabase
        .from('shift_coverage_requests')
        .insert([
          {
            organization_id: profile.organizationId,
            shift_date: coverageForm.shift_date,
            start_time: coverageForm.start_time,
            end_time: coverageForm.end_time,
            required_staff_count: Number(coverageForm.required_staff_count) || 1,
            urgency: coverageForm.urgency,
            notes: coverageForm.notes || null,
            created_by: profile.id,
          },
        ])
        .select('id, shift_date, start_time, end_time, required_staff_count, urgency, status, notes')
        .single();

      if (error) throw error;
      setCoverageRequests([{ ...(data as CoverageRequestRow), site_name: null }, ...coverageRequests]);
      setCoverageForm({ shift_date: '', start_time: '', end_time: '', required_staff_count: '1', urgency: 'normal', notes: '' });
      setShowCoverageForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create coverage request');
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

      {tab === 'coverage' && (
        <section className="reports-section">
          <h2>Open Shifts ({coverageRequests.length})</h2>
          <button className="btn btn-primary btn-sm" onClick={() => setShowCoverageForm(!showCoverageForm)}>
            {showCoverageForm ? 'Cancel' : '+ New Coverage Request'}
          </button>

          {showCoverageForm && (
            <form className="assessment-form" onSubmit={handleCreateCoverage}>
              <div className="form-row">
                <div className="form-group">
                  <label>Date</label>
                  <input
                    type="date"
                    required
                    value={coverageForm.shift_date}
                    onChange={(e) => setCoverageForm({ ...coverageForm, shift_date: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Required Staff</label>
                  <input
                    type="number"
                    min={1}
                    value={coverageForm.required_staff_count}
                    onChange={(e) => setCoverageForm({ ...coverageForm, required_staff_count: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Start Time</label>
                  <input
                    type="time"
                    required
                    value={coverageForm.start_time}
                    onChange={(e) => setCoverageForm({ ...coverageForm, start_time: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>End Time</label>
                  <input
                    type="time"
                    required
                    value={coverageForm.end_time}
                    onChange={(e) => setCoverageForm({ ...coverageForm, end_time: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-group">
                <label>Urgency</label>
                <select value={coverageForm.urgency} onChange={(e) => setCoverageForm({ ...coverageForm, urgency: e.target.value })}>
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </div>
              <div className="form-group">
                <label>Notes</label>
                <textarea
                  rows={2}
                  value={coverageForm.notes}
                  onChange={(e) => setCoverageForm({ ...coverageForm, notes: e.target.value })}
                />
              </div>
              <button type="submit" className="btn btn-primary btn-block">
                Create Request
              </button>
            </form>
          )}

          <div className="contacts-list" style={{ marginTop: '12px' }}>
            {coverageRequests.length === 0 ? (
              <div className="empty-state">
                <p>No open shifts need coverage right now.</p>
              </div>
            ) : (
              coverageRequests.map((c) => (
                <div key={c.id} className="contact-card">
                  <div className="contact-header">
                    <h3>
                      {new Date(c.shift_date).toLocaleDateString()} · {c.start_time.slice(0, 5)}–{c.end_time.slice(0, 5)}
                    </h3>
                    <span className={`badge ${c.urgency === 'urgent' || c.urgency === 'high' ? 'badge-danger' : 'badge-info'}`}>
                      {c.urgency.toUpperCase()}
                    </span>
                  </div>
                  <div className="contact-details">
                    <p className="contact-meta">
                      {c.site_name ? `${c.site_name} · ` : ''}
                      Requires {c.required_staff_count} staff
                    </p>
                    {c.notes && <p className="contact-meta">{c.notes}</p>}
                  </div>
                </div>
              ))
            )}
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
