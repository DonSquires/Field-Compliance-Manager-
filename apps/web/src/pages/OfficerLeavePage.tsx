/**
 * OfficerLeavePage.tsx (Officer module: 'leave')
 *
 * Canonical schema: leave_requests (staff_id, leave_type, starts_on/ends_on,
 * status). Officer-scoped self-service: submit and view own requests.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

type LeaveType = 'annual' | 'sick' | 'bereavement' | 'parental' | 'unpaid' | 'other';

interface LeaveRequest {
  id: string;
  leave_type: LeaveType;
  starts_on: string;
  ends_on: string;
  status: string;
  reason: string | null;
}

const OfficerLeavePage: React.FC = () => {
  const { profile } = useAuth();
  const [requests, setRequests] = useState<LeaveRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ leave_type: 'annual' as LeaveType, starts_on: '', ends_on: '', reason: '' });

  // ATLAS READS: leave_requests
  const loadRequests = useCallback(async () => {
    if (!profile?.id) return;
    try {
      setLoading(true);
      setError(null);

      const { data, error: err } = await supabase
        .from('leave_requests')
        .select('id, leave_type, starts_on, ends_on, status, reason')
        .eq('staff_id', profile.id)
        .order('starts_on', { ascending: false });

      if (err) throw err;
      setRequests((data as LeaveRequest[]) || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load leave requests');
    } finally {
      setLoading(false);
    }
  }, [profile?.id]);

  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile?.id || !profile?.organizationId) return;

    try {
      // ATLAS WRITES: leave_requests
      const { data, error } = await supabase
        .from('leave_requests')
        .insert([
          {
            organization_id: profile.organizationId,
            staff_id: profile.id,
            leave_type: form.leave_type,
            starts_on: form.starts_on,
            ends_on: form.ends_on,
            reason: form.reason || null,
            status: 'pending',
          },
        ])
        .select()
        .single();

      if (error) throw error;
      setRequests([data as LeaveRequest, ...requests]);
      setForm({ leave_type: 'annual', starts_on: '', ends_on: '', reason: '' });
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit leave request');
    }
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading leave requests...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Leave</h1>
        <p className="subtitle">{requests.length} requests</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      <button className="btn btn-primary btn-sm" onClick={() => setShowForm(!showForm)}>
        {showForm ? 'Cancel' : '+ Request Leave'}
      </button>

      {showForm && (
        <form className="assessment-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Leave Type</label>
            <select value={form.leave_type} onChange={(e) => setForm({ ...form, leave_type: e.target.value as LeaveType })}>
              <option value="annual">Annual</option>
              <option value="sick">Sick</option>
              <option value="bereavement">Bereavement</option>
              <option value="parental">Parental</option>
              <option value="unpaid">Unpaid</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Starts</label>
              <input type="date" required value={form.starts_on} onChange={(e) => setForm({ ...form, starts_on: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Ends</label>
              <input type="date" required value={form.ends_on} onChange={(e) => setForm({ ...form, ends_on: e.target.value })} />
            </div>
          </div>
          <div className="form-group">
            <label>Reason</label>
            <textarea rows={3} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </div>
          <button type="submit" className="btn btn-primary btn-block">
            Submit Request
          </button>
        </form>
      )}

      <div className="contacts-list" style={{ marginTop: '12px' }}>
        {requests.length === 0 ? (
          <div className="empty-state">
            <p>No leave requests yet.</p>
          </div>
        ) : (
          requests.map((r) => (
            <div key={r.id} className="contact-card">
              <div className="contact-header">
                <h3>{r.leave_type}</h3>
                <span className={`status-badge status-${r.status}`}>{r.status}</span>
              </div>
              <div className="contact-details">
                <p>
                  {new Date(r.starts_on).toLocaleDateString()} – {new Date(r.ends_on).toLocaleDateString()}
                </p>
                {r.reason && <p className="contact-meta">{r.reason}</p>}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default OfficerLeavePage;
