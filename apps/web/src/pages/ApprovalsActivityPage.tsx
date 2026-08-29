/**
 * ApprovalsActivityPage.tsx
 *
 * Governed writes queue: every Bob-proposed consequential action lives in
 * bob_agentic_actions and requires human approval before being applied.
 * Reads via the get_approvals_activity RPC (pre-joined org/user names,
 * can_decide flag); decisions are routed through bob-proposal-approver
 * (never a direct table write) so approval is a real gate, not decoration.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

type ActionStatus = 'pending' | 'approved' | 'rejected' | 'applied' | 'failed';

interface ApprovalRow {
  id: string;
  action_type: string;
  status: ActionStatus;
  bob_reasoning: string | null;
  confidence_score: number | null;
  context_table: string | null;
  context_summary: string | null;
  created_at: string;
  proposed_payload: Record<string, any>;
  org_name: string | null;
  triggered_by_name: string | null;
  user_name: string | null;
  approved_by_name: string | null;
  rejection_reason: string | null;
  error_message: string | null;
  can_decide: boolean;
}

const STATUS_FILTERS: { id: ActionStatus | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'applied', label: 'Applied' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'failed', label: 'Failed' },
];

const ApprovalsActivityPage: React.FC = () => {
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ActionStatus | 'all'>('pending');
  const [busyId, setBusyId] = useState<string | null>(null);

  // ATLAS READS: get_approvals_activity (RPC over bob_agentic_actions)
  const loadActivity = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const { data, error: err } = await supabase.rpc('get_approvals_activity', {
        p_limit: 100,
        p_offset: 0,
        p_statuses: filter === 'all' ? null : [filter],
        p_action_types: null,
      });

      if (err) throw err;
      setRows((data as ApprovalRow[]) || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load approvals');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    loadActivity();
  }, [loadActivity]);

  const handleDecision = async (row: ApprovalRow, decision: 'approve' | 'reject') => {
    try {
      setBusyId(row.id);
      setError(null);

      // ATLAS CALLS: bob-proposal-approver
      const { error: fnError } = await supabase.functions.invoke('bob-proposal-approver', {
        body: { action_id: row.id, action: decision },
      });

      if (fnError) throw fnError;
      await loadActivity();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${decision} action`);
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading approvals...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Approvals & Activity</h1>
        <p className="subtitle">Human sign-off queue for Bob-proposed actions</p>
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
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.id}
            className={`btn btn-sm ${filter === f.id ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="contacts-list">
        {rows.length === 0 ? (
          <div className="empty-state">
            <p>No actions in this filter.</p>
          </div>
        ) : (
          rows.map((row) => (
            <div key={row.id} className="contact-card">
              <div className="contact-header">
                <h3>{row.action_type}</h3>
                <span className={`status-badge status-${row.status}`}>{row.status}</span>
              </div>
              <div className="contact-details">
                {row.context_summary && <p>{row.context_summary}</p>}
                {row.bob_reasoning && <p className="contact-meta">Bob's reasoning: {row.bob_reasoning}</p>}
                <p className="contact-meta">
                  Triggered by {row.triggered_by_name || row.user_name || 'unknown'} ·{' '}
                  {new Date(row.created_at).toLocaleString()}
                  {row.context_table ? ` · targets ${row.context_table}` : ''}
                  {row.confidence_score != null ? ` · confidence ${Math.round(row.confidence_score * 100)}%` : ''}
                </p>
                {row.approved_by_name && (
                  <p className="contact-meta">Decided by {row.approved_by_name}</p>
                )}
                {row.rejection_reason && <p className="contact-meta">Rejected: {row.rejection_reason}</p>}
                {row.error_message && <p className="contact-meta">Error: {row.error_message}</p>}
              </div>
              {row.status === 'pending' && row.can_decide && (
                <div className="assessment-actions">
                  <button
                    className="btn btn-sm btn-secondary"
                    disabled={busyId === row.id}
                    onClick={() => handleDecision(row, 'approve')}
                  >
                    Approve
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    disabled={busyId === row.id}
                    onClick={() => handleDecision(row, 'reject')}
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default ApprovalsActivityPage;
