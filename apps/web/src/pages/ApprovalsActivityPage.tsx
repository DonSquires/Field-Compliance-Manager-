import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight, Clock3, FileCheck2, Filter, History, RefreshCw, Search, ShieldCheck, X, XCircle } from 'lucide-react';
import { formatGovernedPayload } from '../lib/governedPayload';
import { supabase } from '../lib/supabase';
import './ApprovalsActivityPage.css';

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
  applied_at: string | null;
  approved_at: string | null;
  proposed_payload: Record<string, unknown>;
  amended_payload: Record<string, unknown> | null;
  org_name: string | null;
  triggered_by_name: string | null;
  user_name: string | null;
  approved_by_name: string | null;
  rejection_reason: string | null;
  error_message: string | null;
  result_table: string | null;
  result_record_id: string | null;
  assigned_approver_id: string | null;
  assigned_approver_name: string | null;
  can_decide: boolean;
}

const STATUS_FILTERS: Array<{ id: ActionStatus | 'all'; label: string }> = [
  { id: 'pending', label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'applied', label: 'Applied' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'failed', label: 'Failed' },
  { id: 'all', label: 'All activity' },
];

const ApprovalsActivityPage: React.FC = () => {
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<ActionStatus | 'all'>('pending');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [decision, setDecision] = useState<'approve' | 'reject' | null>(null);
  const [reasoning, setReasoning] = useState('');
  const [applyAfterApprove, setApplyAfterApprove] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [payloadLabels, setPayloadLabels] = useState<Record<string, string>>({});

  const loadActivity = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: queryError } = await supabase.rpc('get_approvals_activity', {
        p_limit: 100,
        p_offset: 0,
        p_statuses: filter === 'all' ? null : [filter],
        p_action_types: null,
      });
      if (queryError) throw queryError;
      const activity = (data as ApprovalRow[]) ?? [];
      setRows(activity);
      setSelectedId((current) => current && activity.some((row) => row.id === current) ? current : activity[0]?.id ?? null);
    } catch (loadError) {
      setRows([]);
      setSelectedId(null);
      setError(loadError instanceof Error ? loadError.message : 'Governed actions could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);

  useEffect(() => {
    const payload = selectedPayload(rows.find((row) => row.id === selectedId) ?? null);
    if (!payload) { setPayloadLabels({}); return; }
    const loadLabels = async () => {
      const labels: Record<string, string> = {};
      if (typeof payload.site_id === 'string') {
        const { data } = await supabase.from('client_sites').select('id,name,address').eq('id', payload.site_id).maybeSingle();
        if (data) labels.site_id = `${data.name}${data.address ? ` · ${data.address}` : ''}`;
      }
      if (typeof payload.patrol_route_id === 'string') {
        const { data } = await supabase.from('patrol_routes').select('id,name,route_code').eq('id', payload.patrol_route_id).maybeSingle();
        if (data) labels.patrol_route_id = data.route_code ? `[${data.route_code}] ${data.name}` : data.name;
      }
      setPayloadLabels(labels);
    };
    void loadLabels();
  }, [rows, selectedId]);

  const visibleRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((row) => [row.action_type, row.context_summary, row.context_table, row.org_name, row.triggered_by_name]
      .some((value) => value?.toLowerCase().includes(term)));
  }, [rows, search]);

  const selected = rows.find((row) => row.id === selectedId) ?? null;
  const pendingCount = rows.filter((row) => row.status === 'pending').length;
  const failedCount = rows.filter((row) => row.status === 'failed').length;
  const decidableCount = rows.filter((row) => row.status === 'pending' && row.can_decide).length;

  const openDecision = (nextDecision: 'approve' | 'reject') => {
    setDecision(nextDecision);
    setReasoning('');
    setApplyAfterApprove(false);
    setError(null);
  };

  const submitDecision = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !decision || !reasoning.trim() || !selected.can_decide) return;
    setBusyId(selected.id);
    setError(null);
    setNotice(null);
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('bob-proposal-approver', {
        body: {
          action_id: selected.id,
          action: decision,
          reasoning: reasoning.trim(),
          apply: decision === 'approve' && applyAfterApprove,
        },
      });
      if (invokeError) throw invokeError;
      const response = data as { status?: string; applied?: boolean; apply_error?: string; note?: string } | null;
      if (response?.apply_error) {
        setNotice(`Approval recorded, but application failed: ${response.apply_error}`);
      } else {
        setNotice(response?.note ?? `Action ${decision === 'approve' ? 'approved' : 'rejected'} successfully.`);
      }
      setDecision(null);
      setReasoning('');
      await loadActivity();
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : `The ${decision} decision could not be recorded.`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="approvals-page">
      <header className="approvals-heading">
        <div><span>Governed operations</span><h1>Approvals and activity</h1><p>Review consequential actions before they enter the application.</p></div>
        <button type="button" onClick={() => void loadActivity()} disabled={loading}><RefreshCw size={17} className={loading ? 'is-spinning' : ''} /> Refresh</button>
      </header>

      <section className="approvals-summary" aria-label="Approval queue summary">
        <div><Clock3 size={18} /><span>Pending in view</span><strong>{pendingCount}</strong></div>
        <div><ShieldCheck size={18} /><span>You can decide</span><strong>{decidableCount}</strong></div>
        <div><AlertTriangle size={18} /><span>Failed in view</span><strong>{failedCount}</strong></div>
        <div><History size={18} /><span>Loaded activity</span><strong>{rows.length}</strong></div>
      </section>

      {error && <div className="approvals-message is-error" role="alert"><AlertTriangle size={17} /><span>{error}</span><button type="button" onClick={() => setError(null)}><X size={16} /><span className="sr-only">Dismiss</span></button></div>}
      {notice && <div className={`approvals-message ${notice.includes('failed') ? 'is-warning' : 'is-success'}`} role="status"><CheckCircle2 size={17} /><span>{notice}</span><button type="button" onClick={() => setNotice(null)}><X size={16} /><span className="sr-only">Dismiss</span></button></div>}

      <div className="approvals-toolbar">
        <div className="approvals-filters" role="tablist" aria-label="Action status">
          {STATUS_FILTERS.map((item) => <button type="button" role="tab" aria-selected={filter === item.id} className={filter === item.id ? 'is-active' : ''} onClick={() => setFilter(item.id)} key={item.id}>{item.label}</button>)}
        </div>
        <label className="approvals-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search actions, organisations, or targets" /></label>
      </div>

      <div className="approvals-layout">
        <section className="approvals-queue" aria-label="Governed action queue">
          <div className="approvals-panel-heading"><div><span>Queue</span><h2>{filter === 'all' ? 'All governed activity' : `${filter} actions`}</h2></div><Filter size={18} /></div>
          {loading ? <div className="approvals-empty"><RefreshCw size={20} className="is-spinning" /> Loading governed actions</div> : visibleRows.length === 0 ? <div className="approvals-empty"><FileCheck2 size={21} /> No actions match this view</div> : (
            <div className="approvals-list">
              {visibleRows.map((row) => (
                <button type="button" className={`${selectedId === row.id ? 'is-selected' : ''} status-${row.status}`} onClick={() => setSelectedId(row.id)} key={row.id}>
                  <span className="approvals-status-mark" />
                  <div><strong>{formatActionType(row.action_type)}</strong><small>{row.context_summary ?? row.context_table ?? 'No context summary provided'}</small></div>
                  <div><span>{row.org_name ?? 'Organisation unavailable'}</span><time dateTime={row.created_at}>{formatAge(row.created_at)}</time></div>
                  <ChevronRight size={17} />
                </button>
              ))}
            </div>
          )}
        </section>

        <aside className="approvals-detail">
          {!selected ? <div className="approvals-empty"><FileCheck2 size={22} /> Select an action to inspect</div> : (
            <>
              <div className="approvals-panel-heading"><div><span>Action review</span><h2>{formatActionType(selected.action_type)}</h2></div><span className={`approvals-status status-${selected.status}`}>{selected.status}</span></div>
              <p className="approvals-context">{selected.context_summary ?? 'No context summary was provided for this action.'}</p>

              <dl className="approvals-facts">
                <div><dt>Organisation</dt><dd>{selected.org_name ?? 'Unavailable'}</dd></div>
                <div><dt>Target</dt><dd>{selected.context_table ?? 'Not specified'}</dd></div>
                <div><dt>Triggered by</dt><dd>{selected.triggered_by_name ?? selected.user_name ?? 'Unknown'}</dd></div>
                <div><dt>Created</dt><dd>{new Date(selected.created_at).toLocaleString('en-NZ')}</dd></div>
                <div><dt>Confidence signal</dt><dd>{selected.confidence_score == null ? 'Not supplied' : `${Math.round(selected.confidence_score * 100)}%`}</dd></div>
                <div><dt>Decision owner</dt><dd>{selected.assigned_approver_id ? selected.assigned_approver_name ?? 'Assigned approver unavailable' : 'Role and organisation scope'}</dd></div>
                <div><dt>Your authority</dt><dd>{selected.can_decide ? 'Can decide' : 'View only'}</dd></div>
              </dl>

              <section className="approvals-reasoning"><span>Proposal reasoning</span><p>{selected.bob_reasoning ?? 'No reasoning was recorded with this proposal.'}</p></section>
              {selected.action_type === 'create_patrol_route_assignment' ? <HumanPatrolAssignmentSummary payload={selectedPayload(selected)} labels={payloadLabels} /> : <details className="approvals-payload"><summary>Proposal details</summary><pre>{formatGovernedPayload(selected.amended_payload ?? selected.proposed_payload)}</pre>{selected.amended_payload && <small>Showing the human-amended payload.</small>}</details>}
              <details className="approvals-payload"><summary>Technical details</summary><pre>{formatGovernedPayload(selected.amended_payload ?? selected.proposed_payload)}</pre>{selected.amended_payload && <small>Showing the human-amended payload.</small>}</details>

              {selected.rejection_reason && <div className="approvals-outcome is-rejected"><XCircle size={17} /><div><strong>Rejection reason</strong><span>{selected.rejection_reason}</span></div></div>}
              {selected.error_message && <div className="approvals-outcome is-failed"><AlertTriangle size={17} /><div><strong>Application error</strong><span>{selected.error_message}</span></div></div>}
              {selected.result_record_id && <div className="approvals-outcome is-applied"><CheckCircle2 size={17} /><div><strong>Applied result</strong><span>{selected.result_table ?? 'record'} · {selected.result_record_id}</span></div></div>}

              {selected.status === 'pending' && (
                selected.can_decide ? <div className="approvals-actions"><button type="button" className="is-reject" onClick={() => openDecision('reject')}><XCircle size={17} /> Reject</button><button type="button" className="is-approve" onClick={() => openDecision('approve')}><CheckCircle2 size={17} /> Review approval</button></div> : <div className="approvals-no-authority"><ShieldCheck size={17} /> {selected.assigned_approver_name ? `${selected.assigned_approver_name} owns this decision. Your current scope is view only.` : 'This decision is routed by role and organisation scope. Your current scope is view only.'}</div>
              )}
            </>
          )}
        </aside>
      </div>

      {decision && selected && (
        <div className="approvals-dialog-backdrop">
          <form className="approvals-dialog" onSubmit={submitDecision} role="dialog" aria-modal="true" aria-labelledby="decision-title">
            <div className="approvals-panel-heading"><div><span>Governed decision</span><h2 id="decision-title">{decision === 'approve' ? 'Approve action' : 'Reject action'}</h2></div><button type="button" onClick={() => setDecision(null)}><X size={18} /><span className="sr-only">Close</span></button></div>
            <div className="approvals-decision-target"><strong>{formatActionType(selected.action_type)}</strong><span>{selected.org_name ?? 'Unknown organisation'} · {selected.context_table ?? 'No target specified'}</span></div>
            <label><span>Decision reasoning</span><textarea required rows={4} value={reasoning} onChange={(event) => setReasoning(event.target.value)} placeholder={decision === 'approve' ? 'Why is this action appropriate and safe to approve?' : 'Why should this action not proceed?'} /></label>
            {decision === 'approve' && <label className="approvals-apply-option"><input type="checkbox" checked={applyAfterApprove} onChange={(event) => setApplyAfterApprove(event.target.checked)} /><span><strong>Approve and apply immediately</strong><small>Approval and execution remain separate audited steps. Leave off to approve without applying.</small></span></label>}
            <div className="approvals-dialog-actions"><button type="button" onClick={() => setDecision(null)}>Cancel</button><button type="submit" className={decision === 'approve' ? 'is-approve' : 'is-reject'} disabled={busyId === selected.id || !reasoning.trim()}>{busyId === selected.id ? 'Recording decision' : decision === 'approve' ? applyAfterApprove ? 'Approve and apply' : 'Approve' : 'Reject'}</button></div>
          </form>
        </div>
      )}
    </div>
  );
};

