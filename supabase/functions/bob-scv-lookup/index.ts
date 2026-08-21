/**
 * bob-scv-lookup — Bob's live SCV register lookup tool (READ-ONLY)
 *
 * POST /functions/v1/bob-scv-lookup
 * Body: { plate: string }
 *
 * Bob's canonical SCV source is the `canonical_scv` table (CSV-imported), read
 * FIRST by the scan pipeline + calculate_vehicle_compliance. This tool is the
 * FALLBACK Bob can choose when canonical_scv has no active certificate for a
 * plate: it checks the live NZSCV self-contained-vehicle register.
 *
 * Why a proxy hop: NZSCV is IP-whitelisted to the VPS static IP; Supabase edge
 * functions have dynamic IPs and CANNOT call NZSCV directly. So this function
 * calls the apps/api VPS route /api/nzscv/lookup (apps/api/nzscvProxy.ts), which
 * holds the PGDB credentials and calls NZSCV from the whitelisted IP.
 *
 * READ-ONLY BY DESIGN. It returns the register result for Bob to REASON over.
 * It does NOT write to canonical_scv — caching a result back into the canonical
 * (enforcement) table is a SEPARATE GOVERNED action (propose -> approve ->
 * execute), to be added once the exact NZSCV response shape is confirmed against
 * a real sample. We do not guess the field mapping into an enforcement table.
 *
 * Governance: JWT required; officer / admin_officer / admin / master /
 * grand_master (anyone who scans may check SCV). No write.
 *
 * Env:
 *   FCM_API_URL    — apps/api base URL (e.g. https://api.fcmanager.co.nz), no trailing slash
 *   FCM_API_TOKEN  — shared apps/api bearer token (same one apps/api requireApiToken expects)
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const FCM_API_URL = (Deno.env.get('FCM_API_URL') ?? '').replace(/\/+$/, '');
const FCM_API_TOKEN = Deno.env.get('FCM_API_TOKEN') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const CAN_LOOKUP = [
  'grand_master',
  'master',
  'admin',
  'admin_officer',
  'officer'
];
const LOOKUP_TIMEOUT_MS = 14_000;
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
    const { data: { user: caller }, error: authErr } = await callerClient.auth.getUser();
    if (authErr || !caller) return json({
      error: 'Unauthorized'
    }, 401);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: profile } = await admin.from('user_profiles').select('role').eq('id', caller.id).single();
    if (!profile || !CAN_LOOKUP.includes(String(profile.role))) {
      return json({
        error: 'Forbidden: SCV lookup requires an officer or above'
      }, 403);
    }
    const body = await req.json().catch(()=>({}));
    const plate = String(body.plate ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').trim();
    if (!plate) return json({
      error: 'plate is required'
    }, 400);
    // First: report whether the plate already has an ACTIVE, unexpired canonical
    // certificate — so Bob knows whether the live register hop is even needed and
    // can reason about canonical-vs-live.
    const today = new Date().toISOString().slice(0, 10);
    const { data: canon } = await admin.from('canonical_scv').select('certificate_number, certificate_status, expiry_date, source, last_checked_at').eq('plate_number', plate).eq('certificate_status', 'active').or(`expiry_date.is.null,expiry_date.gte.${today}`).maybeSingle();
    const canonicalActive = canon ?? null;
    // If NZSCV is not configured, still return the canonical answer (honest about
    // the live path being unavailable) rather than pretending.
    if (!FCM_API_URL || !FCM_API_TOKEN) {
      return json({
        plate,
        canonical_active: canonicalActive,
        live_lookup: null,
        live_available: false,
        note: 'Live NZSCV lookup is not configured (FCM_API_URL/FCM_API_TOKEN unset); returned the canonical_scv result only.'
      });
    }
    // Call the apps/api VPS proxy, which calls NZSCV from the whitelisted IP.
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), LOOKUP_TIMEOUT_MS);
    let liveStatus = 0;
    let liveData = null;
    let liveError = null;
    try {
      const res = await fetch(`${FCM_API_URL}/api/nzscv/lookup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${FCM_API_TOKEN}`
        },
        body: JSON.stringify({
          plate
        }),
        signal: controller.signal
      });
      liveStatus = res.status;
      liveData = await res.json().catch(()=>({
          error: 'Non-JSON response from NZSCV proxy'
        }));
    } catch (e) {
      liveError = e instanceof Error ? e.message : String(e);
    } finally{
      clearTimeout(timer);
    }
    return json({
      plate,
      canonical_active: canonicalActive,
      live_available: true,
      live_status: liveStatus,
      live_lookup: liveData,
      live_error: liveError,
      // Deliberately NO write-back here. If Bob determines the live register shows
      // a valid certificate not in canonical_scv, the governed path is to PROPOSE
      // an upsert_scv_record action (once its response mapping is confirmed), which
      // a human approves — never a silent write to the enforcement table.
      note: 'Read-only. canonical_scv is the primary source; this is the live-register fallback. Any write-back to canonical_scv is a separate governed (propose->approve) action.'
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return json({
      error: 'Server error',
      details: msg
    }, 500);
  }
});
