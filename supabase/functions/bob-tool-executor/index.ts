import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { isAdminTier, resolveEffectiveRole } from '../_shared/auth.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const BOB_SYNC_SHARED_SECRET = Deno.env.get('BOB_SYNC_SHARED_SECRET') ?? '';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const EXECUTABLE_TOOLS: Record<string, { functionName: string; scope: string }> = {
  gitea_sync: { functionName: 'bob-gitea-sync', scope: 'write' },
};

function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } }); }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY || !BOB_SYNC_SHARED_SECRET) return json({ error: 'Approved tool execution is unavailable' }, 503);
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
  const approvalId = typeof body.approvalId === 'string' ? body.approvalId : '';
  if (!approvalId) return json({ error: 'approvalId is required' }, 400);
  const { data: approval, error: approvalError } = await admin.from('bob_action_approvals').select('id, tool_execution_id, approval_scope, status, proposed_action, expires_at').eq('id', approvalId).maybeSingle();
  if (approvalError || !approval || approval.status !== 'approved' || !approval.expires_at || new Date(approval.expires_at).getTime() <= Date.now()) return json({ error: 'Approval is unavailable or expired' }, 409);
  const proposed = approval.proposed_action && typeof approval.proposed_action === 'object' ? approval.proposed_action as Record<string, unknown> : {};
  const toolKey = typeof proposed.tool_key === 'string' ? proposed.tool_key : '';
  const organizationId = typeof proposed.organization_id === 'string' ? proposed.organization_id : '';
  const executor = EXECUTABLE_TOOLS[toolKey];
  if (!organizationId || (role !== 'grand_master' && organizationId !== profile.organization_id) || !executor || approval.approval_scope !== executor.scope) return json({ error: 'Approval is not executable for this organization' }, 409);
  const { data: execution } = await admin.from('bob_tool_executions').select('id, tool_key, ok').eq('id', approval.tool_execution_id).maybeSingle();
  if (!execution || execution.tool_key !== toolKey || execution.ok) return json({ error: 'Execution is unavailable or already complete' }, 409);
  const startedAt = Date.now();
  const response = await fetch(`${SUPABASE_URL}/functions/v1/${executor.functionName}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-bob-sync-secret': BOB_SYNC_SHARED_SECRET } });
  const result = await response.json().catch(() => ({}));
  const ok = response.ok && result?.ok === true;
  await admin.from('bob_tool_executions').update({ ok, http_status: response.status, latency_ms: Date.now() - startedAt, output_payload: { code: typeof result?.code === 'string' ? result.code : null }, error_code: ok ? null : typeof result?.code === 'string' ? result.code : 'execution_failed', error_message: ok ? null : 'Approved tool execution did not complete' }).eq('id', execution.id);
  return json({ ok, status: response.status, code: typeof result?.code === 'string' ? result.code : null }, ok ? 200 : 502);
});