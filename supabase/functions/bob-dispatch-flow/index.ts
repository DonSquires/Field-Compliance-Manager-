/**
 * Admiral-only Builder dispatch. The existing flow/goal/brief request and
 * workflow_id/workflow_url receipt remain compatible with the chat conductor.
 * Supabase owns job state; the control plane owns GitHub workspaces and PRs.
 * A dispatch receipt is not a commit, PR, merge or deployment receipt.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveEffectiveRole } from '../_shared/auth.ts';
import { dispatchBuilder } from './dispatch.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CONTROL_PLANE_URL = (Deno.env.get('BOB_CONTROL_PLANE_URL') ?? Deno.env.get('FCM_API_URL') ?? '').replace(/\/+$/, '');
const CONTROL_PLANE_TOKEN = Deno.env.get('BOB_ADMIN_TOKEN') ?? Deno.env.get('FCM_API_TOKEN') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader) return json({ error: 'Unauthorized' }, 401);
    const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: authError } = await caller.auth.getUser();
    if (authError || !user) return json({ error: 'Unauthorized' }, 401);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: profile } = await admin.from('user_profiles').select('role').eq('id', user.id).single();
    if (resolveEffectiveRole(user.email, String(profile?.role ?? 'guest')) !== 'grand_master') {
      return json({ ok: false, error: 'dispatch_flow is restricted to admiral (grand_master) only.', workflow_id: null, workflow_url: null }, 403);
    }
    const body = await req.json().catch(() => ({}));
    const result = await dispatchBuilder(admin, body, user.id, {
      configured: Boolean(CONTROL_PLANE_URL && CONTROL_PLANE_TOKEN),
      async request(path, payload) {
        return await fetch(`${CONTROL_PLANE_URL}${path}`, {
          method: payload === undefined ? 'GET' : 'POST',
          headers: { Authorization: `Bearer ${CONTROL_PLANE_TOKEN}`, 'Content-Type': 'application/json' },
          body: payload === undefined ? undefined : JSON.stringify(payload),
          signal: AbortSignal.timeout(45000),
        });
      },
    });
    return json(result.body, result.status);
  } catch (error) {
    console.error('[bob-dispatch-flow]', error instanceof Error ? error.message : 'Dispatch failed');
    return json({ ok: false, error: 'Internal error in bob-dispatch-flow', workflow_id: null, workflow_url: null }, 500);
  }
});