function formatActionType(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function selectedPayload(row: ApprovalRow | null): Record<string, any> | null {
  return (row?.amended_payload ?? row?.proposed_payload ?? null) as Record<string, any> | null;
}

function HumanPatrolAssignmentSummary({ payload, labels }: { payload: Record<string, any> | null; labels: Record<string, string> }) {
  if (!payload) return null;
  const days = Array.isArray(payload.active_days) ? payload.active_days.map((day: number) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][day - 1] ?? day).join(', ') : 'Not specified';
  return <section className="approvals-human-summary" aria-label="Human-readable patrol assignment"><div><span>Site</span><strong>{labels.site_id ?? 'Site name unavailable'}</strong></div><div><span>Patrol route / bucket</span><strong>{labels.patrol_route_id ?? 'Route name unavailable'}</strong></div><div><span>Service</span><strong>{String(payload.module_key ?? 'Not specified').replaceAll('_', ' ')}</strong></div><div><span>Visit window</span><strong>{payload.window_start && payload.window_end ? `${payload.window_start} to ${payload.window_end}` : 'Not specified'}</strong></div><div><span>Visits per shift</span><strong>{payload.visits_per_shift ?? 'Not specified'}</strong></div><div><span>Active days</span><strong>{days}</strong></div><div><span>Dwell time</span><strong>{payload.dwell_minutes != null ? `${payload.dwell_minutes} minutes` : 'Not specified'}</strong></div><div><span>Arrival / departure SLA</span><strong>{payload.sla_arrive_within_minutes != null ? `${payload.sla_arrive_within_minutes} / ${payload.sla_depart_within_minutes ?? 'not set'} minutes` : 'Not specified'}</strong></div><div><span>Stop order</span><strong>{payload.preferred_stop_order ?? 'Not specified'}</strong></div><div className="is-wide"><span>Instructions</span><strong>{payload.officer_instructions ?? 'None recorded'}</strong></div></section>;
}

function formatAge(value: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default ApprovalsActivityPage;