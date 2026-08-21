/**
 * conductor-welfare-seam.ts — Runtime wiring for the welfare safety-signal path
 *
 * Bridges the PURE Oracle + Conductor logic from packages/shared/src/welfareSafetySignal.ts
 * into the live Conductor's post-selection, pre-effect enforcement seam.
 *
 * DOCTRINE ALIGNMENT:
 *   - Oracle supplies truth-state only; it describes, it does not enforce (§4.1).
 *   - Conductor enforces at the post-selection, pre-effect seam (§4.2).
 *   - safety_signal may proceed under explicit hold when non-record-mutating,
 *     bounded, auditable, and directed to preventing immediate harm (§6).
 *   - SOS is NOT a bypass for governed writes (§6 hard line).
 *   - Welfare is PTT-independent (§12.1).
 *   - The officer under welfare risk is the harmed party (§12.4, FOUNDATION.md).
 *
 * SCOPE (honest build-state):
 *   This module provides the CONDUCTOR-SIDE seam:
 *     1. Classify whether a tool call is a safety-signal candidate.
 *     2. Build Oracle turn truth-state with welfare context when present.
 *     3. Evaluate the welfare safety seam (call conductorSafetyPrecedence).
 *     4. Build audit metadata for safety-signal decisions.
 *     5. Build the alert_raise payload for the first live safety-signal effect
 *        (#342). The payload targets the existing welfare_alerts table — a
 *        SAFETY surface, not a governed compliance/enforcement record.
 *     6. Capture welfare truth-state for governed-write-under-hold scenarios
 *        so the generic write-refusal path preserves welfare context in audit.
 *     7. (#342 hardening) Idempotency/dedupe guard for alert_raise — same
 *        officer + same active welfare condition + short window must not
 *        create duplicate live alerts. Deterministic dedupe key + pre-insert
 *        lookup semantics.
 *     8. (#342 hardening) Exact authority predicate — validate welfare context
 *        completeness; partial/ambiguous context fails closed to audit-only.
 *     9. (#342 hardening) Precise structured audit shape — audit metadata
 *        includes all §9 fields plus hold-exception vs ordinary flow, live
 *        effect emitted vs audit-only.
 *    10. (#342 hardening) Failure-mode table — deterministic handling for:
 *        truth captured but alert insert fails; incomplete welfare context;
 *        audit succeeds but egress fails; alert succeeds but response fails.
 *    11. (#342 hardening) Mixed-intent handling — governed write blocked +
 *        safety egress only if ratified safety signal selected + gate passes;
 *        both truths preserved distinctly.
 *
 *   NOT YET IMPLEMENTED (follow-up):
 *     - Server-side escalation timing (L1 → L2 → L3 auto-escalation).
 *     - Named welfare authority routing (resolving the specific human in the
 *       escalation chain per ACCESS_MODEL.md R2).
 *     - Full DB integration for reading welfare status (the conductor does
 *       not yet read welfare status from the DB — the caller must supply it).
 *     - last_known_context_pin, dispatcher_notify, escalation_timing live
 *       effects (alert_raise is the first; others are follow-up).
 *
 *   Pure functions are I/O-free and fully unit-testable.
 *   The live conductor (index.ts) calls these at the enforcement seam.
 *
 * Ref: #342, #341, #340, docs/enforcement-architecture.md §6, §9, §12.
 */ // ── Inline type mirrors ─────────────────────────────────────────────────────
// Deno edge functions use remote https imports and cannot resolve workspace
// packages. These types mirror packages/shared/src/welfareSafetySignal.ts
// exactly. The canonical definitions live there; these are runtime mirrors.
// If the canonical types change, these must be updated (parity guard).
/**
 * (#342 hardening) Dedupe key for alert_raise idempotency.
 *
 * Same officer + same active welfare condition + short window must not create
 * duplicate live alerts. The dedupe key is deterministic: it is computed from
 * the officer, org, alert type, and a time-window bucket.
 *
 * DEDUPE WINDOW: 5 minutes (300 seconds). Two alert_raise calls for the same
 * officer + same alert_type within 5 minutes are considered duplicates.
 * The window is intentionally short — welfare alerts are time-critical and
 * a genuine re-trigger after 5 minutes should create a new alert.
 */ export const ALERT_DEDUPE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
