/**
 * deactivate-user — Deactivate or reactivate a user
 *
 * Request body:
 * {
 *   user_id: string,
 *   action: 'deactivate' | 'reactivate',
 *   reason?: string
 * }
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return json({ error: 'Missing authorization header' }, 401);
    }

    const userClient = createClient(supabaseUrl, supabaseServiceKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return json({ error: 'Unauthorized' }, 401);
    }

    let payload: { user_id?: unknown; action?: unknown; reason?: unknown };
    try {
      payload = await req.json();
    } catch {
      return json({ error: 'Request body must be valid JSON' }, 400);
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return json({ error: 'Request body must be a JSON object' }, 400);
    }

    const { user_id, action, reason } = payload;
    if (typeof user_id !== 'string' || typeof action !== 'string') {
      return json({ error: 'user_id and action are required' }, 400);
    }
    if (action !== 'deactivate' && action !== 'reactivate') {
      return json({ error: 'action must be "deactivate" or "reactivate"' }, 400);
    }
    if (reason !== undefined && typeof reason !== 'string') {
      return json({ error: 'reason must be a string' }, 400);
    }

    const { data: deactivatedAt, error: actionError } = await userClient.rpc('set_user_deactivation', {
      p_target_user_id: user_id,
      p_action: action,
      p_reason: reason ?? null,
    });
    if (actionError) {
      console.error('Failed to apply user deactivation:', actionError);
      return json({ error: 'User access change failed', details: actionError.message }, 400);
    }

    return json({
      success: true,
      user_id,
      action,
      deactivated_at: deactivatedAt,
    });
  } catch (err) {
    console.error('Unexpected error:', err);
    return json({
      error: 'Internal server error',
      details: err instanceof Error ? err.message : String(err),
    }, 500);
  }
});
