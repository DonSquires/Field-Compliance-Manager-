/**
 * motoweb-vehicle-lookup — NZ vehicle compliance lookup (rego/WoF/CoF)
 *
 * POST /functions/v1/motoweb-vehicle-lookup
 * Body: { plate: string }
 *
 * Checks NZ vehicle registration, Warrant of Fitness, and Certificate of
 * Fitness status via the MotoWeb API, proxied through the VPS (same pattern
 * as bob-scv-lookup). The VPS holds the MotoWeb credentials and calls the
 * API from the whitelisted IP.
 *
 * Returns: { rego_expiry, rego_status, wof_expiry, wof_status, cof_expiry,
 *            cof_status, make, model, year, colour }
 *
 * Non-blocking: if the VPS call fails, returns unknown statuses so the
 * caller can continue without vehicle compliance data.
 *
 * Caches result back to canonical_vehicles (upsert by plate_number) with
 * compliance_checked_at = now(), compliance_source = 'motoweb'.
 *
 * Governance: JWT required; officer / admin_officer / admin / master /
 * grand_master (same role list as bob-scv-lookup).
 *
 * Env:
 *   FCM_API_URL    — apps/api base URL (e.g. https://api.fcmanager.co.nz), no trailing slash
 *   FCM_API_TOKEN  — shared apps/api bearer token
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient as _createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const createClient = (url, key, opts)=>_createClient(url, key, opts);
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
    // Service-role calls (from process-officer-scan) bypass user auth check.
    // Exact match against the full bearer header (same pattern as bob-plan-import
    // / bob-upsert-entity / bob-upsert-generic) — NOT authHeader.includes(...),
    // which would be true for ANY non-empty header if SUPABASE_SERVICE_ROLE_KEY
    // were ever unset (empty string is a substring of every string).
    const isServiceRole = Boolean(SUPABASE_SERVICE_ROLE_KEY) && authHeader === `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;
    if (!isServiceRole) {
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
          error: 'Forbidden: vehicle lookup requires an officer or above'
        }, 403);
      }
    }
    const body = await req.json().catch(()=>({}));
    const plate = String(body.plate ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').trim();
    if (!plate) return json({
      error: 'plate is required'
    }, 400);
    // If MotoWeb is not configured, return unknown statuses
    if (!FCM_API_URL || !FCM_API_TOKEN) {
      return json({
        plate,
        rego_status: 'unknown',
        rego_expiry: null,
        wof_status: 'unknown',
        wof_expiry: null,
        cof_status: 'unknown',
        cof_expiry: null,
        make: null,
        model: null,
        year: null,
        colour: null,
        error: 'lookup_unavailable',
        note: 'MotoWeb lookup is not configured (FCM_API_URL/FCM_API_TOKEN unset).'
      });
    }
    // Call the apps/api VPS proxy, which calls MotoWeb from the whitelisted IP.
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), LOOKUP_TIMEOUT_MS);
    let liveData = null;
    let liveError = null;
    try {
      const res = await fetch(`${FCM_API_URL}/api/motoweb/lookup`, {
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
      if (res.ok) {
        liveData = await res.json().catch(()=>null);
      } else {
        liveError = `HTTP ${res.status}`;
      }
    } catch (e) {
      liveError = e instanceof Error ? e.message : String(e);
    } finally{
      clearTimeout(timer);
    }
    // If VPS call failed, return unknown statuses (non-blocking)
    if (!liveData || liveError) {
      return json({
        plate,
        rego_status: 'unknown',
        rego_expiry: null,
        wof_status: 'unknown',
        wof_expiry: null,
        cof_status: 'unknown',
        cof_expiry: null,
        make: null,
        model: null,
        year: null,
        colour: null,
        error: 'lookup_unavailable',
        live_error: liveError
      });
    }
    // Extract fields from VPS response
    const regoExpiry = liveData.rego_expiry ?? null;
    const regoStatus = liveData.rego_status ?? 'unknown';
    const wofExpiry = liveData.wof_expiry ?? null;
    const wofStatus = liveData.wof_status ?? 'unknown';
    const cofExpiry = liveData.cof_expiry ?? null;
    const cofStatus = liveData.cof_status ?? 'unknown';
    const make = liveData.make ?? null;
    const model = liveData.model ?? null;
    const year = liveData.year ?? null;
    const colour = liveData.colour ?? null;
    // Cache result back to canonical_vehicles (upsert by plate_number)
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await adminClient.from('canonical_vehicles').upsert({
      plate_number: plate,
      rego_expiry: regoExpiry,
      rego_status: regoStatus,
      wof_expiry: wofExpiry,
      wof_status: wofStatus,
      cof_expiry: cofExpiry,
      cof_status: cofStatus,
      compliance_checked_at: new Date().toISOString(),
      compliance_source: 'motoweb',
      ...make ? {
        make
      } : {},
      ...model ? {
        model
      } : {},
      ...year ? {
        year
      } : {},
      ...colour ? {
        colour
      } : {}
    }, {
      onConflict: 'plate_number'
    });
    return json({
      plate,
      rego_status: regoStatus,
      rego_expiry: regoExpiry,
      wof_status: wofStatus,
      wof_expiry: wofExpiry,
      cof_status: cofStatus,
      cof_expiry: cofExpiry,
      make,
      model,
      year,
      colour
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return json({
      error: 'Server error',
      details: msg
    }, 500);
  }
});
