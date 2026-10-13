/**
 * welfare-escalation-tick — Server-side welfare escalation timing
 *
 * POST /functions/v1/welfare-escalation-tick
 * Body: {} (no input). Intended to be run on a short interval (e.g. every
 *        1–2 minutes via pg_cron + pg_net, or any scheduler hitting this
 *        endpoint with the service role / a cron secret).
 *
 * For every active welfare alert (status = 'pending', escalation_level < 3),
 * evaluates whether the configured escalation threshold has elapsed and
 * escalates L1→L2→L3 accordingly.
 *
 * DOCTRINE ALIGNMENT:
 *   - Welfare is keeper principle in live form (FOUNDATION.md).
 *   - Escalation is a safety_signal: bounded, auditable, non-record-mutating
 *     (§6). welfare_alerts is a safety surface, not a governed compliance/
 *     enforcement record.
 *   - PTT-independent (§12.1): does not depend on PTT or a client session.
 *   - Fail-safe: no human response → automatic escalation (§12.2, HSWA 2015 s36).
 *   - SOS/escalation is NOT a bypass for governed writes (§6 hard line).
 *   - Does not modify Bob's internal reasoning/awareness plane.
 *
 * IDEMPOTENT: Repeated runs produce no duplicate side effects. Each alert is
 * only escalated once per level — the UPDATE uses a WHERE clause that checks
 * the current escalation_level matches the expected previous level.
 *
 * Auth: service-role OR x-cron-secret only. This is a backend/cron job.
 *
 * NAMED WELFARE AUTHORITY ROUTING (#347):
 *   When an alert is escalated, the tick resolves the named welfare authority
 *   for the officer via resolve_manager_for_user (0277) and records the
 *   resolution in the audit event. If the authority is R2 compliant (named,
 *   not role-class), a notification is dispatched to that specific human via
 *   enqueue_notification (0068). If no named authority is found, the fallback
 *   reason is recorded in audit — never silent success.
 *
 *   Per ACCESS_MODEL.md R2: role class alone is not sufficient. A generic
 *   supervisor/admin not in the officer's escalation chain must not be
 *   treated as named authority.
 *
 * Ref: #347, #345, docs/enforcement-architecture.md §6, §12,
 *      docs/ACCESS_MODEL.md R2.
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
// ATLAS EXTERNAL CALLER: supabase-pg-cron-welfare-escalation
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret'
};
// ── Inline escalation logic ─────────────────────────────────────────────────
// Mirrors packages/shared/src/welfareEscalationTiming.ts for the Deno edge
// function environment (cannot import workspace packages). Canonical
// definitions live in the shared package; these are runtime copies.
const MAX_ESCALATION_LEVEL = 3;
const DEFAULT_ADMIN_ESCALATION_TIME = 5; // minutes
const DEFAULT_CRITICAL_ESCALATION_TIME = 5; // minutes
function computeElapsedMinutes(alert, nowIso) {
  const ref = alert.escalated_at ?? alert.triggered_at;
  return (new Date(nowIso).getTime() - new Date(ref).getTime()) / 60_000;
}
function getThreshold(currentLevel, config) {
  return currentLevel <= 1 ? config.admin_escalation_time : config.critical_escalation_time;
}
function evaluateAlert(alert, config, nowIso) {
  // Only pending alerts below L3 are eligible
  if (alert.status !== 'pending') return null;
  if (alert.escalation_level >= MAX_ESCALATION_LEVEL) return null;
  const elapsed = computeElapsedMinutes(alert, nowIso);
  const threshold = getThreshold(alert.escalation_level, config);
  if (elapsed < threshold) return null;
  const newLevel = alert.escalation_level + 1;
  const levelLabel = newLevel === 2 ? 'L2 (admin escalation)' : 'L3 (critical escalation)';
  return {
    alert_id: alert.id,
    new_level: newLevel,
    previous_level: alert.escalation_level,
    escalated_at: nowIso,
    reason: `Auto-escalated to ${levelLabel}: ${elapsed.toFixed(1)} min elapsed, threshold ${threshold} min (server-side escalation tick, §12.3)`
  };
}
/** R2-compliant sources: explicit person-level assignment to this officer. */ const NAMED_AUTHORITY_SOURCES = [
  'branch_line_manager',
  'org_wide_line_manager',
  'team_lead'
];
function classifyResolutionSource(source) {
  if (NAMED_AUTHORITY_SOURCES.includes(source)) return 'named_authority';
  return 'role_class_fallback';
}
/**
 * Resolve welfare authority with snapshot timestamp (hardening #1).
 * The resolved_at timestamp is captured at resolution time so past
 * escalations never rely on re-deriving the current manager/org chart.
 */ function resolveWelfareAuthority(officer_user_id, organization_id, resolution, nowIso) {
  if (!resolution) {
    return {
      officer_user_id,
      organization_id,
      authority_user_id: null,
      resolution_source: null,
      classification: 'no_authority_found',
      r2_compliant: false,
      reason: 'No manager resolved — resolve_manager_for_user returned zero rows.',
      resolved_at: nowIso
    };
  }
  const classification = classifyResolutionSource(resolution.resolution_source);
  const r2 = classification === 'named_authority';
  return {
    officer_user_id,
    organization_id,
    authority_user_id: resolution.manager_user_id,
    resolution_source: resolution.resolution_source,
    classification,
    r2_compliant: r2,
    reason: r2 ? `Named authority via ${resolution.resolution_source} — R2 compliant.` : `Role-class fallback via ${resolution.resolution_source} — not R2 compliant. ` + 'Audit-only/manual-routing fallback — not named authority, not notification target.',
    resolved_at: nowIso
  };
}
// ── Edge function handler ───────────────────────────────────────────────────
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
  // ── Auth: service-role / cron only ──────────────────────────────────────
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
    const nowIso = new Date().toISOString();
    // ── 1. Fetch eligible alerts ────────────────────────────────────────
    // Only pending alerts below L3. The query is the server-side equivalent
    // of what the client hooks do — but independent of any client session.
    const { data: alerts, error: alertErr } = await admin.from('welfare_alerts').select('id, organization_id, officer_user_id, alert_type, status, escalation_level, escalated_at, triggered_at').eq('status', 'pending').lt('escalation_level', MAX_ESCALATION_LEVEL);
    if (alertErr) {
      return json({
        error: 'Failed to fetch alerts',
        details: alertErr.message
      }, 500);
    }
    if (!alerts || alerts.length === 0) {
      return json({
        success: true,
        evaluated: 0,
        escalated: 0,
        skipped: 0,
        idempotent_noop: true,
        tick_at: nowIso
      });
    }
    // ── 2. Fetch per-officer escalation configs ─────────────────────────
    const officerIds = [
      ...new Set(alerts.map((a)=>a.officer_user_id))
    ];
    const { data: settings } = await admin.from('officer_welfare_settings').select('officer_user_id, admin_escalation_time, critical_escalation_time').in('officer_user_id', officerIds);
    const configMap = new Map();
    for (const s of settings ?? []){
      configMap.set(s.officer_user_id, {
        admin_escalation_time: s.admin_escalation_time ?? DEFAULT_ADMIN_ESCALATION_TIME,
        critical_escalation_time: s.critical_escalation_time ?? DEFAULT_CRITICAL_ESCALATION_TIME
      });
    }
    // ── 3. Evaluate each alert ──────────────────────────────────────────
    const actions = [];
    let skipped = 0;
    for (const alert of alerts){
      const config = configMap.get(alert.officer_user_id) ?? {
        admin_escalation_time: DEFAULT_ADMIN_ESCALATION_TIME,
        critical_escalation_time: DEFAULT_CRITICAL_ESCALATION_TIME
      };
      const action = evaluateAlert(alert, config, nowIso);
      if (action) {
        actions.push(action);
      } else {
        skipped += 1;
      }
    }
    // ── 4. Apply escalation updates (idempotent) ────────────────────────
    // Each UPDATE uses a WHERE clause that checks the current escalation_level
    // matches the expected previous level. This ensures idempotency: if a
    // concurrent run already escalated the alert, this run's UPDATE is a no-op.
    let applied = 0;
    const failures = [];
    for (const action of actions){
      const { error: updateErr } = await admin.from('welfare_alerts').update({
        escalation_level: action.new_level,
        escalated_at: action.escalated_at,
        notes: action.reason
      }).eq('id', action.alert_id).eq('escalation_level', action.previous_level) // idempotency guard
      .eq('status', 'pending'); // do not escalate if resolved between fetch and update
      if (updateErr) {
        failures.push({
          alert_id: action.alert_id,
          error: updateErr.message
        });
      } else {
        applied += 1;
      }
    }
    // ── 4b. Named welfare authority resolution + notification (#347) ────
    // For each escalated alert, resolve the named welfare authority for the
    // officer and dispatch a notification if R2 compliant. If no named
    // authority is found, record an auditable fallback reason.
    const authorityAudits = [];
    for (const action of actions){
      const alert = alerts.find((a)=>a.id === action.alert_id);
      if (!alert) continue;
      // Call resolve_manager_for_user (0277) via RPC.
      // SECURITY DEFINER function — callable from service role.
      // Hardening #7: resolution failure must not block escalation update.
      // Hardening #1: snapshot authority at escalation time (nowIso).
      let resolution = null;
      let resolutionFailed = false;
      let resolutionError = null;
      try {
        const { data: mgrRows, error: mgrErr } = await admin.rpc('resolve_manager_for_user', {
          p_user_id: alert.officer_user_id,
          p_context_org_id: alert.organization_id
        });
        if (mgrErr) {
          // RPC returned an error but did not throw — record it.
          resolutionFailed = true;
          resolutionError = `resolve_manager_for_user RPC error: ${mgrErr.message}`;
        } else if (mgrRows && mgrRows.length > 0) {
          resolution = {
            manager_user_id: mgrRows[0].manager_user_id,
            resolution_source: mgrRows[0].resolution_source
          };
        }
      } catch (resolveErr) {
        // Manager resolution failure must not block the safety-signal path.
        // The escalation update has already been applied.
        // Hardening #7: record the failure in audit.
        resolutionFailed = true;
        resolutionError = resolveErr instanceof Error ? `resolve_manager_for_user exception: ${resolveErr.message}` : 'resolve_manager_for_user exception: unknown error';
      }
      // Hardening #1: snapshot with resolved_at timestamp.
      const authority = resolveWelfareAuthority(alert.officer_user_id, alert.organization_id, resolution, nowIso);
      // Hardening #5: Dispatch notification ONLY when
      // authority_result.r2_compliant === true AND authority_user_id is present.
      // No role-class fallback notifications. No notifications on resolution failure.
      let notificationDispatched = false;
      let notificationId = null;
      if (authority.r2_compliant && authority.authority_user_id && !resolutionFailed) {
        try {
          const levelLabel = action.new_level === 2 ? 'L2 (admin escalation)' : 'L3 (critical)';
          const alertLabel = alert.alert_type.toUpperCase().replace('_', ' ');
          const { data: notifId, error: notifErr } = await admin.rpc('enqueue_notification', {
            p_organization_id: alert.organization_id,
            p_category: 'welfare',
            p_title: `Welfare ${levelLabel}: ${alertLabel} — officer requires attention`,
            p_body: `A welfare ${alertLabel} alert has been escalated to ${levelLabel}. ` + `You are the named welfare authority for this officer ` + `(resolved via ${authority.resolution_source}). ` + 'Please review and respond.',
            p_severity: action.new_level >= 3 ? 'critical' : 'warning',
            p_recipient_user_id: authority.authority_user_id,
            p_link_page: 'WelfareAlertsPage',
            p_link_payload: JSON.stringify({
              alert_id: alert.id,
              officer_user_id: alert.officer_user_id,
              alert_type: alert.alert_type
            }),
            p_dedup_key: `welfare_escalation:${alert.id}:L${action.new_level}`
          });
          if (!notifErr && notifId) {
            notificationDispatched = true;
            notificationId = notifId;
          }
        } catch  {
        // Notification failure must not block the safety-signal path.
        // The escalation update has already been applied.
        // Hardening #7: notification failure is recorded via
        // notificationDispatched remaining false.
        }
      }
      authorityAudits.push({
        alert_id: alert.id,
        officer_user_id: alert.officer_user_id,
        organization_id: alert.organization_id,
        authority,
        notification_dispatched: notificationDispatched,
        notification_id: notificationId,
        fallback_reason: resolutionFailed ? 'resolution_failed' : authority.classification === 'no_authority_found' ? 'no_manager_resolved' : authority.classification === 'role_class_fallback' ? 'role_class_only' : null,
        // Hardening #7: record resolution failure.
        resolution_failed: resolutionFailed,
        resolution_error: resolutionError
      });
    }
    // ── 5. Emit audit event ─────────────────────────────────────────────
    // Log the tick result to bob_event_log for observability.
    // This is a safety-signal audit record, not a governed write.
    try {
      await admin.from('bob_event_log').insert({
        event_type: 'welfare_escalation_tick',
        payload: {
          tick_at: nowIso,
          evaluated: alerts.length,
          escalated: applied,
          skipped,
          failures: failures.length,
          actions: actions.map((a)=>({
              alert_id: a.alert_id,
              previous_level: a.previous_level,
              new_level: a.new_level,
              reason: a.reason
            })),
          // #347: named welfare authority resolution audit
          // Hardening #6: full structured provenance per escalation.
          authority_resolutions: authorityAudits.map((a)=>({
              alert_id: a.alert_id,
              officer_user_id: a.officer_user_id,
              organization_id: a.organization_id,
              authority_user_id: a.authority.authority_user_id,
              resolution_source: a.authority.resolution_source,
              classification: a.authority.classification,
              r2_compliant: a.authority.r2_compliant,
              resolved_at: a.authority.resolved_at,
              notification_dispatched: a.notification_dispatched,
              notification_id: a.notification_id,
              fallback_reason: a.fallback_reason,
              // Hardening #7: resolution failure recorded.
              resolution_failed: a.resolution_failed,
              resolution_error: a.resolution_error
            })),
          idempotent_noop: actions.length === 0
        }
      });
    } catch  {
    // Audit failure must not block the safety-signal path.
    // The escalation updates have already been applied.
    }
    return json({
      success: true,
      evaluated: alerts.length,
      escalated: applied,
      skipped,
      failures: failures.length,
      idempotent_noop: actions.length === 0,
      tick_at: nowIso,
      actions: actions.map((a)=>({
          alert_id: a.alert_id,
          previous_level: a.previous_level,
          new_level: a.new_level
        })),
      // #347: authority resolution summary (hardening #6 provenance).
      authority_resolutions: authorityAudits.map((a)=>({
          alert_id: a.alert_id,
          officer_user_id: a.officer_user_id,
          organization_id: a.organization_id,
          authority_user_id: a.authority.authority_user_id,
          resolution_source: a.authority.resolution_source,
          r2_compliant: a.authority.r2_compliant,
          classification: a.authority.classification,
          resolved_at: a.authority.resolved_at,
          notification_dispatched: a.notification_dispatched,
          fallback_reason: a.fallback_reason,
          resolution_failed: a.resolution_failed
        }))
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return json({
      error: 'Server error',
      details: msg
    }, 500);
  }
});