// ── Inline pure logic mirrors ───────────────────────────────────────────────
// Mirrors of the pure functions from packages/shared/src/welfareSafetySignal.ts.
// Canonical implementations live there; these are runtime copies for the Deno
// edge function environment.
const RATIFIED_SAFETY_SIGNAL_ACTIONS = [
  'alert_raise',
  'last_known_context_pin',
  'dispatcher_notify',
  'escalation_timing'
];
function isRatifiedSafetySignalAction(action) {
  return RATIFIED_SAFETY_SIGNAL_ACTIONS.includes(action);
}
export function hasActiveSafetyConcern(state) {
  return state.active_sos || state.active_man_down || state.active_overdue;
}
export function resolveWelfareTruthState(input) {
  const level = mapEscalationLevel(input.escalation_level);
  const isActiveSafety = input.welfare_status === 'overdue' || input.welfare_status === 'man_down' || input.welfare_status === 'sos';
  return {
    welfare_status: input.welfare_status,
    welfare_escalation_level: isActiveSafety ? level : null,
    last_welfare_signal: input.last_signal_timestamp && input.last_signal_type ? {
      timestamp: input.last_signal_timestamp,
      type: input.last_signal_type
    } : null,
    active_sos: input.welfare_status === 'sos',
    active_man_down: input.welfare_status === 'man_down',
    active_overdue: input.welfare_status === 'overdue'
  };
}
function mapEscalationLevel(level) {
  if (level === null || level <= 1) return 'L1';
  if (level === 2) return 'L2';
  return 'L3';
}
function validateSafetySignal(candidate) {
  const failed = [];
  if (!isRatifiedSafetySignalAction(candidate.action)) failed.push('action_not_ratified');
  if (candidate.mutates_governed_record) failed.push('record_mutating');
  if (!candidate.bounded) failed.push('unbounded');
  if (!candidate.auditable) failed.push('not_auditable');
  if (!candidate.prevents_immediate_harm) failed.push('not_preventing_immediate_harm');
  return {
    permitted: failed.length === 0,
    reason: failed.length === 0 ? 'Safety signal meets all §6 conditions: non-record-mutating, bounded, auditable, prevents immediate harm' : `Safety signal blocked: ${failed.join(', ')}`,
    failed_conditions: failed
  };
}
export function conductorSafetyPrecedence(oracle, candidate) {
  if (oracle.effect_class === 'internal_observation') {
    return {
      permitted: true,
      action: 'permit',
      reason: 'Internal observation — does not cross the governance boundary (§2)',
      refusal_class: null,
      safety_validation: null,
      enforcement_reason_code: 'internal_observation_passthrough'
    };
  }
  if (!oracle.explicit_hold) {
    return {
      permitted: true,
      action: 'permit',
      reason: 'No explicit hold active — effect proceeds normally',
      refusal_class: null,
      safety_validation: null,
      enforcement_reason_code: 'no_hold_active'
    };
  }
  if (oracle.effect_class === 'disclosure_egress') {
    return {
      permitted: true,
      action: 'permit',
      reason: 'Disclosure egress (answer-only) permitted under explicit hold (§5)',
      refusal_class: null,
      safety_validation: null,
      enforcement_reason_code: 'disclosure_egress_under_hold'
    };
  }
  if (oracle.effect_class === 'safety_signal') {
    if (!oracle.welfare || !hasActiveSafetyConcern(oracle.welfare)) {
      return {
        permitted: false,
        action: 'block',
        reason: 'Safety signal under hold but no active safety concern in welfare truth-state',
        refusal_class: 'correctable',
        safety_validation: null,
        enforcement_reason_code: 'safety_signal_blocked_no_active_concern'
      };
    }
    if (!candidate) {
      return {
        permitted: false,
        action: 'block',
        reason: 'Safety signal under hold but no candidate effect provided for validation',
        refusal_class: 'correctable',
        safety_validation: null,
        enforcement_reason_code: 'safety_signal_blocked_no_candidate'
      };
    }
    const validation = validateSafetySignal(candidate);
    if (validation.permitted) {
      return {
        permitted: true,
        action: 'permit',
        reason: `Safety signal permitted under explicit hold — ${validation.reason} (§6)`,
        refusal_class: null,
        safety_validation: validation,
        enforcement_reason_code: 'safety_signal_permitted'
      };
    }
    return {
      permitted: false,
      action: 'block',
      reason: `Safety signal blocked under hold — ${validation.reason}`,
      refusal_class: validation.failed_conditions.includes('action_not_ratified') ? 'terminal' : 'correctable',
      safety_validation: validation,
      enforcement_reason_code: 'safety_signal_blocked_validation_failed'
    };
  }
  if (oracle.effect_class === 'draft_governed_write' || oracle.effect_class === 'direct_world_change' || oracle.effect_class === 'admin_diagnostic_substrate_action') {
    return {
      permitted: false,
      action: 'block',
      reason: `Governed effect (${oracle.effect_class}) blocked under explicit hold — SOS is not a bypass for governed writes (§5, §6)`,
      refusal_class: 'correctable',
      safety_validation: null,
      enforcement_reason_code: 'governed_effect_blocked_under_hold'
    };
  }
  return {
    permitted: false,
    action: 'block',
    reason: `Unknown effect class (${oracle.effect_class}) blocked under explicit hold — fail-closed`,
    refusal_class: 'terminal',
    safety_validation: null,
    enforcement_reason_code: 'unknown_effect_class_fail_closed'
  };
}
function buildWelfareSafetyAuditRecord(input) {
  const reasonCode = input.decision.enforcement_reason_code ?? 'unknown_effect_class_fail_closed';
  return {
    selected_intent: {
      action: input.action,
      args: input.args
    },
    oracle_truth_state: input.oracle,
    conductor_decision: input.decision,
    rendered_egress: input.rendered_egress,
    timestamp: input.timestamp,
    enforcement_reason_code: reasonCode,
    hold_exception: input.hold_exception ?? false,
    live_effect_emitted: input.live_effect_emitted ?? false,
    live_effect_type: input.live_effect_type ?? null
  };
}
// ═══════════════════════════════════════════════════════════════════════════════
// RUNTIME WIRING — the conductor-side functions that index.ts calls
// ═══════════════════════════════════════════════════════════════════════════════
// ── Safety-signal tool classification ────────────────────────────────────────
/**
 * The set of tool names that produce safety_signal effects.
 *
 * HONEST BUILD-STATE: No dedicated safety-signal tools exist in the catalogue
 * yet (the welfare alert/notify tools are follow-up work). This set is
 * populated with the RATIFIED safety-signal action names so the conductor
 * can classify planner-selected actions that match the safety-signal pattern.
 *
 * When dedicated welfare tools are added to the catalogue (e.g.
 * `welfare_alert_raise`, `welfare_dispatcher_notify`), they should be added
 * here AND to TOOL_REGISTRY in caddie.ts with effect_class: 'safety_signal'.
 */ export const SAFETY_SIGNAL_TOOL_ACTIONS = new Set([
  'alert_raise',
  'last_known_context_pin',
  'dispatcher_notify',
  'escalation_timing'
]);
/**
 * Whether a tool/action name is classified as a safety-signal effect.
 * Used by the conductor to detect when the planner has selected a
 * safety-signal action.
 */ export function isSafetySignalAction(action) {
  return SAFETY_SIGNAL_TOOL_ACTIONS.has(action);
}
/**
 * Build the Oracle turn truth-state for the welfare safety-signal path.
 *
 * This is the conductor's entry point for constructing the Oracle truth-state
 * that conductorSafetyPrecedence() consumes. It combines:
 *   - explicit_hold: from detectExplicitWriteRefusal() in the conductor
 *   - effect_class: from classifyToolEffect() in caddie.ts, overridden to
 *     'safety_signal' when the action is a safety-signal candidate
 *   - welfare: from the welfare context supplied by the conductor
 *
 * PURE function — no I/O.
 */ export function buildOracleTurnTruthState(input) {
  return {
    explicit_hold: input.explicit_hold,
    effect_class: input.effect_class,
    welfare: input.welfare_context ? resolveWelfareTruthState(input.welfare_context) : null
  };
}
// ── Safety-signal candidate construction ─────────────────────────────────────
/**
 * Build a SafetySignalCandidate from a planner-selected action.
 *
 * Safety signals are by definition:
 *   - Non-record-mutating (they alert; they do not create compliance records)
 *   - Bounded (scoped to the officer and the immediate safety concern)
 *   - Auditable (logged in the enforcement ledger)
 *   - Directed to preventing immediate harm
 *
 * These properties are STRUCTURAL for ratified safety-signal actions (§6).
 * A ratified action is non-mutating, bounded, auditable, and harm-preventing
 * by design. A non-ratified action fails the action_not_ratified check.
 *
 * PURE function — no I/O.
 */ export function buildSafetySignalCandidate(action) {
  const isRatified = isRatifiedSafetySignalAction(action);
  return {
    action,
    // Ratified safety-signal actions are structurally non-record-mutating,
    // bounded, auditable, and harm-preventing. Non-ratified actions get
    // false for all conditions (they will fail validation anyway).
    mutates_governed_record: false,
    bounded: isRatified,
    auditable: true,
    prevents_immediate_harm: isRatified
  };
}
/**
 * Evaluate the welfare safety seam for a candidate tool dispatch.
 *
 * This is the SINGLE ENTRY POINT called by the conductor (index.ts) at the
 * post-selection, pre-effect seam when welfare context is present and the
 * selected action is a safety-signal candidate.
 *
 * The conductor calls this at the post-selection, pre-effect seam. Per #342,
 * when welfare context is present, this runs BEFORE the generic write-refusal
 * early return so welfare truth-state is captured in audit. If the welfare
 * seam is applicable and returns a decision, the conductor uses that decision
 * instead of the standard enforcement path.
 *
 * PURE function — no I/O. The conductor supplies all context.
 *
 * @param input.action - The planner-selected action/tool name
 * @param input.args - The planner-selected action arguments
 * @param input.explicit_hold - Whether explicit hold is active (from detectExplicitWriteRefusal)
 * @param input.effect_class - The tool's effect class (from classifyToolEffect)
 * @param input.welfare_context - Welfare context for the current turn (null if none)
 */ export function evaluateWelfareSafetySeam(input) {
  // Not applicable if no welfare context or not a safety-signal action
  const isSafety = isSafetySignalAction(input.action);
  if (!input.welfare_context && !isSafety) {
    return {
      applicable: false,
      decision: null,
      oracle: null,
      audit: null
    };
  }
  // Build Oracle truth-state with welfare context
  // If the action is a safety-signal action, override effect_class to safety_signal
  const effectClass = isSafety ? 'safety_signal' : input.effect_class;
  const oracle = buildOracleTurnTruthState({
    explicit_hold: input.explicit_hold,
    effect_class: effectClass,
    welfare_context: input.welfare_context
  });
  // If welfare context is present but the action is NOT a safety signal,
  // the welfare seam still applies for governed-write blocking under hold.
  // But the standard enforcement path already handles that. Only intervene
  // when the action IS a safety signal (the novel path this wiring adds).
  if (!isSafety) {
    // Welfare context present, non-safety action: let the standard path handle it.
    // But if explicit hold is active and welfare concern exists, we still need
    // to ensure governed writes are blocked (the standard path does this, but
    // we record the welfare truth-state in audit for completeness).
    //
    // (#342 hardening) MIXED-INTENT HANDLING (requirement 6):
    // If a governed write is selected while safety context exists, governed
    // write remains blocked; safety egress allowed only if a ratified safety
    // signal is selected and gate passes; both truths preserved distinctly.
    if (input.explicit_hold && oracle.welfare && hasActiveSafetyConcern(oracle.welfare)) {
      const decision = conductorSafetyPrecedence(oracle, null);
      const audit = buildWelfareSafetyAuditRecord({
        action: input.action,
        args: input.args,
        oracle,
        decision,
        rendered_egress: decision.permitted ? 'Effect proceeds (non-safety action, welfare context noted)' : `Effect blocked: ${decision.reason}`,
        timestamp: new Date().toISOString(),
        hold_exception: false,
        live_effect_emitted: false,
        live_effect_type: null
      });
      return {
        applicable: true,
        decision,
        oracle,
        audit
      };
    }
    return {
      applicable: false,
      decision: null,
      oracle: null,
      audit: null
    };
  }
  // Safety-signal action: build candidate and evaluate
  const candidate = buildSafetySignalCandidate(input.action);
  const decision = conductorSafetyPrecedence(oracle, candidate);
  // (#342 hardening) Determine hold-exception status: safety signal permitted
  // under explicit hold is a hold-exception (§6).
  const isHoldException = input.explicit_hold && decision.permitted;
  const renderedEgress = decision.permitted ? `Safety signal (${input.action}) permitted — ${decision.reason}` : `Safety signal (${input.action}) blocked — ${decision.reason}`;
  const audit = buildWelfareSafetyAuditRecord({
    action: input.action,
    args: input.args,
    oracle,
    decision,
    rendered_egress: renderedEgress,
    timestamp: new Date().toISOString(),
    hold_exception: isHoldException,
    // live_effect_emitted is set to false here — the conductor (index.ts)
    // updates this after the actual insert succeeds or fails.
    live_effect_emitted: false,
    live_effect_type: decision.permitted ? input.action : null
  });
  return {
    applicable: true,
    decision,
    oracle,
    audit
  };
}
/**
 * Build the alert_raise payload from the welfare seam evaluation context.
 *
 * PURE function — no I/O. The conductor calls this when the welfare seam
 * permits an alert_raise safety signal, then performs the actual insert.
 *
 * Returns null if the input lacks required fields (organization_id,
 * officer_user_id). The conductor must supply these from the turn context.
 */ export function buildAlertRaisePayload(input) {
  if (!input.organization_id || !input.officer_user_id) return null;
  const alertType = mapWelfareStatusToAlertType(input.welfare_context.welfare_status);
  if (!alertType) return null;
  return {
    organization_id: input.organization_id,
    officer_user_id: input.officer_user_id,
    alert_type: alertType,
    status: 'pending',
    gps_lat: typeof input.args.gps_lat === 'number' ? input.args.gps_lat : null,
    gps_lng: typeof input.args.gps_lng === 'number' ? input.args.gps_lng : null,
    triggered_at: new Date().toISOString(),
    escalation_level: input.welfare_context.escalation_level ?? 1,
    notes: buildAlertNotes(input.welfare_context, input.args)
  };
}
/**
 * Map welfare status to welfare_alerts.alert_type.
 * Only active safety concerns produce alerts.
 */ function mapWelfareStatusToAlertType(status) {
  switch(status){
    case 'sos':
      return 'sos';
    case 'man_down':
      return 'man_down';
    case 'overdue':
      return 'overdue';
    default:
      return null; // ok, due — no alert
  }
}
/**
 * Build human-readable notes for the alert_raise payload.
 */ function buildAlertNotes(welfare, args) {
  const source = 'Conductor safety-signal (§6)';
  const status = welfare.welfare_status.toUpperCase();
  const level = welfare.escalation_level ?? 1;
  const custom = typeof args.notes === 'string' ? ` — ${args.notes}` : '';
  return `${status} alert raised via ${source}, escalation L${level}${custom}`;
}
// ═══════════════════════════════════════════════════════════════════════════════
// WELFARE TRUTH-STATE CAPTURE FOR WRITE-REFUSAL ORDERING (#342)
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Capture welfare truth-state for a governed-write-under-hold scenario.
 *
 * Called by the conductor BEFORE the generic write-refusal early return when
 * welfare context is present. This ensures welfare truth-state is preserved
 * in the audit metadata even when the generic write-refusal path fires.
 *
 * DOCTRINE (§9 + §12.2): When Conductor blocks a governed write under hold
 * and welfare context is present, the audit record must include the welfare
 * truth-state — not just the generic "write refused by user instruction" reason.
 *
 * PURE function — no I/O.
 */ export function captureWelfareTruthForWriteRefusal(input) {
  const oracle = buildOracleTurnTruthState({
    explicit_hold: input.explicit_hold,
    effect_class: 'draft_governed_write',
    welfare_context: input.welfare_context
  });
  const decision = conductorSafetyPrecedence(oracle, null);
  const audit = buildWelfareSafetyAuditRecord({
    action: input.action,
    args: input.args,
    oracle,
    decision,
    rendered_egress: `Governed write blocked under explicit hold — welfare truth-state preserved: ${oracle.welfare?.welfare_status ?? 'unknown'}`,
    timestamp: new Date().toISOString(),
    hold_exception: false,
    live_effect_emitted: false,
    live_effect_type: null
  });
  return {
    oracle,
    audit
  };
}
// ═══════════════════════════════════════════════════════════════════════════════
// (#342 HARDENING) IDEMPOTENCY / DEDUPE FOR alert_raise
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Build a deterministic dedupe key for an alert_raise payload.
 *
 * The key is: `alert:{org_id}:{officer_id}:{alert_type}:{window_bucket}`
 * where window_bucket is the triggered_at timestamp truncated to the
 * ALERT_DEDUPE_WINDOW_MS boundary.
 *
 * PURE function — no I/O.
 */ export function buildAlertDedupeKey(payload) {
  const triggerMs = new Date(payload.triggered_at).getTime();
  const bucketMs = Math.floor(triggerMs / ALERT_DEDUPE_WINDOW_MS) * ALERT_DEDUPE_WINDOW_MS;
  const windowBucket = new Date(bucketMs).toISOString();
  const key = `alert:${payload.organization_id}:${payload.officer_user_id}:${payload.alert_type}:${windowBucket}`;
  return {
    key,
    organization_id: payload.organization_id,
    officer_user_id: payload.officer_user_id,
    alert_type: payload.alert_type,
    window_bucket: windowBucket
  };
}
/**
 * Build the SQL filter for checking existing alerts within the dedupe window.
 *
 * Returns the filter parameters the conductor uses for a pre-insert lookup
 * against welfare_alerts. The conductor (index.ts) performs the actual query.
 *
 * PURE function — no I/O.
 */ export function buildDedupeQueryParams(dedupeKey) {
  const bucketMs = new Date(dedupeKey.window_bucket).getTime();
  return {
    organization_id: dedupeKey.organization_id,
    officer_user_id: dedupeKey.officer_user_id,
    alert_type: dedupeKey.alert_type,
    window_start: new Date(bucketMs).toISOString(),
    window_end: new Date(bucketMs + ALERT_DEDUPE_WINDOW_MS).toISOString()
  };
}
// ═══════════════════════════════════════════════════════════════════════════════
// (#342 HARDENING) EXACT AUTHORITY PREDICATE
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Validate the authority predicate for alert_raise.
 *
 * States and tests WHO may cause alert_raise, from WHAT welfare context,
 * and what happens with partial/ambiguous context.
 *
 * AUTHORITY RULES:
 *   1. welfare_context MUST be present and non-null.
 *   2. welfare_status MUST be an active safety concern (overdue, man_down, sos).
 *   3. organization_id MUST be present (RLS scoping).
 *   4. officer_user_id MUST be present (the harmed party).
 *   5. welfare_status MUST be a valid WelfareStatus value.
 *
 * FAIL-CLOSED: Ambiguous or partial context fails to audit-only/refusal,
 * not half-succeed into a live effect. This is the doctrine requirement:
 * "Ambiguous/partial context should fail closed to audit-only/refusal,
 * not half-succeed into a live effect."
 *
 * PURE function — no I/O.
 */ export function validateAuthorityPredicate(input) {
  const failures = [];
  // Rule 1: welfare_context must be present
  if (!input.welfare_context) {
    failures.push('welfare_context_missing');
    return {
      permitted: false,
      reason: 'Authority predicate failed: welfare context is missing — fail closed to audit-only',
      failures
    };
  }
  // Rule 5: welfare_status must be a valid value
  const validStatuses = [
    'ok',
    'due',
    'overdue',
    'man_down',
    'sos'
  ];
  if (!validStatuses.includes(input.welfare_context.welfare_status)) {
    failures.push('welfare_status_invalid');
  }
  // Rule 2: welfare_status must be an active safety concern
  if (![
    'overdue',
    'man_down',
    'sos'
  ].includes(input.welfare_context.welfare_status)) {
    failures.push('welfare_status_not_active_concern');
  }
  // Rule 3: organization_id must be present
  if (!input.organization_id) {
    failures.push('organization_id_missing');
  }
  // Rule 4: officer_user_id must be present
  if (!input.officer_user_id) {
    failures.push('officer_user_id_missing');
  }
  if (failures.length > 0) {
    return {
      permitted: false,
      reason: `Authority predicate failed: ${failures.join(', ')} — fail closed to audit-only`,
      failures
    };
  }
  return {
    permitted: true,
    reason: 'Authority predicate passed: valid welfare context, active safety concern, org and officer identified',
    failures: []
  };
}
/**
 * (#342 hardening) Validate welfare context completeness.
 *
 * A welfare context is COMPLETE when it has a valid welfare_status.
 * A welfare context is PARTIAL when welfare_status is present but other
 * fields are missing (escalation_level, last_signal_timestamp, etc.).
 * A welfare context is AMBIGUOUS when welfare_status is not a recognized value.
 *
 * Partial context is acceptable for audit purposes but NOT for live effects.
 * Ambiguous context fails closed entirely.
 *
 * PURE function — no I/O.
 */ export function validateWelfareContextCompleteness(ctx) {
  if (!ctx) {
    return {
      complete: false,
      partial: false,
      ambiguous: false,
      reason: 'No welfare context provided'
    };
  }
  const validStatuses = [
    'ok',
    'due',
    'overdue',
    'man_down',
    'sos'
  ];
  if (!validStatuses.includes(ctx.welfare_status)) {
    return {
      complete: false,
      partial: false,
      ambiguous: true,
      reason: `Ambiguous welfare status: ${ctx.welfare_status}`
    };
  }
  // Check for partial context: status is valid but supporting fields are missing
  const hasEscalation = ctx.escalation_level !== null && ctx.escalation_level !== undefined;
  const hasLastSignal = ctx.last_signal_timestamp !== null && ctx.last_signal_type !== null;
  if (!hasEscalation || !hasLastSignal) {
    return {
      complete: false,
      partial: true,
      ambiguous: false,
      reason: 'Partial welfare context: status valid but supporting fields missing'
    };
  }
  return {
    complete: true,
    partial: false,
    ambiguous: false,
    reason: 'Welfare context is complete'
  };
}
/**
 * Build the effect result for a successful alert_raise insert.
 * PURE function — no I/O.
 */ export function buildAlertRaiseSuccess(baseAudit) {
  return {
    emitted: true,
    deduplicated: false,
    failure_mode: 'none',
    description: 'alert_raise emitted successfully',
    audit: {
      ...baseAudit,
      live_effect_emitted: true,
      live_effect_type: 'alert_raise'
    }
  };
}
/**
 * Build the effect result for a deduplicated alert_raise (existing alert found).
 * PURE function — no I/O.
 */ export function buildAlertRaiseDeduplicated(baseAudit, existingAlertId) {
  return {
    emitted: false,
    deduplicated: true,
    failure_mode: 'dedupe_existing_alert_found',
    description: `alert_raise deduplicated — existing alert ${existingAlertId} found in dedupe window`,
    audit: {
      ...baseAudit,
      live_effect_emitted: false,
      live_effect_type: null,
      rendered_egress: `${baseAudit.rendered_egress} [DEDUPLICATED: existing alert ${existingAlertId}]`
    }
  };
}
/**
 * Build the effect result for a failed alert_raise insert.
 *
 * SAFETY PATH: Truth is captured in audit. Alert is NOT emitted.
 * Response includes failure notice. This is deterministic — the conductor
 * does not retry the insert (retries are follow-up work for the escalation
 * timing system).
 *
 * PURE function — no I/O.
 */ export function buildAlertRaiseInsertFailed(baseAudit, errorMessage) {
  return {
    emitted: false,
    deduplicated: false,
    failure_mode: 'truth_captured_alert_insert_failed',
    description: `alert_raise insert failed: ${errorMessage} — truth captured in audit, alert NOT emitted`,
    audit: {
      ...baseAudit,
      live_effect_emitted: false,
      live_effect_type: null,
      rendered_egress: `${baseAudit.rendered_egress} [INSERT FAILED: ${errorMessage}]`
    }
  };
}
/**
 * Build the effect result for an authority predicate failure.
 *
 * SAFETY PATH: Fail closed to audit-only. No live effect.
 * PURE function — no I/O.
 */ export function buildAlertRaiseAuthorityFailed(baseAudit, authorityResult) {
  return {
    emitted: false,
    deduplicated: false,
    failure_mode: 'authority_predicate_failed',
    description: `alert_raise authority predicate failed: ${authorityResult.reason}`,
    audit: {
      ...baseAudit,
      live_effect_emitted: false,
      live_effect_type: null,
      enforcement_reason_code: 'authority_predicate_failed',
      rendered_egress: `${baseAudit.rendered_egress} [AUTHORITY FAILED: ${authorityResult.failures.join(', ')}]`
    }
  };
}
/**
 * Build the effect result for incomplete welfare context.
 *
 * SAFETY PATH: Fail closed to audit-only. No live effect.
 * Ambiguous/partial context does not half-succeed into a live effect.
 * PURE function — no I/O.
 */ export function buildAlertRaiseIncompleteContext(baseAudit, contextValidation) {
  return {
    emitted: false,
    deduplicated: false,
    failure_mode: 'incomplete_welfare_context',
    description: `alert_raise blocked — ${contextValidation.reason}`,
    audit: {
      ...baseAudit,
      live_effect_emitted: false,
      live_effect_type: null,
      enforcement_reason_code: 'welfare_context_incomplete',
      rendered_egress: `${baseAudit.rendered_egress} [INCOMPLETE CONTEXT: ${contextValidation.reason}]`
    }
  };
}
// ═══════════════════════════════════════════════════════════════════════════════
// (#342 HARDENING) CROSS-FLOW CONTAMINATION GUARD
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Determine whether the welfare seam should activate for this turn.
 *
 * CROSS-FLOW CONTAMINATION GUARD (requirement 5):
 * Non-welfare write-refusal behaviour remains unchanged when no welfare
 * context exists. The welfare seam ONLY activates when:
 *   1. welfare_context is non-null, OR
 *   2. the selected action is a ratified safety-signal action.
 *
 * When neither condition is true, this returns false and the standard
 * enforcement path handles the turn — completely unchanged from pre-#342
 * behaviour.
 *
 * PURE function — no I/O.
 */ export function shouldActivateWelfareSeam(input) {
  if (input.welfare_context !== null) return true;
  if (isSafetySignalAction(input.action)) return true;
  return false;
}
// ── Exports for testing ─────────────────────────────────────────────────────
export { RATIFIED_SAFETY_SIGNAL_ACTIONS, isRatifiedSafetySignalAction, validateSafetySignal, buildWelfareSafetyAuditRecord, mapWelfareStatusToAlertType, buildAlertNotes };
