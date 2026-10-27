/**
 * bob-triage-report/triage-logic.ts -- PURE, deterministic triage logic.
 *
 * Extracted from index.ts so it can be unit-tested without booting a Deno
 * HTTP server (serve() at module load). No LLM, no network, no DB.
 *
 * Design: docs/bob/BOB_FRICTION_TRIAGE_DESIGN.md
 * Plan:   docs/proposals/BOB_TRIAGE_REPORT_PLAN.md
 */ // ---------------------------------------------------------------------------
// Envelope contract constants (section 2c)
// ---------------------------------------------------------------------------
export const MAX_RECENT_ACTIONS = 20;
export const MAX_ERROR_MESSAGE_LEN = 500;
export const MAX_STACK_TOP_FRAMES = 5;
export const MAX_TEXT_FIELD_LEN = 1000;
export const SUPPORTED_SCHEMA_VERSIONS = new Set([
  '1'
]);
// ---------------------------------------------------------------------------
// Envelope validation + redaction (section 2c, defence-in-depth)
// ---------------------------------------------------------------------------
const ALLOWED_BEFORE_FIELDS = new Set([
  'page',
  'module',
  'record_id',
  'targetRoute',
  'recent_actions',
  'active_module_context',
  'view_title',
  'view_headings',
  'active_tab',
  'workspace',
  'viewport'
]);
export const USER_REPORT_KINDS = new Set([
  'change_request',
  'workflow_snag',
  'missing_capability'
]);
const USER_REPORT_TEXT_FIELDS = [
  'current_behavior',
  'desired_behavior',
  'business_reason'
];
const MAX_VIEW_HEADINGS = 8;
const MAX_VIEW_TEXT_LEN = 160;
const ALLOWED_DURING_FIELDS = new Set([
  'error',
  'failed_request',
  'screenshot_attachment_id',
  'user_report'
]);
const ALLOWED_ERROR_FIELDS = new Set([
  'kind',
  'message',
  'name',
  'stack_top'
]);
const ALLOWED_FAILED_REQUEST_FIELDS = new Set([
  'fn',
  'route',
  'status'
]);
const ALLOWED_EXPECTED_FIELDS = new Set([
  'user_intent',
  'expected_outcome'
]);
const ALLOWED_TOP_FIELDS = new Set([
  'schema_version',
  'before',
  'during',
  'expected'
]);
/**
 * Validate, sanitise, and redact the envelope per section 2c.
 * Returns the cleaned envelope + redaction metadata.
 */ export function validateAndRedactEnvelope(raw) {
  let droppedFields = 0;
  let truncated = false;
  const envelope = {};
  // Copy only allowed top-level fields
  for (const key of Object.keys(raw)){
    if (ALLOWED_TOP_FIELDS.has(key)) {
      envelope[key] = raw[key];
    } else {
      droppedFields++;
    }
  }
  // schema_version passthrough (validated separately)
  envelope.schema_version = raw.schema_version;
  // --- BEFORE segment ---
  const rawBefore = typeof raw.before === 'object' && raw.before !== null && !Array.isArray(raw.before) ? raw.before : undefined;
  if (rawBefore) {
    const before = {};
    for (const key of Object.keys(rawBefore)){
      if (ALLOWED_BEFORE_FIELDS.has(key)) {
        before[key] = rawBefore[key];
      } else {
        droppedFields++;
      }
    }
    // Enforce recent_actions limit
    if (Array.isArray(before.recent_actions)) {
      const actions = before.recent_actions;
      // Validate each action is a string; drop non-strings
      const validated = [];
      for (const a of actions){
        if (typeof a === 'string') {
          validated.push(a);
        } else {
          droppedFields++;
        }
      }
      if (validated.length > MAX_RECENT_ACTIONS) {
        before.recent_actions = validated.slice(0, MAX_RECENT_ACTIONS);
        truncated = true;
      } else {
        before.recent_actions = validated;
      }
    }
    for (const key of ['view_title', 'active_tab', 'workspace', 'viewport']) {
      if (key in before) {
        if (typeof before[key] !== 'string') {
          delete before[key];
          droppedFields++;
        } else if (before[key].length > MAX_VIEW_TEXT_LEN) {
          before[key] = before[key].slice(0, MAX_VIEW_TEXT_LEN);
          truncated = true;
        }
      }
    }
    if ('view_headings' in before) {
      if (!Array.isArray(before.view_headings)) {
        delete before.view_headings;
        droppedFields++;
      } else {
        const headings = before.view_headings.filter((item) => typeof item === 'string').map((item) => item.slice(0, MAX_VIEW_TEXT_LEN));
        if (headings.length !== before.view_headings.length) droppedFields++;
        if (headings.length > MAX_VIEW_HEADINGS) truncated = true;
        before.view_headings = headings.slice(0, MAX_VIEW_HEADINGS);
      }
    }
    envelope.before = before;
  }
  // --- DURING segment ---
  const rawDuring = typeof raw.during === 'object' && raw.during !== null && !Array.isArray(raw.during) ? raw.during : undefined;
  if (rawDuring) {
    const during = {};
    for (const key of Object.keys(rawDuring)){
      if (ALLOWED_DURING_FIELDS.has(key)) {
        during[key] = rawDuring[key];
      } else {
        droppedFields++;
      }
    }
    // Validate error sub-object
    if (typeof during.error === 'object' && during.error !== null && !Array.isArray(during.error)) {
      const rawError = during.error;
      const error = {};
      for (const key of Object.keys(rawError)){
        if (ALLOWED_ERROR_FIELDS.has(key)) {
          error[key] = rawError[key];
        } else {
          droppedFields++;
        }
      }
      // Truncate error.message
      if (typeof error.message === 'string' && error.message.length > MAX_ERROR_MESSAGE_LEN) {
        error.message = error.message.slice(0, MAX_ERROR_MESSAGE_LEN);
        truncated = true;
      }
      // Truncate stack_top to max frames
      if (Array.isArray(error.stack_top)) {
        const frames = error.stack_top;
        if (frames.length > MAX_STACK_TOP_FRAMES) {
          error.stack_top = frames.slice(0, MAX_STACK_TOP_FRAMES);
          truncated = true;
        }
      }
      during.error = error;
    }
    // Validate failed_request sub-object
    if (typeof during.failed_request === 'object' && during.failed_request !== null && !Array.isArray(during.failed_request)) {
      const rawReq = during.failed_request;
      const req = {};
      for (const key of Object.keys(rawReq)){
        if (ALLOWED_FAILED_REQUEST_FIELDS.has(key)) {
          req[key] = rawReq[key];
        } else {
          droppedFields++;
        }
      }
      during.failed_request = req;
    }
    // A person's own change request: closed field set, bounded text, known kinds only.
    if ('user_report' in during) {
      const rawReport = during.user_report;
      if (typeof rawReport !== 'object' || rawReport === null || Array.isArray(rawReport) || !USER_REPORT_KINDS.has(String(rawReport.kind))) {
        delete during.user_report;
        droppedFields++;
      } else {
        const report = { kind: String(rawReport.kind) };
        for (const key of Object.keys(rawReport)) {
          if (key !== 'kind' && !USER_REPORT_TEXT_FIELDS.includes(key)) droppedFields++;
        }
        for (const key of USER_REPORT_TEXT_FIELDS) {
          const value = rawReport[key];
          if (typeof value !== 'string' || !value.trim()) continue;
          report[key] = value.trim().slice(0, MAX_TEXT_FIELD_LEN);
          if (value.trim().length > MAX_TEXT_FIELD_LEN) truncated = true;
        }
        during.user_report = report;
      }
    }
    envelope.during = during;
  }
  // --- EXPECTED segment ---
  const rawExpected = typeof raw.expected === 'object' && raw.expected !== null && !Array.isArray(raw.expected) ? raw.expected : undefined;
  if (rawExpected) {
    const expected = {};
    for (const key of Object.keys(rawExpected)){
      if (ALLOWED_EXPECTED_FIELDS.has(key)) {
        expected[key] = rawExpected[key];
      } else {
        droppedFields++;
      }
    }
    // Truncate text fields
    if (typeof expected.user_intent === 'string' && expected.user_intent.length > MAX_TEXT_FIELD_LEN) {
      expected.user_intent = expected.user_intent.slice(0, MAX_TEXT_FIELD_LEN);
      truncated = true;
    }
    if (typeof expected.expected_outcome === 'string' && expected.expected_outcome.length > MAX_TEXT_FIELD_LEN) {
      expected.expected_outcome = expected.expected_outcome.slice(0, MAX_TEXT_FIELD_LEN);
      truncated = true;
    }
    envelope.expected = expected;
  }
  // --- Re-verify redaction (defence-in-depth, section 2c) ---
  const recheck = reVerifyRedaction(envelope);
  droppedFields += recheck.extraDropped;
  return {
    envelope,
    redaction: {
      dropped_fields: droppedFields,
      truncated
    }
  };
}
/**
 * Defence-in-depth re-verification: scan the cleaned envelope for any
 * field that should not be present (e.g. failed_request.body).
 */ function reVerifyRedaction(envelope) {
  let extraDropped = 0;
  const during = envelope.during;
  if (during && typeof during.failed_request === 'object' && during.failed_request !== null) {
    const req = during.failed_request;
    if ('body' in req) {
      delete req.body;
      extraDropped++;
    }
    if ('response_body' in req) {
      delete req.response_body;
      extraDropped++;
    }
  }
  return {
    extraDropped
  };
}
// ---------------------------------------------------------------------------
// Stop-line screen (section 4a -- evaluated FIRST, before classification)
// ---------------------------------------------------------------------------
/**
 * Screen the envelope for stop-line conditions. If any fires, the packet
 * goes straight to grand_master_bell with no self-heal route.
 */ export function screenStopLines(envelope) {
  const codes = [];
  const during = envelope.during;
  const before = envelope.before;
  const error = during?.error;
  // 1. Privacy / entitlement anomaly
  const errorMsg = String(error?.message ?? '').toLowerCase();
  const errorKind = String(error?.kind ?? '').toLowerCase();
  const errorName = String(error?.name ?? '').toLowerCase();
  const report = during?.user_report;
  const reportText = report ? USER_REPORT_TEXT_FIELDS.map((key) => String(report[key] ?? '')).join(' ').toLowerCase() : '';
  const allErrorText = errorMsg + ' ' + errorKind + ' ' + errorName + ' ' + reportText;
  if (allErrorText.includes('cross-org') || allErrorText.includes('cross_org') || allErrorText.includes('entitlement') || allErrorText.includes('tenant_leak') || allErrorText.includes('tenant leak') || allErrorText.includes('unauthorized_access') || allErrorText.includes('scope_violation') || allErrorText.includes('egress_redaction') || allErrorText.includes('privacy_breach')) {
    codes.push('stop_line:privacy');
  }
  // 2. HSWA safety signal
  if (allErrorText.includes('safety') || allErrorText.includes('hswa') || allErrorText.includes('duty_to_warn') || allErrorText.includes('duty-to-warn') || allErrorText.includes('harm') || allErrorText.includes('injury')) {
    codes.push('stop_line:safety');
  }
  // 3. Repeated failure pattern (recent_actions with repeated error labels)
  if (before && Array.isArray(before.recent_actions)) {
    const actions = before.recent_actions;
    const errorActions = actions.filter((a)=>a.startsWith('error:') || a.startsWith('failure:'));
    if (errorActions.length >= 3) {
      const counts = new Map();
      for (const a of errorActions){
        counts.set(a, (counts.get(a) ?? 0) + 1);
      }
      for (const [, count] of counts){
        if (count >= 3) {
          codes.push('stop_line:repeated_failure');
          break;
        }
      }
    }
  }
  // 4. Substrate failure (the capture substrate itself failed)
  if (errorKind === 'substrate_failure' || errorKind === 'capture_failure') {
    codes.push('stop_line:substrate_failure');
  }
  // 5. Unknown with consequence (enforcement / legal / evidence-bearing surface)
  const page = String(before?.page ?? '').toLowerCase();
  if ((page.includes('enforcement') || page.includes('legal') || page.includes('evidence') || page.includes('notice') || page.includes('prosecution')) && errorKind !== '' && errorKind !== 'undefined') {
    codes.push('stop_line:unknown_with_consequence');
  }
  if (codes.length === 0) {
    return {
      hit: null,
      reason_codes: []
    };
  }
  return {
    hit: codes[0],
    reason_codes: codes
  };
}
// ---------------------------------------------------------------------------
// Classification: rules-first, model-fallback (section 6, decision A)
// ---------------------------------------------------------------------------
/**
 * Deterministic rules-based classifier. Catches stop-lines + clear cases.
 * Returns null when the case is ambiguous (model fallback needed).
 */ export function classifyByRules(envelope) {
  const before = envelope.before;
  const during = envelope.during;
  const expected = envelope.expected;
  const error = during?.error;
  const failedReq = during?.failed_request;
  const reasonCodes = [];
  // --- Empty envelope checks ---
  const hasBefore = before !== undefined && Object.keys(before).length > 0;
  const hasDuring = during !== undefined && Object.keys(during).length > 0;
  const hasExpected = expected !== undefined && Object.keys(expected).length > 0;
  if (!hasBefore && !hasDuring && !hasExpected) {
    return {
      triage: 'unknown',
      basis: {
        reason_codes: [
          'empty:before',
          'empty:during',
          'empty:expected'
        ],
        summary: 'All envelope segments are empty or absent. Cannot classify without evidence.'
      },
      confidence: null
    };
  }
  // Check for absent segments
  const missingSegments = [];
  if (!hasBefore) missingSegments.push('empty:before');
  if (!hasDuring) missingSegments.push('empty:during');
  if (!hasExpected) missingSegments.push('empty:expected');
  // If during is absent, we cannot classify -- fail closed
  if (!hasDuring) {
    return {
      triage: 'unknown',
      basis: {
        reason_codes: missingSegments,
        summary: 'The during segment is absent. Cannot classify without knowing what happened.'
      },
      confidence: null
    };
  }
  // --- A person's own change request (no runtime error): a UX gap for human-led review ---
  const userReport = during?.user_report;
  if (userReport && !(error && (error.kind || error.message || error.name))) {
    const described = USER_REPORT_TEXT_FIELDS.filter((key) => typeof userReport[key] === 'string' && userReport[key].length > 0);
    if (described.includes('desired_behavior')) {
      return {
        triage: 'ux_gap',
        basis: {
          reason_codes: [
            'user_change_request:' + String(userReport.kind),
            ...described.map((key) => 'described:' + key),
            ...missingSegments
          ],
          summary: 'A person asked for a change to ' + String(before?.page ?? 'an unknown page') + '. Human-led review; never an unattended repair.'
        },
        confidence: 0.9
      };
    }
  }
  // --- Clear error present: likely a bug ---
  const hasError = error && (error.kind || error.message || error.name);
  const hasFailedRequest = failedReq && (failedReq.fn || failedReq.route || failedReq.status);
  if (hasError) {
    reasonCodes.push('error_present');
    const status = hasFailedRequest ? Number(failedReq.status) : 0;
    // Network failure with a clear HTTP error
    if (hasFailedRequest && status >= 400) {
      reasonCodes.push('http_error_' + String(status));
      if (status >= 500) {
        return {
          triage: 'bug',
          basis: {
            reason_codes: [
              ...reasonCodes,
              ...missingSegments
            ],
            summary: 'Server error (HTTP ' + String(status) + ') on ' + String(failedReq.fn ?? failedReq.route ?? 'unknown') + '. Deterministic classification: bug.'
          },
          confidence: 0.92
        };
      }
      if (status === 404) {
        return {
          triage: 'bug',
          basis: {
            reason_codes: [
              ...reasonCodes,
              ...missingSegments
            ],
            summary: 'Resource not found (HTTP 404) on ' + String(failedReq.fn ?? failedReq.route ?? 'unknown') + '. Likely a routing or deployment bug.'
          },
          confidence: 0.88
        };
      }
      if (status === 403 || status === 401) {
        return {
          triage: 'data_problem',
          basis: {
            reason_codes: [
              ...reasonCodes,
              'auth_error',
              ...missingSegments
            ],
            summary: 'Authentication/authorization error (HTTP ' + String(status) + '). May be a permission or entitlement issue.'
          },
          confidence: 0.70
        };
      }
    }
    // Exception / render failure / rejection
    const errorKind = String(error.kind ?? '').toLowerCase();
    if (errorKind === 'exception' || errorKind === 'render_failure' || errorKind === 'unhandled_rejection') {
      return {
        triage: 'bug',
        basis: {
          reason_codes: [
            ...reasonCodes,
            'exception_' + errorKind,
            ...missingSegments
          ],
          summary: 'Unhandled ' + errorKind + ': ' + String(error.message ?? '').slice(0, 200) + '. Deterministic classification: bug.'
        },
        confidence: 0.90
      };
    }
    // Network failure without specific status
    if (errorKind === 'network_failure') {
      return {
        triage: 'bug',
        basis: {
          reason_codes: [
            ...reasonCodes,
            'network_failure',
            ...missingSegments
          ],
          summary: 'Network failure detected. Likely an infrastructure or connectivity bug.'
        },
        confidence: 0.75
      };
    }
    // Generic error present but kind is not clearly classifiable
    if (missingSegments.length === 0) {
      return {
        triage: 'bug',
        basis: {
          reason_codes: [
            ...reasonCodes,
            ...missingSegments
          ],
          summary: 'Error present with full context. Classified as bug with moderate confidence.'
        },
        confidence: 0.80
      };
    }
  }
  // --- No error but user reports friction (expected segment present, during has no error) ---
  if (!hasError && hasExpected) {
    const intent = String(expected.user_intent ?? '').toLowerCase();
    if (intent.includes('how do i') || intent.includes('how to') || intent.includes('where is') || intent.includes('cannot find') || intent.includes('help me') || intent.includes('confused')) {
      return {
        triage: 'misunderstanding',
        basis: {
          reason_codes: [
            'user_guidance_needed',
            ...missingSegments
          ],
          summary: 'User appears to need guidance rather than reporting a system fault.'
        },
        confidence: 0.80
      };
    }
  }
  // --- Ambiguous: fall through to model (or fail-closed if no model) ---
  if (missingSegments.length > 0) {
    return {
      triage: 'unknown',
      basis: {
        reason_codes: [
          ...reasonCodes.length > 0 ? reasonCodes : [
            'insufficient_evidence'
          ],
          ...missingSegments
        ],
        summary: 'Envelope segments missing (' + missingSegments.join(', ') + '). Cannot classify with confidence.'
      },
      confidence: null
    };
  }
  // Has all segments but rules could not clearly classify
  return null;
}
/**
 * Model fallback classifier. In this first slice, the model is not wired --
 * returns a fail-closed unknown verdict.
 */ export function classifyByModel(_envelope) {
  return {
    triage: 'unknown',
    basis: {
      reason_codes: [
        'model_fallback_not_available'
      ],
      summary: 'Rules could not classify and the model fallback is not yet wired. Fail-closed to unknown.'
    },
    confidence: null
  };
}
// ---------------------------------------------------------------------------
// Routing decision table (section 2a)
// ---------------------------------------------------------------------------
/**
 * Derive the route from stop_line_hit x triage x confidence per the
 * section 2a decision table.
 *
 * HARD INVARIANT (section 2f): if stop_line_hit is non-null, route is
 * ALWAYS grand_master_bell.
 */ export function deriveRoute(stopLineHit, triage, confidence) {
  // Section 2f invariant: stop-line overrides everything
  if (stopLineHit !== null) {
    return 'grand_master_bell';
  }
  // unknown never self-heals, never answers-as-resolved
  if (triage === 'unknown') {
    return 'grand_master_bell';
  }

  // misunderstanding -> answer_user
  if (triage === 'misunderstanding') {
    return 'answer_user';
  }
  // ux_gap -> self_heal_apparatus (analysis/proposal; never auto-UI)
  if (triage === 'ux_gap') {
    return 'self_heal_apparatus';
  }
  // bug / data_problem: confidence-gated
  // null confidence treated as < 0.50 (fail-closed, section 2d)
  const conf = confidence ?? -1;
  if (conf >= 0.85) {
    return 'dispatch_flow';
  }
  if (conf >= 0.50) {
    return 'self_heal_apparatus';
  }
  return 'grand_master_bell';
}

