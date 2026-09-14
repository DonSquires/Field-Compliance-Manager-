// Recovered reference source (NOT compiled or applied here). Origin: GitLab don-squires1/field-compliance-manager
// packages/shared/src/rateEngine.ts @ Main, read 2026-09-14 via scripts/gitlab-read.mjs. Re-implement against the live schema with tests before use.

/**
 * rateEngine.ts — Configurable rate resolver (Financial Automation Suite)
 *
 * Pure, dependency-free resolution logic shared between the web app, edge
 * functions and payroll/billing math. Mirrors the rate_rules / org_rate_settings
 * schema (migration 0079) and references the governed codes from reference_codes
 * (migration 0078).
 *
 * Two kinds of resolution:
 *   - 'pay'     — returns the SET of applicable pay lines for a shift (base ORD
 *                 + EA allowance + E1 EMS + ON on-call + 31 travel, etc.).
 *   - 'billing' — returns the single best-match charge (e.g. per_visit per site).
 *
 * Matching is by SPECIFICITY (how many dimensions a rule pins) then PRIORITY,
 * honouring time-effective dating (effective_from/effective_to) so historical
 * rate changes (e.g. travel $0.95 -> $1.17/km) resolve correctly by date.
 *
 * Money is rounded with bankers-safe cent rounding helpers. All figures NZD.
 */

export type RateRuleKind = 'pay' | 'billing';

export type RateType =
  | 'hourly'
  | 'flat'
  | 'daily'
  | 'per_km'
  | 'per_unit'
  | 'percentage'
  | 'per_hour_travel'
  | 'per_hour_allowance'
  | 'oncall_flat'
  | 'callout'
  | 'higher_duties_flat'
  | 'per_visit'
  | 'per_notice';

export type DayCategory = 'weekday' | 'weekend' | 'public_holiday' | 'night';

export interface RateRule {
  id: string;
  organizationId: string;
  ruleKind: RateRuleKind;
  name: string;
  rateType: RateType;
  amount: number;

  // code dimensions (null = wildcard / applies to all)
  payCode?: string | null;
  glAccount?: string | null;
  roleCode?: string | null;
  regionCode?: string | null;
  serviceType?: string | null;
  moduleKey?: string | null;
  jobCode?: string | null;
  jobType?: string | null;

  // targeting
  clientOrgId?: string | null;
  siteId?: string | null;
  zoneId?: string | null;

  // travel / vehicle
  vehicleType?: string | null;
  distanceMinKm?: number | null;
  distanceMaxKm?: number | null;
  outsideArea?: boolean | null;

  // temporal
  dayCategory?: DayCategory | null;
  effectiveFrom?: string | null; // YYYY-MM-DD
  effectiveTo?: string | null;   // YYYY-MM-DD

  priority: number;
  active: boolean;
}

/** Context describing the shift / visit being priced. */
export interface RateContext {
  date?: string;            // YYYY-MM-DD — used for effective-dating
  payCode?: string;
  glAccount?: string;
  roleCode?: string;
  regionCode?: string;
  serviceType?: string;
  moduleKey?: string;
  jobCode?: string;
  jobType?: string;
  clientOrgId?: string;
  siteId?: string;
  zoneId?: string;
  vehicleType?: string;
  distanceKm?: number;
  outsideArea?: boolean;
  dayCategory?: DayCategory;
}

/** Round to whole cents (avoids binary float drift on money). */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Format NZD currency. */
export function fmtNZD(amount: number): string {
  return new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD' }).format(amount);
}

const DIMENSION_KEYS: (keyof RateContext & keyof RateRule)[] = [
  'payCode', 'glAccount', 'roleCode', 'regionCode', 'serviceType',
  'moduleKey', 'jobCode', 'jobType', 'clientOrgId', 'siteId', 'zoneId',
  'vehicleType', 'dayCategory',
];

function withinEffective(rule: RateRule, date?: string): boolean {
  if (!date) return true;
  if (rule.effectiveFrom && date < rule.effectiveFrom) return false;
  if (rule.effectiveTo && date > rule.effectiveTo) return false;
  return true;
}

