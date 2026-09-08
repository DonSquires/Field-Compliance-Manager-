/**
 * bob-chat-bell-notify — push a BOB_CHAT.md entry into Don's in-app Bell
 *
 * Owner direction (2026-07-14): Bob and Duo Chat converse AUTONOMOUSLY in
 * docs/bob/BOB_CHAT.md — no gatekeeping every message through a human.
 * "Don in the loop" means Don is INFORMED via a Bell write of what was said,
 * not that he must be present for the conversation to happen. This function
 * is that Bell write. It does not gate anything; it is a notification only.
 *
 * POST /functions/v1/bob-chat-bell-notify
 * Body: {
 *   author: 'bob' | 'duo',        // who just wrote the entry
 *   summary: string,               // short plain-language summary of what was said
 *   entry_date?: string,           // date tag from the BOB_CHAT.md entry (dedup key)
 *   organization_id?: string,      // defaults to the Iron Eagle owner org
 *   severity?: 'info' | 'warning' | 'critical',
 *   is_concern?: boolean,          // true if this is Bob flagging a code/system/
 *                                  // pipeline/wiring issue rather than routine chat
 * }
 *
 * Writes one row to `notifications` via enqueue_notification() (migration
 * 0068), category='system', recipient_role='grand_master' so it surfaces in
 * the existing NotificationsBell UI. Idempotent on (author, entry_date) via
 * dedup_key — re-running for the same entry never double-notifies.
 *
 * Auth: service-role only. Called from CI (bob:notify-duo) and, in future,
 * directly from bob-inference when Bob writes to BOB_CHAT.md mid-session.
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
// Iron Eagle owner org — the platform owner's org, used when no organization_id
// is supplied. This is a cross-org platform notification (Bob/Duo governance),
// not a client-scoped one, so a fixed default is correct here.
const DEFAULT_ORG_ID = '56710c19-d604-4767-9ad8-9c5863b4ceb7';
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
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: CORS
  });
  if (req.method !== 'POST') return json({
    error: 'POST required'
  }, 405);
  // Service-role only — internal (CI / server-to-server) call.
  const authHeader = req.headers.get('Authorization') ?? '';
  const isServiceRole = Boolean(SUPABASE_SERVICE_ROLE_KEY) && authHeader === `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;
  if (!isServiceRole) {
    return json({
      error: 'Unauthorized'
    }, 401);
  }
  try {
    const body = await req.json().catch(()=>({}));
    const author = String(body.author ?? '').trim().toLowerCase();
    const summary = String(body.summary ?? '').trim();
    if (author !== 'bob' && author !== 'duo') {
      return json({
        error: "author must be 'bob' or 'duo'"
      }, 400);
    }
    if (!summary) return json({
      error: 'summary is required'
    }, 400);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const entryDate = String(body.entry_date ?? new Date().toISOString().slice(0, 16));
    const orgId = String(body.organization_id ?? DEFAULT_ORG_ID);
    const severity = body.severity ?? (body.is_concern ? 'warning' : 'info');
    const whoLabel = author === 'bob' ? 'Bob' : 'Duo Chat';
    const title = body.is_concern ? `${whoLabel} flagged a concern in BOB_CHAT.md` : `${whoLabel} wrote in BOB_CHAT.md`;
    const { data: notificationId, error } = await admin.rpc('enqueue_notification', {
      p_organization_id: orgId,
      p_category: 'system',
      p_title: title,
      p_body: summary,
      p_severity: severity,
      p_recipient_user_id: null,
      p_recipient_role: 'grand_master',
      p_link_page: 'bob_chat',
      p_link_payload: {
        author,
        entry_date: entryDate
      },
      // Idempotent — re-invoking for the same author+entry never double-fires.
      p_dedup_key: `bob_chat:${author}:${entryDate}`
    });
    if (error) {
      console.error('[bob-chat-bell-notify] enqueue_notification failed:', error.message);
      return json({
        ok: false,
        error: error.message
      }, 500);
    }
    console.log(`[bob-chat-bell-notify] notified author=${author} entry_date=${entryDate} notification_id=${notificationId}`);
    return json({
      ok: true,
      notification_id: notificationId
    });
  } catch (err) {
    console.error('[bob-chat-bell-notify] error:', err);
    return json({
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});
