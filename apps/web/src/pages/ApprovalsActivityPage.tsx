/**
 * ApprovalsActivityPage.tsx
 *
 * Unified governed-work queue for operational actions and Builder job gates.
 * Both sources are read through scoped RPCs, and decisions use guarded
 * functions rather than direct table writes.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

type ActionStatus = 'pending' | 'approved' | 'rejected' | 'applied' | 'failed' | 'cancelled';

interface ReviewedArtifact {
  id: string;
  artifact_type: string;
  content_type: string | null;
  content_size_bytes: number | null;
  checksum: string | null;
  status: string;
  version_number: number;
}

interface ApprovalRow {
  source: 'operational' | 'builder';
  id: string;
  action_type: string;
  status: ActionStatus;
  bob_reasoning: string | null;
  confidence_score: number | null;
  context_table: string | null;
  context_summary: string | null;
  created_at: string;
  proposed_payload?: Record<string, any>;
  org_name: string | null;
  triggered_by_name: string | null;
  user_name: string | null;
  approved_by_name: string | null;
  rejection_reason: string | null;
  error_message: string | null;
  can_decide: boolean;
  job_title?: string;
  repository?: string;
  target_sha?: string | null;
  reviewed_artifacts?: ReviewedArtifact[];
}

const STATUS_FILTERS: { id: ActionStatus | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'applied', label: 'Applied' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'failed', label: 'Failed' },
  { id: 'cancelled', label: 'Cancelled' },
];

const ApprovalsActivityPage: React.FC = () => {
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ActionStatus | 'all'>('pending');
  const [busyId, setBusyId] = useState<string | null>(null);

  // ATLAS READS: get_approvals_activity, get_builder_approvals_activity
  const loadActivity = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const builderSupportsFilter = filter === 'all' || ['pending', 'approved', 'rejected', 'cancelled'].includes(filter);
      const [operationalResult, builderResult] = await Promise.all([
        supabase.rpc('get_approvals_activity', {
          p_limit: 100,
          p_offset: 0,
          p_statuses: filter === 'all' ? null : [filter],
          p_action_types: null,
        }),
        builderSupportsFilter
          ? supabase.rpc('get_builder_approvals_activity', {
              p_limit: 100,
              p_offset: 0,
              p_statuses: filter === 'all' ? null : [filter],
              p_approval_types: null,
            })
          : Promise.resolve({ data: [], error: null }),
      ]);

      if (operationalResult.error) throw operationalResult.error;
      if (builderResult.error) throw builderResult.error;

      const operationalRows = ((operationalResult.data || []) as Omit<ApprovalRow, 'source'>[])
        .map((row) => ({ ...row, source: 'operational' as const }));
      const builderRows = ((builderResult.data || []) as Array<Record<string, any>>)
        .map((row): ApprovalRow => ({
          source: 'builder',
          id: row.id,
          action_type: row.approval_type,
          status: row.status,
          bob_reasoning: null,
          confidence_score: null,
          context_table: row.repository,
          context_summary: row.job_title,
          created_at: row.requested_at,
          org_name: row.org_name,
          triggered_by_name: 'Bob Builder',
          user_name: null,
          approved_by_name: row.decided_by_name,
          rejection_reason: row.status === 'rejected' ? row.approval_comment : null,
          error_message: null,
          can_decide: row.can_decide,
          job_title: row.job_title,
          repository: row.repository,
          target_sha: row.target_sha,
          reviewed_artifacts: row.reviewed_artifacts || [],
        }));

      setRows([...operationalRows, ...builderRows].sort(
        (left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
      ));
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

      if (row.source === 'builder') {
        // ATLAS CALLS: builder_decide_approval, builder_decide_human_code_review
        const decisionRpc = row.action_type === 'implementation_review'
          ? 'builder_decide_human_code_review'
          : 'builder_decide_approval';
        const { error: decisionError } = await supabase.rpc(decisionRpc, {
          _approval_id: row.id,
          _decision: decision === 'approve' ? 'approved' : 'rejected',
          _comment: null,
        });
        if (decisionError) throw decisionError;
      } else {
        // ATLAS CALLS: bob-proposal-approver
        const { error: fnError } = await supabase.functions.invoke('bob-proposal-approver', {
          body: { action_id: row.id, action: decision },
        });
        if (fnError) throw fnError;
      }
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
                <h3>{row.source === 'builder' ? row.job_title : row.action_type}</h3>
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
                {row.source === 'builder' && (
                  <p className="contact-meta">
                    Builder gate: {row.action_type.replaceAll('_', ' ')}
                    {row.target_sha ? ` · commit ${row.target_sha.slice(0, 12)}` : ''}
                  </p>
                )}
                {row.reviewed_artifacts && row.reviewed_artifacts.length > 0 && (
                  <div className="approval-artifacts">
                    <strong>Reviewed artifacts</strong>
                    <ul>
                      {row.reviewed_artifacts.map((artifact) => (
                        <li key={artifact.id}>
                          {artifact.artifact_type.replaceAll('_', ' ')} · v{artifact.version_number}
                          {artifact.content_size_bytes != null ? ` · ${artifact.content_size_bytes.toLocaleString()} bytes` : ''}
                          {artifact.checksum ? ` · SHA-256 ${artifact.checksum.slice(0, 12)}` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
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