/**
 * Classify the consequence of starting repair work. This is deliberately
 * narrower than bug triage: only a high-confidence, non-consequential software
 * fault is routine. New capability, redesign, protected-path, privacy, safety,
 * legal, financial, identity, enforcement, and uncertain work stays human-led.
 */
function envelopeValues(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(envelopeValues).join(' ');
  if (value && typeof value === 'object') return Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'schema_version').map(([, item]) => envelopeValues(item)).join(' ');
  return '';
}

export function classifyRepairRisk(envelope, stopLineHit, triage, confidence, route) {
  if (stopLineHit !== null) return 'protected';
  const protectedTerms = [
    'privacy', 'tenant', 'cross-org', 'cross_org', 'entitlement', 'safety', 'hswa',
    'legal', 'evidence', 'enforcement', 'notice', 'prosecution', 'identity', 'auth',
    'rls', 'permission', 'payroll', 'finance', 'payment', 'invoice', 'migration',
    'schema', 'database', 'dependency', 'environment', 'secret', 'credential'
  ];
  // A person's change request is never routine: it waits for a reviewer, as protected when it
  // touches a consequential surface.
  if (envelope?.during?.user_report) {
    // Values only: envelope keys (schema_version, user_intent…) must not trip the term list.
    const text = envelopeValues(envelope).toLowerCase();
    return protectedTerms.some((term) => text.includes(term)) ? 'protected' : 'significant';
  }
  if (triage !== 'bug' || route !== 'dispatch_flow' || (confidence ?? -1) < 0.85) return 'unknown';

  // Values only: the persisted envelope always carries the "schema_version" key, which would
  // otherwise trip the "schema" term and make every monitored defect protected.
  const text = envelopeValues(envelope).toLowerCase();
  if (protectedTerms.some((term) => text.includes(term))) return 'protected';

  const significantTerms = [
    'redesign', 'new build', 'new feature', 'new module', 'new workflow',
    'architecture', 'replace the page', 'rebuild the page', 'invent'
  ];
  if (significantTerms.some((term) => text.includes(term))) return 'significant';

  const errorKind = String(envelope?.during?.error?.kind ?? '').toLowerCase();
  const status = Number(envelope?.during?.failed_request?.status ?? 0);
  const routineError = ['exception', 'render_failure', 'unhandled_rejection'].includes(errorKind)
    || status === 404
    || status >= 500;
  return routineError ? 'routine' : 'unknown';
}
