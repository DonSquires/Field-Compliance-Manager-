/**
 * safetyWarnings.ts — pure helpers for the platform-wide health-and-safety
 * warning read model (get_safety_warnings / raise_entity_flag /
 * resolve_entity_flag, migration 20260916100000).
 *
 * Owner ruling (ORG_SERVICE_MODEL.md, H&S exception): a hazard one
 * organisation has recorded against a vehicle, person or place is visible to
 * every organisation on the platform, redacted to the hazard class, severity,
 * the raising organisation and its contact path. The narrative stays with the
 * organisation that wrote it.
 */

export type SafetyEntityType = 'vehicle' | 'person' | 'place' | 'site' | 'zone';

export type SafetyAlertLevel = 'low' | 'medium' | 'high' | 'critical';

export interface SafetyWarning {
  id: string;
  entity_type: string;
  entity_id: string;
  requested_id: string;
  hazard_class: string;
  alert_level: SafetyAlertLevel | string;
  raised_at: string;
  organization_id: string;
  organization_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  is_own_organization: boolean;
  /** Only present for the raising organisation. */
  reason: string | null;
}

/** Mirrors entity_flags_hazard_class_check — keep in step with the migration. */
export const SAFETY_HAZARD_CLASSES: ReadonlyArray<{ value: string; label: string; hint: string }> = [
  { value: 'violence_or_aggression', label: 'Violence or aggression', hint: 'Threats, assault, intimidation towards staff.' },
  { value: 'weapons', label: 'Weapons', hint: 'A weapon has been seen or used.' },
  { value: 'dangerous_dog', label: 'Dangerous dog', hint: 'An uncontrolled or aggressive animal on site or in the vehicle.' },
  { value: 'hazardous_substances', label: 'Hazardous substances', hint: 'Chemicals, gas, fuel, needles or contamination.' },
  { value: 'unsafe_structure_or_ground', label: 'Unsafe structure or ground', hint: 'Collapse risk, holes, unstable surfaces, live wiring.' },
  { value: 'vehicle_defect', label: 'Vehicle defect', hint: 'A defect that endangers people around the vehicle.' },
  { value: 'medical_or_welfare', label: 'Medical or welfare', hint: 'A person may need medical or welfare support — approach with care.' },
  { value: 'other', label: 'Other hazard', hint: 'Anything else staff should know before they approach.' },
];

export const SAFETY_ALERT_LEVELS: ReadonlyArray<{ value: SafetyAlertLevel; label: string }> = [
  { value: 'low', label: 'Low — be aware' },
  { value: 'medium', label: 'Medium — take care' },
  { value: 'high', label: 'High — do not attend alone' },
  { value: 'critical', label: 'Critical — do not approach, call for support' },
];

export function hazardClassLabel(value: string | null | undefined): string {
  if (!value) return 'Hazard';
  return SAFETY_HAZARD_CLASSES.find((entry) => entry.value === value)?.label ?? value.replace(/_/g, ' ');
}

export function alertLevelLabel(value: string | null | undefined): string {
  return SAFETY_ALERT_LEVELS.find((entry) => entry.value === value)?.label ?? (value ?? 'unrated');
}

/** Badge tone: high/critical are danger, the rest warning. */
export function safetyWarningTone(level: string | null | undefined): 'danger' | 'warning' {
  return level === 'critical' || level === 'high' ? 'danger' : 'warning';
}

/** The strongest severity across a set of warnings, or null when there are none. */
export function highestAlertLevel(warnings: ReadonlyArray<Pick<SafetyWarning, 'alert_level'>>): SafetyAlertLevel | null {
  const order: SafetyAlertLevel[] = ['critical', 'high', 'medium', 'low'];
  for (const level of order) {
    if (warnings.some((warning) => warning.alert_level === level)) return level;
  }
  return warnings.length > 0 ? 'low' : null;
}

/** What another organisation is allowed to see, spelled out for the UI. */
export function describeWarningSource(warning: Pick<SafetyWarning, 'organization_name' | 'is_own_organization'>): string {
  if (warning.is_own_organization) return 'Raised by your organisation';
  return `Raised by ${warning.organization_name ?? 'another organisation'}`;
}

/** Contact path for the raising organisation (only meaningful for other organisations' warnings). */
export function warningContactPath(warning: Pick<SafetyWarning, 'contact_email' | 'contact_phone'>): string[] {
  return [warning.contact_phone, warning.contact_email].filter((value): value is string => Boolean(value && value.trim()));
}

export interface RaiseSafetyWarningInput {
  entityType: SafetyEntityType;
  entityId: string;
  hazardClass: string;
  alertLevel: SafetyAlertLevel;
  note: string;
}

export interface RaiseSafetyWarningArgs {
  p_client_request_id: string;
  p_entity_type: SafetyEntityType;
  p_entity_id: string;
  p_flag_type: 'safety_warning';
  p_alert_level: SafetyAlertLevel;
  p_reason: string;
  p_hazard_class: string;
}

/** Validate and shape the raise_entity_flag call. Throws a human message when the form is incomplete. */
export function buildRaiseSafetyWarningArgs(input: RaiseSafetyWarningInput, clientRequestId: string): RaiseSafetyWarningArgs {
  const note = input.note.trim();
  if (!SAFETY_HAZARD_CLASSES.some((entry) => entry.value === input.hazardClass)) {
    throw new Error('Choose the kind of hazard staff should expect.');
  }
  if (!SAFETY_ALERT_LEVELS.some((entry) => entry.value === input.alertLevel)) {
    throw new Error('Choose how serious the hazard is.');
  }
  if (note.length < 5) {
    throw new Error('Write a short note of what staff should expect (this stays inside your organisation).');
  }
  return {
    p_client_request_id: clientRequestId,
    p_entity_type: input.entityType,
    p_entity_id: input.entityId,
    p_flag_type: 'safety_warning',
    p_alert_level: input.alertLevel,
    p_reason: note,
    p_hazard_class: input.hazardClass,
  };
}