function withinDistance(rule: RateRule, distanceKm?: number): boolean {
  if (distanceKm == null) return rule.distanceMinKm == null && rule.distanceMaxKm == null ? true : true;
  if (rule.distanceMinKm != null && distanceKm < rule.distanceMinKm) return false;
  if (rule.distanceMaxKm != null && distanceKm > rule.distanceMaxKm) return false;
  return true;
}

/**
 * Does the rule match the context? A null/undefined rule dimension is a wildcard.
 * A set rule dimension must equal the context value; if the context lacks that
 * value, the rule does not match (it is more specific than the context supports).
 */
function matches(rule: RateRule, ctx: RateContext): boolean {
  if (!rule.active) return false;
  if (!withinEffective(rule, ctx.date)) return false;
  if (!withinDistance(rule, ctx.distanceKm)) return false;

  if (rule.outsideArea != null && rule.outsideArea !== (ctx.outsideArea ?? false)) return false;

  for (const key of DIMENSION_KEYS) {
    const rv = rule[key] as unknown;
    if (rv == null) continue;                 // wildcard
    const cv = ctx[key] as unknown;
    if (cv == null || cv !== rv) return false;
  }
  return true;
}

/** Specificity = number of pinned (non-wildcard) dimensions + distance/effective bonuses. */
function specificity(rule: RateRule): number {
  let score = 0;
  for (const key of DIMENSION_KEYS) {
    if (rule[key] != null) score++;
  }
  if (rule.distanceMinKm != null || rule.distanceMaxKm != null) score++;
  if (rule.outsideArea != null) score++;
  if (rule.effectiveFrom != null || rule.effectiveTo != null) score++;
  return score;
}

/** Sort: most specific first, then highest priority, then most recent effectiveFrom. */
function compareBest(a: RateRule, b: RateRule): number {
  const s = specificity(b) - specificity(a);
  if (s !== 0) return s;
  const p = b.priority - a.priority;
  if (p !== 0) return p;
  const af = a.effectiveFrom ?? '';
  const bf = b.effectiveFrom ?? '';
  return bf.localeCompare(af);
}

/**
 * Resolve the single best matching rule (used for billing, or a specific pay line).
 * Returns null if nothing matches.
 */
export function resolveRate(
  rules: RateRule[],
  kind: RateRuleKind,
  ctx: RateContext,
): RateRule | null {
  const candidates = rules
    .filter(r => r.ruleKind === kind && matches(r, ctx))
    .sort(compareBest);
  return candidates[0] ?? null;
}

/**
 * Resolve the full SET of pay lines for a shift: the best rule per distinct
 * payCode that matches. This is how one shift yields base + allowance + EMS +
 * on-call + travel lines simultaneously.
 */
export function resolvePayLines(rules: RateRule[], ctx: RateContext): RateRule[] {
  const matching = rules.filter(r => r.ruleKind === 'pay' && matches(r, ctx));
  const byCode = new Map<string, RateRule>();
  for (const rule of matching) {
    const code = rule.payCode ?? '__base__';
    const current = byCode.get(code);
    if (!current || compareBest(rule, current) < 0) {
      byCode.set(code, rule);
    }
  }
  return [...byCode.values()];
}

/** A computed amount for one resolved line. */
export interface RatedLine {
  rule: RateRule;
  quantity: number;
  amount: number; // round2(rate * quantity) or flat
}

/**
 * Apply a resolved rule to a quantity, producing a money amount.
 * Flat / on-call / higher-duties rules ignore quantity (return the flat amount,
 * optionally multiplied by whole blocks for oncall_flat).
 */
export function applyRate(rule: RateRule, quantity = 1): RatedLine {
  let amount: number;
  switch (rule.rateType) {
    case 'flat':
    case 'higher_duties_flat':
      amount = rule.amount;
      break;
    case 'oncall_flat':
      // amount is per block; quantity = number of blocks (e.g. nights)
      amount = rule.amount * quantity;
      break;
    case 'percentage':
      // amount is a fraction (e.g. 0.15); quantity is the base value
      amount = quantity * rule.amount;
      break;
    default:
      // hourly, per_km, per_unit, per_visit, per_notice, callout, allowances, travel
      amount = rule.amount * quantity;
  }
  return { rule, quantity, amount: round2(amount) };
}

/** Sum rated lines. */
export function sumLines(lines: RatedLine[]): number {
  return round2(lines.reduce((s, l) => s + l.amount, 0));
}
