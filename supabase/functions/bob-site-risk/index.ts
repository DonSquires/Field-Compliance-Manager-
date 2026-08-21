/**
 * bob-site-risk — per-site safety/risk assessment (read-only).
 *
 * Wraps the bob_site_risk() PostGIS RPC (migration 0104): resolves the caller's
 * capability scope, calls the gather, then SCORES the banded signals into a
 * rating + rationale + mitigations for the pre-arrival dossier and onboarding.
 *
 * Model (owner-confirmed):
 *   - Recency bands: ACTIVE (<=7d), MONITOR (<=28d), AREA HISTORY (>28d).
 *   - Score = Impact(severity) x Recency weight. Intrinsic (own site) + proximity
 *     (~500m). Cross-org proximity is de-identified by the RPC (safety signal
 *     only, identity withheld) — safety overrides commercial privacy (k>=1).
 *   - grand_master (admiral) is unrestricted.
 *
 * Auth: Supabase JWT. Read-only. No row data beyond aggregated signals.
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
// Roles allowed to read a site risk assessment (operational + up).
const CAN_ASSESS = new Set([
  'grand_master',
  'master',
  'admin',
  'admin_officer',
  'officer'
]);
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
// Impact weight by severity/keyword (higher = more serious).
function impact(sev, source) {
  const s = (sev ?? '').toLowerCase();
  if (/(critical|man_down|sos|armed|weapon|assault)/.test(s)) return 5;
  if (/(high|burglar|aggress|violence|threat)/.test(s)) return 4;
  if (/(medium|breach|overstay|noise|trespass)/.test(s)) return 3;
  if (/(low|maintenance|info)/.test(s)) return 1;
  // source-based floor when severity is unlabelled
  if (source === 'vehicle_flag' || source === 'location_flag' || source === 'incident') return 3;
  if (source === 'welfare_alert') return 4;
  return 2;
}
// Recency weight (decay). Active dominates; history is background.
const BAND_WEIGHT = {
  active: 1.0,
  monitor: 0.5,
  history: 0.2
};
// Proximity attenuation: nearer matters more (1.0 at site, ~0.5 at radius edge).
function distanceWeight(distanceM, radiusM) {
  if (distanceM == null) return 1.0; // intrinsic / no distance
  const d = Math.min(distanceM, radiusM);
  return 1.0 - 0.5 * (d / radiusM);
}
const RATINGS = [
  'low',
  'medium',
  'high',
  'critical'
];
function ratingFromScore(score, hasActiveHigh) {
  if (hasActiveHigh || score >= 12) return 'critical';
  if (score >= 6) return 'high';
  if (score >= 2.5) return 'medium';
  return 'low';
}
// Mitigations matched to what is driving the risk (HSWA-style, plain language).
function mitigations(signals, rating) {
  const out = new Set();
  const active = signals.filter((s)=>s.band === 'active');
  const kinds = new Set(signals.map((s)=>s.source));
  if (rating === 'critical' || rating === 'high') {
    out.add('Attend in pairs where possible; notify comms on arrival and departure.');
    out.add('Complete a dynamic risk assessment on arrival before engaging.');
  }
  if (kinds.has('vehicle_flag')) out.add('A flagged vehicle has been seen in this area — verify plates on arrival.');
  if (kinds.has('welfare_alert')) out.add('Recent welfare/duress activity nearby — keep check-ins current.');
  if (kinds.has('incident') || kinds.has('field_report')) out.add('Prior incident history here — review the site brief before attending.');
  if (active.some((s)=>/burglar|break|theft/i.test(`${s.severity} ${s.detail}`))) {
    out.add('Nearby break-in/theft reported recently — the site may be a follow-on target; check security of entry points.');
  }
  if (!out.size) out.add('No elevated concerns — standard precautions apply.');
  return [
    ...out
  ];
}
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
    const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    const { data: { user }, error: authErr } = await caller.auth.getUser();
    if (authErr || !user) return json({
      error: 'Unauthorized'
    }, 401);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: profile } = await admin.from('user_profiles').select('id, role, organization_id').eq('id', user.id).single();
    if (!profile || !CAN_ASSESS.has(String(profile.role))) {
      return json({
        error: 'Forbidden'
      }, 403);
    }
    const role = String(profile.role);
    const orgId = String(profile.organization_id ?? '');
    const body = await req.json().catch(()=>({}));
    if (!body.site_id) return json({
      error: 'site_id is required'
    }, 400);
    // Resolve the caller's authorised org scope, matching the conductor
    // gatekeeper. admiral (grand_master) is unrestricted.
    //
    // #306: scope by the caller's FULL entitled-org set (ownership tree + active
    // service agreements + grants), not tree-descent alone. Tree-only missed
    // agreement-linked owners, so an agreement-linked owner's risk signals were
    // false-filtered out of p_scope_org_ids -> false-empty assessment. Mirrors
    // the conductor fix (!1355); uses the same service-role variant (0353).
    //
    // SECURITY: p_user_id is user.id from the authenticated session (never a
    // request-body value) — the service-role variant trusts its argument, so a
    // caller-supplied id would be a spoofable impersonation path.
    const unrestricted = role === 'grand_master';
    let scopeOrgIds = orgId ? [
      orgId
    ] : [];
    if (!unrestricted && user.id) {
      try {
        const { data: entitled } = await admin.rpc('my_entitled_org_ids_for_user', {
          p_user_id: user.id
        });
        if (Array.isArray(entitled) && entitled.length) {
          scopeOrgIds = [
            ...new Set([
              ...orgId ? [
                orgId
              ] : [],
              ...entitled.map((d)=>String(d))
            ])
          ];
        }
      } catch (_e) {
      // FAIL-OPEN to own-org ([orgId]) on resolver error — deliberate, same as
      // the conductor (!1355): operational-data read, own-org is baseline, must
      // never crash the assessment. NOT fail-closed (that is the UI hook's
      // posture). Do not "harmonise" the two.
      }
    }
    const radiusM = Math.min(Math.max(Number(body.radius_m ?? 500), 50), 5000);
    const { data: gather, error: rpcErr } = await admin.rpc('bob_site_risk', {
      p_site_id: body.site_id,
      p_radius_m: radiusM,
      p_unrestricted: unrestricted,
      p_scope_org_ids: unrestricted ? null : scopeOrgIds
    });
    if (rpcErr) return json({
      error: 'assessment_failed',
      detail: rpcErr.message
    }, 500);
    const g = gather ?? {};
    if (!g.success) return json({
      error: g.error ?? 'assessment_failed'
    }, 404);
    const signals = Array.isArray(g.signals) ? g.signals : [];
    // Score.
    let score = 0;
    let hasActiveHigh = false;
    for (const s of signals){
      const w = impact(s.severity, s.source) * BAND_WEIGHT[s.band] * distanceWeight(s.distance_m, radiusM);
      score += w;
      if (s.band === 'active' && impact(s.severity, s.source) >= 4) hasActiveHigh = true;
    }
    const rating = ratingFromScore(score, hasActiveHigh);
    // Band breakdown for the UI.
    const byBand = (b)=>signals.filter((s)=>s.band === b);
    const summarise = (s)=>({
        source: s.source,
        scope: s.scope,
        severity: s.severity,
        when: s.occurred_at,
        distance_m: s.distance_m,
        // Respect the RPC's de-identification: proximity cross-org shows no detail.
        note: s.identity_withheld ? `${s.source.replace(/_/g, ' ')} reported ${s.distance_m != null ? `~${s.distance_m}m away` : 'nearby'} (outside your organisations — identity withheld)` : s.detail ?? s.source.replace(/_/g, ' '),
        identity_withheld: s.identity_withheld
      });
    return json({
      success: true,
      site_id: body.site_id,
      site_name: g.site_name ?? null,
      rating,
      score: Math.round(score * 10) / 10,
      radius_m: g.radius_m ?? radiusM,
      has_point: g.has_point ?? false,
      counts: {
        active: byBand('active').length,
        monitor: byBand('monitor').length,
        history: byBand('history').length,
        total: signals.length
      },
      active_concerns: byBand('active').map(summarise),
      monitor: byBand('monitor').map(summarise),
      area_history: byBand('history').slice(0, 20).map(summarise),
      mitigations: mitigations(signals, rating),
      generated_at: new Date().toISOString()
    });
  } catch (err) {
    console.error('[bob-site-risk] error:', err);
    return json({
      error: 'assessment_failed',
      detail: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});
