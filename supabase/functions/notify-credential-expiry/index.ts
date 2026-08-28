/**
 * notify-credential-expiry — scheduled credential-expiry notification producer (4.2 / 4.4)
 *
 * POST /functions/v1/notify-credential-expiry
 * Body: {} (no input). Intended to be run daily (pg_cron + pg_net, or any
 *        scheduler hitting this endpoint with the service role / a cron secret).
 *
 * For every staff credential expiring within the alert windows, enqueues a
 * notification via enqueue_notification() with a per-threshold dedup_key so
 * each credential alerts at most once per window (30d / 14d / 7d / expired).
 *
 * Auth: service-role only. This is a backend/cron job, not a user action.
 *   - Accepts the platform service-role JWT (SUPABASE_SERVICE_ROLE_KEY), OR
 *   - a shared CRON_SECRET via the x-cron-secret header.
 *
 * Schema (verified live 2026-06-28): staff_credentials(id, staff_id,
 *   organization_id, credential_type, credential_number, expiry_date).
 *   NOTE the column is staff_id (NOT staff_profile_id).
 *
 * Notifications are role-broadcast to 'admin' per org, link_page
 * 'credential-expiry' (the CredentialExpiryPage).
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret'
};
// Alert windows in days-until-expiry. Each maps to a dedup threshold label.
const WINDOWS = [
  {
    maxDays: 0,
    label: 'expired',
    severity: 'critical'
  },
  {
    maxDays: 7,
    label: '7d',
    severity: 'critical'
  },
  {
    maxDays: 14,
    label: '14d',
    severity: 'warning'
  },
  {
    maxDays: 30,
    label: '30d',
    severity: 'info'
  }
];
function thresholdFor(days) {
  // Pick the tightest window the credential currently falls into.
  for (const w of WINDOWS){
    if (days <= w.maxDays) return {
      label: w.label,
      severity: w.severity
    };
  }
  return null;
}
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: CORS
  });
  const json = (body, status = 200)=>new Response(JSON.stringify(body), {
      status,
      headers: {
        ...CORS,
        'Content-Type': 'application/json'
      }
    });
  // Service-role / cron auth only.
  const authHeader = req.headers.get('Authorization') ?? '';
  const cronHeader = req.headers.get('x-cron-secret') ?? '';
  const isServiceRole = SUPABASE_SERVICE_ROLE_KEY && authHeader === `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;
  const isCron = CRON_SECRET && cronHeader === CRON_SECRET;
  if (!isServiceRole && !isCron) {
    return json({
      error: 'Unauthorized (service-role or x-cron-secret required)'
    }, 401);
  }
  try {
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const in30 = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data: creds, error } = await admin.from('staff_credentials').select('id, staff_id, organization_id, credential_type, credential_number, expiry_date, staff_profiles(display_name)').not('expiry_date', 'is', null).lte('expiry_date', in30);
    if (error) return json({
      error: 'Query failed',
      details: error.message
    }, 500);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let enqueued = 0;
    let skipped = 0;
    for (const c of creds ?? []){
      const expiry = new Date(String(c.expiry_date));
      const days = Math.round((expiry.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
      const t = thresholdFor(days);
      if (!t) {
        skipped += 1;
        continue;
      }
      const sp = c.staff_profiles;
      const who = sp?.display_name ?? 'A staff member';
      const credLabel = String(c.credential_type ?? 'credential').replace(/_/g, ' ');
      const title = t.label === 'expired' ? `Credential expired: ${credLabel}` : `Credential expiring (${t.label}): ${credLabel}`;
      const body = t.label === 'expired' ? `${who}'s ${credLabel} has expired (${String(c.expiry_date)}).` : `${who}'s ${credLabel} expires on ${String(c.expiry_date)} (${days} day${days === 1 ? '' : 's'}).`;
      const { error: rpcErr } = await admin.rpc('enqueue_notification', {
        p_organization_id: c.organization_id,
        p_category: 'credential_expiry',
        p_title: title,
        p_body: body,
        p_severity: t.severity,
        p_recipient_user_id: null,
        p_recipient_role: 'admin',
        p_link_page: 'credential-expiry',
        p_link_payload: {
          credential_id: c.id,
          staff_id: c.staff_id,
          expiry_date: c.expiry_date
        },
        p_dedup_key: `cred:${c.id}:${t.label}`
      });
      if (rpcErr) {
        skipped += 1;
        continue;
      }
      enqueued += 1;
    }
    return json({
      success: true,
      scanned: (creds ?? []).length,
      enqueued,
      skipped
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return json({
      error: 'Server error',
      details: msg
    }, 500);
  }
});
