/**
 * bob-self-memory-read -- Bob reads his own memory entries (bob_self_memory)
 *
 * POST /functions/v1/bob-self-memory-read
 * Body: { limit?: number, memory_type?: string, search?: string }
 *
 * Auth: admiral (grand_master) only.
 * Read: service-role SELECT from bob_self_memory.
 * Returns entries newest-first, up to limit (default 20, max 100).
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
const CAN_READ = new Set([
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
    const role = String(profile?.role ?? 'guest');
    const isOwner = OWNER_EMAILS.has((user.email ?? '').toLowerCase().trim());
    const effectiveRole = isOwner ? 'grand_master' : role;
    if (!CAN_READ.has(effectiveRole)) {
      return json({
        error: 'Forbidden: read_self_memory is admiral (grand_master) only'
      }, 403);
    }
    const body = await req.json();
    const limit = Math.min(Math.max(Number(body.limit ?? 20), 1), 100);
    const memoryType = String(body.memory_type ?? '').trim();
    const search = String(body.search ?? '').trim();
    let q = admin.from('bob_self_memory').select('id, content, memory_type, context, created_at, status').order('created_at', {
      ascending: false
    }).limit(limit);
    if (memoryType) q = q.eq('memory_type', memoryType);
    if (search) q = q.ilike('content', `%${search}%`);
    const { data, error } = await q;
    if (error) {
      console.error('[bob-self-memory-read] query error:', error.message);
      return json({
        error: 'Failed to read memories',
        detail: error.message
      }, 500);
    }
    return json({
      ok: true,
      count: (data ?? []).length,
      memories: data ?? []
    });
  } catch (err) {
    console.error('[bob-self-memory-read] error:', err);
    return json({
      error: 'Internal error'
    }, 500);
  }
});
