/**
 * bob-triage-report -- the dedicated friction-triage organ.
 *
 * Receives a friction report + bounded evidence envelope (design section 2a),
 * classifies it, and returns a triage verdict + routing decision. This is the
 * INTAKE/CLASSIFICATION organ -- it does NOT orchestrate, govern, or execute.
 * The conductor and the human stay distinct (design section 7a invariant:
 * classifier != governor).
 *
 * Auth: Supabase JWT required. org_id/user_id/role resolved server-side.
 * Mirrors bob-perceive-image auth pattern.
 *
 * Design: docs/bob/BOB_FRICTION_TRIAGE_DESIGN.md
 * Plan:   docs/proposals/BOB_TRIAGE_REPORT_PLAN.md
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { validateAndRedactEnvelope, screenStopLines, classifyByRules, classifyByModel, deriveRoute, classifyRepairRisk, SUPPORTED_SCHEMA_VERSIONS } from './triage-logic.ts';
// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
// ---------------------------------------------------------------------------
// Role gate: who may file a friction report
// ---------------------------------------------------------------------------
const CAN_REPORT = new Set([
  'grand_master',
  'master',
  'admin',
  'admin_officer',
  'officer'
]);
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: CORS
  });
  if (req.method !== 'POST') return json({
    error: 'POST required'
  }, 405);
  try {
    // ── 1. Auth + scope gate (section 2g, mirrors bob-perceive-image) ──
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader) return json({
      error: 'Unauthorized: missing JWT'
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
      error: 'Unauthorized: invalid or expired JWT'
    }, 401);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    // Resolve profile: role + organization_id
    const { data: profile } = await admin.from('user_profiles').select('id, role, organization_id, deactivated_at').eq('id', user.id).single();
    if (!profile || profile.deactivated_at || !profile.organization_id) return json({
      error: 'Forbidden: unknown user'
    }, 403);
    if (!CAN_REPORT.has(String(profile.role))) {
      return json({
        error: 'Forbidden: insufficient role for friction reporting'
      }, 403);
    }
    const orgId = profile.organization_id;
    const userId = profile.id;
    // ── 2. Parse request body ──
    let body;
    try {
      body = await req.json();
    } catch  {
      return json({
        error: 'Invalid JSON body'
      }, 400);
    }
    const rawEnvelope = body.envelope;
    const clientPacketKey = body.client_packet_key;
    if (!clientPacketKey || typeof clientPacketKey !== 'string') {
      return json({
        error: 'client_packet_key is required (string)'
      }, 400);
    }
    if (!rawEnvelope || typeof rawEnvelope !== 'object' || Array.isArray(rawEnvelope)) {
      return json({
        error: 'envelope is required (object)'
      }, 400);
    }
    const envelopeInput = rawEnvelope;
    // ── 3. Idempotency check FIRST (section 2e) — before any branching on
    // schema version, so a retry of ANY envelope (supported or not) returns the
    // existing packet instead of double-persisting or re-classifying. ──
    const { data: existingPacket } = await admin.from('bob_friction_packets').select('id, triage, basis, confidence, route, stop_line_hit, truth_state, redaction, repair_risk, automation_status, builder_job_id').eq('organization_id', orgId).eq('user_id', userId).eq('client_packet_key', clientPacketKey).maybeSingle();
    if (existingPacket) {
      // Return existing verdict, no re-classify, no duplicate persist
      return json({
        triage: existingPacket.triage,
        basis: existingPacket.basis,
        confidence: existingPacket.confidence,
        route: existingPacket.route,
        stop_line_hit: existingPacket.stop_line_hit,
        truth_state: existingPacket.truth_state,
        packet_id: existingPacket.id,
        redaction: existingPacket.redaction,
        repair_risk: existingPacket.repair_risk,
        automation_status: existingPacket.automation_status,
        builder_job_id: existingPacket.builder_job_id
      });
    }
    // ── 4. Validate + redact envelope (section 2c, defence-in-depth) ──
    // Runs for EVERY envelope, including unsupported versions — the least-trusted
    // input path must never store an unredacted / unbounded envelope.
    const { envelope, redaction } = validateAndRedactEnvelope(envelopeInput);
    if (envelopeInput.during?.user_report) {
      if (!envelope.during?.user_report || String(envelope.during.user_report.desired_behavior ?? '').trim().length < 10) {
        return json({ error: 'Choose a request type and describe the desired behaviour in at least 10 characters.' }, 400);
      }
      envelope.before = { ...envelope.before, actor_role: profile.role };
    }
    // ── 5. Schema version check (section 2c) — AFTER redaction + idempotency ──
    const schemaVersion = String(envelopeInput.schema_version ?? '');
    if (!SUPPORTED_SCHEMA_VERSIONS.has(schemaVersion)) {
      // Fail-closed: unsupported version -> unknown + bell. Persist the REDACTED
      // envelope (never the raw input) so the event is auditable without storing
      // out-of-contract data. Check the insert result like the main path.
      const packetId = crypto.randomUUID();
      const repairRisk = 'protected';
      const automationStatus = 'awaiting_grandmaster';
      const verdict = {
        triage: 'unknown',
        basis: {
          reason_codes: [
            'unsupported_envelope_version'
          ],
          summary: 'Envelope schema_version "' + schemaVersion + '" is not supported. Fail-closed.'
        },
        confidence: null,
        route: 'grand_master_bell',
        stop_line_hit: null,
        truth_state: 'inferred',
        packet_id: packetId,
        redaction,
        repair_risk: repairRisk,
        automation_status: automationStatus,
        builder_job_id: null
      };
      const { error: unsupInsertErr } = await admin.from('bob_friction_packets').insert({
        id: packetId,
        organization_id: orgId,
        user_id: userId,
        client_packet_key: clientPacketKey,
        envelope,
        triage: verdict.triage,
        basis: verdict.basis,
        confidence: verdict.confidence,
        route: verdict.route,
        stop_line_hit: verdict.stop_line_hit,
        truth_state: verdict.truth_state,
        redaction: verdict.redaction,
        repair_risk: verdict.repair_risk,
        automation_status: verdict.automation_status
      });
      if (unsupInsertErr) {
        console.error('[bob-triage-report] persist error (unsupported version):', unsupInsertErr);
        return json({
          error: 'Failed to persist friction packet',
          detail: unsupInsertErr.message
        }, 500);
      }
      return json(verdict);
    }
    // ── 6. Stop-line screen FIRST (section 4a + section 2f invariant) ──
    const stopLine = screenStopLines(envelope);
    // ── 7. Classify ──
    let classification;
    if (stopLine.hit !== null) {
      // Stop-line hit: classify as the stop-line dictates
      classification = {
        triage: 'unknown',
        basis: {
          reason_codes: stopLine.reason_codes,
          summary: 'Stop-line hit: ' + stopLine.hit + '. Escalated to grand master bell.'
        },
        confidence: null
      };
    } else {
      // Rules-first classification
      const rulesResult = classifyByRules(envelope);
      if (rulesResult !== null) {
        classification = rulesResult;
      } else {
        // Model fallback (not yet wired -- fail-closed)
        classification = classifyByModel(envelope);
      }
    }
    // ── 8. Route by class (section 2a decision table) ──
    let route = deriveRoute(stopLine.hit, classification.triage, classification.confidence);
    // HARD INVARIANT (section 2f): stop_line_hit non-null => route is grand_master_bell.
    // deriveRoute enforces this; this guard FORCES it as defence-in-depth, so a
    // deriveRoute regression can never let a stop-line verdict carry a self-heal
    // or answer route. The comment and the code now do the same thing.
    if (stopLine.hit !== null && route !== 'grand_master_bell') {
      console.error('[bob-triage-report] INVARIANT VIOLATION: stop_line_hit set but route was ' + route + ' — forcing grand_master_bell');
      route = 'grand_master_bell';
    }
    const repairRisk = classifyRepairRisk(envelope, stopLine.hit, classification.triage, classification.confidence, route);
    const automationStatus = repairRisk === 'routine'
      ? 'queued'
      : repairRisk === 'significant' || repairRisk === 'protected'
        ? 'awaiting_grandmaster'
        : 'not_eligible';
    // ── 9. Build verdict ──
    const packetId = crypto.randomUUID();
    const verdict = {
      triage: classification.triage,
      basis: classification.basis,
      confidence: classification.confidence,
      route,
      stop_line_hit: stopLine.hit,
      truth_state: 'inferred',
      packet_id: packetId,
      redaction,
      repair_risk: repairRisk,
      automation_status: automationStatus,
      builder_job_id: null
    };
    // ── 10. Persist the packet (immutable envelope + outcome fields) ──
    const { error: insertErr } = await admin.from('bob_friction_packets').insert({
      id: packetId,
      organization_id: orgId,
      user_id: userId,
      client_packet_key: clientPacketKey,
      envelope,
      triage: verdict.triage,
      basis: verdict.basis,
      confidence: verdict.confidence,
      route: verdict.route,
      stop_line_hit: verdict.stop_line_hit,
      truth_state: verdict.truth_state,
      redaction: verdict.redaction,
      repair_risk: verdict.repair_risk,
      automation_status: verdict.automation_status
    });
    if (insertErr) {
      console.error('[bob-triage-report] persist error:', insertErr);
      return json({
        error: 'Failed to persist friction packet',
        detail: insertErr.message
      }, 500);
    }
    // ── 11. Return the verdict ──
    return json(verdict);
  } catch (err) {
    console.error('[bob-triage-report] error:', err);
    return json({
      error: 'Triage failed',
      detail: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});
