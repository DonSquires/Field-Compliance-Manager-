/**
 * Domain-neutral Oracle truth-state builder.
 * Oracle describes the turn and candidate effect; it never selects or permits.
 */
const EFFECT_CLASSES = new Set([
  'internal_observation',
  'disclosure_egress',
  'safety_signal',
  'draft_governed_write',
  'direct_world_change',
  'admin_diagnostic_substrate_action',
]);

const PROOF_GRADES = new Set(['unknown', 'alleged', 'inferred', 'observed', 'determined']);

export function normalizeEffectClass(value: unknown) {
  return typeof value === 'string' && EFFECT_CLASSES.has(value)
    ? value
    : 'internal_observation';
}

export function normalizeProofGrade(value: unknown) {
  return typeof value === 'string' && PROOF_GRADES.has(value)
    ? value
    : 'unknown';
}

export function buildOracleTurnTruthState(input: {
  explicit_hold?: unknown;
  effect_class?: unknown;
  turn_scope?: unknown;
  proof_grade?: unknown;
  domain_state?: Record<string, unknown> | null;
}) {
  return {
    explicit_hold: input.explicit_hold === true,
    effect_class: normalizeEffectClass(input.effect_class),
    turn_scope: input.turn_scope ?? null,
    proof_grade: normalizeProofGrade(input.proof_grade),
    domain_state: input.domain_state ?? null,
  };
}
