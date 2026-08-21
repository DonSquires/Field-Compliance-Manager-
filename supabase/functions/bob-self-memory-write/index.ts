/**
 * bob-self-memory-write -- Bob writes an entry to his own memory (bob_self_memory)
 *
 * POST /functions/v1/bob-self-memory-write
 * Body: { content: string, memory_type?: string, context?: string }
 *
 * Auth: admiral (grand_master) only -- same gate as write_bob_chat.
 * Write: service-role INSERT into bob_self_memory.
 * Immutable: no UPDATE path exists (0355 RLS).
 *
 * This is Bob's direct-write memory path, graduated in 0355.
 * No approval gate. No bell. His own, like Scotty's and Jim's files.
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { OWNER_EMAILS } from '../_shared/auth.ts';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const json = (body, status = 200)=>new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
const CAN_WRITE = new Set([
  'grand_master'
]);
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: CORS
  });
  if (req.method !== 'POST') return json({
    error: 'POST required'
  }, 405);
  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader) return json({
      error: 'Unauthorized'
    }, 401);
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    const { data: { user }, error: authErr } = await callerClient.auth.getUser();
    if (authErr || !user) return json({
      error: 'Unauthorized'
    }, 401);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: profile } = await admin.from('user_profiles').select('role').eq('id', user.id).single();
    // Admiral gate -- same as write_bob_chat.
    // Owner email elevation: if the caller is the platform owner, treat as grand_master.
    const role = String(profile?.role ?? 'guest');
    const isOwner = OWNER_EMAILS.has((user.email ?? '').toLowerCase().trim());
    const effectiveRole = isOwner ? 'grand_master' : role;
    if (!CAN_WRITE.has(effectiveRole)) {
      return json({
        error: 'Forbidden: write_self_memory is admiral (grand_master) only'
      }, 403);
    }
    const body = await req.json();
    const content = String(body.content ?? '').trim();
    if (!content) return json({
      error: 'content is required'
    }, 400);
    const memoryType = String(body.memory_type ?? 'observation').trim();
    const context = String(body.context ?? '').trim() || null;
    const { data, error } = await admin.from('bob_self_memory').insert({
      content,
      memory_type: memoryType,
      context,
      proposed_by: 'bob',
      status: 'kept'
    }).select('id, created_at').single();
    if (error) {
      console.error('[bob-self-memory-write] insert error:', error.message);
      return json({
        error: 'Failed to write memory',
        detail: error.message
      }, 500);
    }
    return json({
      ok: true,
      memory_id: data.id,
      created_at: data.created_at
    });
  } catch (err) {
    console.error('[bob-self-memory-write] error:', err);
    return json({
      error: 'Internal error'
    }, 500);
  }
});
