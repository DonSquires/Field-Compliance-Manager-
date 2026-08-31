import { useCallback, useEffect, useState } from 'react';
import { Check, CircleAlert, Clock3, RefreshCw, ShieldCheck, ShieldOff, Wrench, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import './BobToolGovernancePage.css';
import './BobToolGovernanceActions.css';

interface Tool { tool_key: string; display_name: string; description: string; http_method: string; auth_mode: string; risk_level: string; requires_approval: boolean; enabled: boolean; updated_at: string; }
interface Policy { tool_key: string; enabled: boolean; requires_approval_override: boolean | null; }
interface Approval { id: string; request_id: string; tool_execution_id: string; approval_scope: string; status: string; proposed_action: { tool_key: string; input_fields: string[] }; created_at: string; expires_at: string | null; }
interface Execution { id: string; request_id: string; tool_key: string; decision_reason: string; ok: boolean; http_status: number | null; latency_ms: number | null; error_code: string | null; created_at: string; }
interface Overview { tools: Tool[]; policies: Policy[]; approvals: Approval[]; executions: Execution[]; }

async function invoke(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke('bob-tool-governance', { body });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

export default function BobToolGovernancePage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true); setError(null);
      setOverview(await invoke({ action: 'overview' }) as Overview);
    } catch {
      setError('Tool governance is unavailable. Confirm your administrator access and retry.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const setPolicy = async (tool: Tool, enabled: boolean, override: boolean | null) => {
    try {
      setSaving(tool.tool_key); setError(null);
      await invoke({ action: 'set-policy', toolKey: tool.tool_key, enabled, requiresApprovalOverride: override });
      await load();
    } catch { setError(`Policy for ${tool.display_name} could not be saved.`); }
    finally { setSaving(null); }
  };
  const decide = async (approval: Approval, decision: 'approved' | 'rejected') => {
    try { setSaving(approval.id); setError(null); await invoke({ action: 'decide-approval', approvalId: approval.id, decision }); await load(); }
    catch { setError('Approval decision could not be saved.'); }
    finally { setSaving(null); }
  };
  const requestApproval = async (tool: Tool) => {
    try { setSaving(tool.tool_key); setError(null); await invoke({ action: 'request-approval', toolKey: tool.tool_key, inputFields: [] }); await load(); }
    catch { setError(`Approval request for ${tool.display_name} could not be created.`); }
    finally { setSaving(null); }
  };
  const execute = async (approval: Approval) => {
    try {
      setSaving(approval.id); setError(null);
      const { data, error: executeError } = await supabase.functions.invoke('bob-tool-executor', { body: { approvalId: approval.id } });
      if (executeError || data?.ok !== true) throw new Error('Execution failed');
      await load();
    } catch { setError(`Approved ${approval.proposed_action.tool_key} request could not be executed.`); }
    finally { setSaving(null); }
  };
  const policyByKey = new Map((overview?.policies ?? []).map(policy => [policy.tool_key, policy]));

  return <div className="bob-governance">
    <header className="bob-governance-header"><div><span>Bob control plane</span><h1>Tool Governance</h1><p>Tenant tool policy, approval decisions, and bounded execution evidence.</p></div><button type="button" onClick={() => void load()} disabled={loading}><RefreshCw size={16} className={loading ? 'is-spinning' : ''} />Refresh</button></header>
    {error && <div className="bob-governance-alert" role="alert"><CircleAlert size={18} />{error}</div>}
    <section className="bob-governance-summary"><Summary icon={Wrench} value={loading ? '...' : String(overview?.tools.length ?? 0)} label="Registered tools" /><Summary icon={Clock3} value={loading ? '...' : String(overview?.approvals.length ?? 0)} label="Pending approvals" urgent={(overview?.approvals.length ?? 0) > 0} /><Summary icon={ShieldCheck} value={loading ? '...' : String((overview?.executions ?? []).filter(item => item.ok).length)} label="Recent confirmed runs" /></section>
    <section className="bob-governance-surface"><div className="bob-governance-title"><div><span>Tenant allowlist</span><h2>Available tools</h2></div><small>Execution remains controlled by Bob's server-side runtime.</small></div><div className="bob-tool-list">{!loading && overview?.tools.length === 0 && <div className="bob-governance-empty">No registered tools are available to this tenant.</div>}{overview?.tools.map(tool => { const policy = policyByKey.get(tool.tool_key); const enabled = policy?.enabled ?? tool.enabled; const requiresApproval = policy?.requires_approval_override ?? tool.requires_approval; const canRequireApproval = ['write', 'destructive', 'deploy', 'secret'].includes(tool.risk_level); return <article key={tool.tool_key}><div className={`bob-tool-risk risk-${tool.risk_level}`}>{tool.risk_level}</div><div className="bob-tool-detail"><strong>{tool.display_name}</strong><p>{tool.description}</p><small>{tool.http_method} · {tool.auth_mode} · {canRequireApproval ? requiresApproval ? 'Approval required' : 'No additional approval' : 'Read-only'}</small></div><label className="bob-tool-toggle"><input type="checkbox" checked={enabled} disabled={saving === tool.tool_key} onChange={event => void setPolicy(tool, event.target.checked, requiresApproval)} /><span>{enabled ? 'Enabled' : 'Disabled'}</span></label>{enabled && canRequireApproval && <button type="button" className="bob-approval-toggle" disabled={saving === tool.tool_key} onClick={() => void setPolicy(tool, enabled, !requiresApproval)}>{requiresApproval ? 'Require approval' : 'Direct execution'}</button>}{enabled && canRequireApproval && requiresApproval && <button type="button" className="bob-request-approval" disabled={saving === tool.tool_key} onClick={() => void requestApproval(tool)}>Request approval</button>}</article>; })}</div></section>
    <div className="bob-governance-grid"><section className="bob-governance-surface"><div className="bob-governance-title"><div><span>Human gate</span><h2>Approval queue</h2></div><ShieldOff size={19} /></div><div className="bob-approval-list">{!loading && overview?.approvals.length === 0 && <div className="bob-governance-empty">No action is waiting for approval or execution.</div>}{overview?.approvals.map(approval => <article key={approval.id}><div><strong>{approval.proposed_action.tool_key} · {approval.approval_scope} action</strong><small>Inputs: {approval.proposed_action.input_fields.length ? approval.proposed_action.input_fields.join(', ') : 'none'} · Requested {new Date(approval.created_at).toLocaleString('en-NZ')}{approval.expires_at ? ` · expires ${new Date(approval.expires_at).toLocaleString('en-NZ')}` : ''}</small></div><div>{approval.status === 'pending' ? <><button type="button" className="bob-reject" disabled={saving === approval.id} onClick={() => void decide(approval, 'rejected')} title="Reject action"><X size={16} /></button><button type="button" className="bob-approve" disabled={saving === approval.id} onClick={() => void decide(approval, 'approved')} title="Approve action"><Check size={16} /></button></> : <button type="button" className="bob-execute" disabled={saving === approval.id} onClick={() => void execute(approval)}>Execute approved</button>}</div></article>)}</div></section><section className="bob-governance-surface"><div className="bob-governance-title"><div><span>Evidence ledger</span><h2>Recent execution decisions</h2></div><small>Last 30</small></div><div className="bob-execution-list">{!loading && overview?.executions.length === 0 && <div className="bob-governance-empty">No tool execution evidence is available yet.</div>}{overview?.executions.map(execution => <article key={execution.id}><span className={execution.ok ? 'is-ok' : 'is-failed'}></span><div><strong>{execution.tool_key}</strong><small>{execution.decision_reason} · {new Date(execution.created_at).toLocaleString('en-NZ')}</small></div><em>{execution.ok ? `${execution.latency_ms ?? 0}ms` : execution.error_code ?? 'Not confirmed'}</em></article>)}</div></section></div>
  </div>;
}
function Summary({ icon: Icon, value, label, urgent = false }: { icon: typeof Wrench; value: string; label: string; urgent?: boolean }) { return <div className={urgent ? 'is-urgent' : ''}><Icon size={18} /><span><small>{label}</small><strong>{value}</strong></span></div>; }