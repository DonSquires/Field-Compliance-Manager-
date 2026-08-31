import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { isAdminTier, resolveEffectiveRole } from '../_shared/auth.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const APPROVAL_SCOPES = new Set(['write', 'destructive', 'deploy', 'secret']);

function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } }); }

function safeApproval(approval: Record<string, unknown>) {
  const proposed = approval.proposed_action && typeof approval.proposed_action === 'object' ? approval.proposed_action as Record<string, unknown> : {};
  const input = proposed.input && typeof proposed.input === 'object' ? proposed.input as Record<string, unknown> : {};
  return {
    id: approval.id,
    request_id: approval.request_id,
    tool_execution_id: approval.tool_execution_id,
    approval_scope: approval.approval_scope,
    status: approval.status,
    proposed_action: {
      tool_key: typeof proposed.tool_key === 'string' ? proposed.tool_key : 'unknown_tool',
      input_fields: Object.keys(input).filter(key => /^[a-zA-Z0-9_]{1,80}$/.test(key)).slice(0, 20),
    },
    created_at: approval.created_at,
    expires_at: approval.expires_at,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'Tool governance is unavailable' }, 503);
  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization) return json({ error: 'Unauthorized' }, 401);
  const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: userError } = await caller.auth.getUser();
  if (userError || !user) return json({ error: 'Unauthorized' }, 401);
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: profile } = await admin.from('user_profiles').select('organization_id, role, email').eq('id', user.id).maybeSingle();
  const role = resolveEffectiveRole(user.email ?? profile?.email, profile?.role);
  if (!profile || !profile.organization_id || !isAdminTier(role)) return json({ error: 'Forbidden' }, 403);
  const body = await req.json().catch(() => ({}));
  const action = typeof body.action === 'string' ? body.action : '';
  const organizationId = profile.organization_id;
  const audit = async (event: string, targetTable: string, targetId: string | null, metadata: Record<string, unknown> = {}) => {
    try {
      await admin.from('audit_log').insert({ organization_id: organizationId, actor_user_id: user.id, action: event, target_table: targetTable, target_id: targetId, metadata });
    } catch {
      // Governance mutations stay truthful even if the secondary audit write is unavailable.
    }
  };

  if (action === 'diagnostics') {
    const probes = await Promise.all([
      admin.from('bob_tool_registry').select('tool_key', { count: 'exact', head: true }).eq('enabled', true).is('retired_at', null),
      admin.from('bob_tool_tenant_policy').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId),
      admin.from('bob_action_approvals').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      admin.from('bob_tool_executions').select('id', { count: 'exact', head: true }),
    ]);
    const labels = ['registry', 'policy', 'approvals', 'executions'];
    return json({ checks: Object.fromEntries(probes.map((probe, index) => [labels[index], { ok: !probe.error, count: probe.count ?? 0 }])) });
  }

  if (action === 'overview') {
    try {
      const tools = await admin.from('bob_tool_registry').select('tool_key, display_name, description, http_method, auth_mode, risk_level, requires_approval, enabled, updated_at').eq('enabled', true).is('retired_at', null).order('display_name');
      if (tools.error) return json({ error: 'Tool registry is unavailable' }, 503);
      const policies = await admin.from('bob_tool_tenant_policy').select('id, tool_key, enabled, requires_approval_override, created_at').eq('organization_id', organizationId);
      if (policies.error) return json({ error: 'Tool policy is unavailable' }, 503);
      const approvals = await admin.from('bob_action_approvals').select('id, request_id, tool_execution_id, approval_scope, status, proposed_action, created_at, expires_at').in('status', ['pending', 'approved']).order('created_at', { ascending: false }).limit(50);
      if (approvals.error) return json({ error: 'Approval queue is unavailable' }, 503);
      const executions = await admin.from('bob_tool_executions').select('id, request_id, tool_key, decision_reason, ok, http_status, latency_ms, error_code, created_at').order('created_at', { ascending: false }).limit(30);
      if (executions.error) return json({ error: 'Execution evidence is unavailable' }, 503);
      const executionById = new Map((executions.data ?? []).map(execution => [execution.id, execution]));
      const actionableApprovals = (approvals.data ?? []).filter(approval => approval.status === 'pending' || !executionById.get(approval.tool_execution_id)?.ok);
      return json({ tools: tools.data ?? [], policies: policies.data ?? [], approvals: actionableApprovals.map(safeApproval), executions: executions.data ?? [] });
    } catch {
      await audit('bob_tool_governance.overview_failed', 'bob_tool_registry', null);
      return json({ error: 'Tool governance overview is temporarily unavailable' }, 503);
    }
  }

  if (action === 'set-policy') {
    const toolKey = typeof body.toolKey === 'string' ? body.toolKey.trim() : '';
    if (!toolKey || typeof body.enabled !== 'boolean') return json({ error: 'toolKey and enabled are required' }, 400);
    const requiresApprovalOverride = typeof body.requiresApprovalOverride === 'boolean' ? body.requiresApprovalOverride : null;
    const { data: tool } = await admin.from('bob_tool_registry').select('tool_key, risk_level').eq('tool_key', toolKey).eq('enabled', true).is('retired_at', null).maybeSingle();
    if (!tool) return json({ error: 'Tool is unavailable' }, 404);
    if (requiresApprovalOverride === true && !APPROVAL_SCOPES.has(tool.risk_level)) return json({ error: 'Read-only tools cannot require action approval' }, 400);
    const { data: policy, error } = await admin.from('bob_tool_tenant_policy').upsert({ organization_id: organizationId, tool_key: toolKey, enabled: body.enabled, requires_approval_override: requiresApprovalOverride }, { onConflict: 'organization_id,tool_key' }).select('id').single();
    if (error) return json({ error: 'Policy could not be saved' }, 503);
    void audit('bob_tool_governance.policy_saved', 'bob_tool_tenant_policy', policy?.id ?? null, { tool_key: toolKey, enabled: body.enabled, requires_approval_override: requiresApprovalOverride });
    return json({ ok: true });
  }

  if (action === 'request-approval') {
    const toolKey = typeof body.toolKey === 'string' ? body.toolKey.trim() : '';
    const inputFields = Array.isArray(body.inputFields)
      ? [...new Set(body.inputFields.filter((field): field is string => typeof field === 'string' && /^[a-zA-Z0-9_]{1,80}$/.test(field)))].slice(0, 20)
      : [];
    if (!toolKey) return json({ error: 'toolKey is required' }, 400);
    const { data: tool } = await admin.from('bob_tool_registry').select('tool_key, risk_level, requires_approval').eq('tool_key', toolKey).eq('enabled', true).is('retired_at', null).maybeSingle();
    if (!tool) return json({ error: 'Tool is unavailable' }, 404);
    const { data: policy } = await admin.from('bob_tool_tenant_policy').select('enabled, requires_approval_override').eq('organization_id', organizationId).eq('tool_key', toolKey).maybeSingle();
    if (policy?.enabled === false) return json({ error: 'Tool is disabled by tenant policy' }, 409);
    const requiresApproval = policy?.requires_approval_override ?? tool.requires_approval;
    if (!requiresApproval || !APPROVAL_SCOPES.has(tool.risk_level)) return json({ error: 'Tool does not support approval requests' }, 409);
    const requestId = crypto.randomUUID();
    const conversationId = `governance-${requestId}`;
    const { data: execution, error: executionError } = await admin.from('bob_tool_executions').insert({ conversation_id: conversationId, request_id: requestId, step_index: 0, tool_key: toolKey, decision_reason: 'manual_governance_approval_request', input_payload: { input_fields: inputFields }, ok: false, retryable: false }).select('id').single();
    if (executionError || !execution) return json({ error: 'Execution evidence could not be created' }, 503);
    const { data: approval, error: approvalError } = await admin.from('bob_action_approvals').insert({ conversation_id: conversationId, request_id: requestId, tool_execution_id: execution.id, approval_scope: tool.risk_level, status: 'pending', proposed_action: { tool_key: toolKey, organization_id: organizationId, input: Object.fromEntries(inputFields.map(field => [field, '[operator supplied]'])) }, expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString() }).select('id').single();
    if (approvalError || !approval) return json({ error: 'Approval record could not be created' }, 503);
    void audit('bob_tool_governance.approval_requested', 'bob_action_approvals', approval.id, { tool_key: toolKey, input_fields: inputFields });
    return json({ ok: true, approvalId: approval.id });
  }

  if (action === 'decide-approval') {
    const approvalId = typeof body.approvalId === 'string' ? body.approvalId : '';
    const decision = body.decision === 'approved' || body.decision === 'rejected' ? body.decision : '';
    if (!approvalId || !decision) return json({ error: 'approvalId and decision are required' }, 400);
    const update = decision === 'approved' ? { status: decision, approved_by: user.id, approved_at: new Date().toISOString() } : { status: decision, rejected_by: user.id, rejected_at: new Date().toISOString() };
    const { data, error } = await admin.from('bob_action_approvals').update(update).eq('id', approvalId).eq('status', 'pending').select('id, approval_scope').maybeSingle();
    if (error || !data || !APPROVAL_SCOPES.has(data.approval_scope)) return json({ error: 'Approval is unavailable' }, 409);
    void audit(`bob_tool_governance.approval_${decision}`, 'bob_action_approvals', data.id, { approval_scope: data.approval_scope });
    return json({ ok: true, status: decision });
  }
  return json({ error: 'Unsupported governance action' }, 400);
});