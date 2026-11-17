import { supabase } from './supabase';

export interface Season {
  season_key: string;
  label: string;
  months: number[];
}

export type PlaceServiceDays =
  | { mode: 'fixed'; weekdays: number[] }
  | { mode: 'random'; per_week: number; allowed: number[] };

export type PlaceServiceEndpoint =
  | { anchor: 'clock'; time: string; offset_hours?: number }
  | { anchor: 'sunrise' | 'sunset'; offset_hours: number };

export type PlaceServiceWindow =
  | { mode: 'any' }
  | { mode: 'fixed'; start: string; end: string }
  | { mode: 'solar'; start: PlaceServiceEndpoint; end: PlaceServiceEndpoint };

export interface PlaceServiceTerms {
  anchor: { site_id: string | null; zone_id: string | null };
  module_key: string;
  days: PlaceServiceDays;
  window: PlaceServiceWindow;
  months: number[];
  visits_per_shift: number;
  min_gap_minutes: number;
  dwell_minutes: number;
  checks: string[];
  officer_instructions: string | null;
}

export interface StaticPostTerms {
  post_name: string;
  operating_organization_id: string;
  required_skill_ids?: string[];
  required_skill_names?: string[];
  site_id?: string | null;
  zone_id?: string | null;
  work_unit_id?: string;
}

export interface PlaceServicePending {
  version_id: string;
  change_kind: 'create' | 'update' | 'end';
  effective_from: string;
  terms: PlaceServiceTerms | StaticPostTerms;
  requested_by: string;
  requested_by_name: string | null;
}

export const placeServiceChangeLabels: Record<PlaceServicePending['change_kind'], string> = {
  create: 'New service', update: 'Update', end: 'End service',
};

export interface PlaceService {
  delivery_schedule_id: string | null;
  service_agreement_id: string;
  service_kind: 'patrol' | 'static_guarding';
  module_key: string;
  anchor: PlaceServiceTerms['anchor'];
  active: boolean;
  terms: PlaceServiceTerms | StaticPostTerms | null;
  effective_from: string | null;
  pending: PlaceServicePending | null;
  responsibility: { work_unit_id: string; work_unit_name: string | null; patrol_route_id: string; effective_from: string } | null;
  work_unit: { id: string; name: string; active: boolean } | null;
}

export interface PlaceServicesWorkspace {
  location: { id: string; name: string; organization_id: string } | null;
  anchors: Array<{ kind: 'site' | 'zone'; id: string; name: string; has_point: boolean }>;
  agreements: Array<{ id: string; provider_organization_id: string; name: string }>;
  services: PlaceService[];
  modules: Array<{ module_key: string; toolset_key: string }>;
  check_types: Array<{ id: string; check_key: string; label: string; needs_photo: boolean; needs_note: boolean; is_global: boolean }>;
  inactive_check_types?: Array<{ id: string; check_key: string; label: string; needs_photo: boolean; needs_note: boolean; is_global: boolean }>;
  seasons: Season[];
  operating_branches: Array<{ id: string; name: string }>;
  settings: {
    place_changes_need_second_approver: boolean;
    branches_may_set_up_static_posts: boolean;
    other_approver_available: boolean;
  } | null;
  can_manage: boolean;
}

export interface PlaceServiceChangeInput {
  locationId: string;
  agreementId: string;
  deliveryScheduleId: string | null;
  changeKind: 'create' | 'update' | 'end';
  terms: PlaceServiceTerms | null;
  effectiveFrom: string;
}

export interface PlaceServicePreview {
  normalised_terms: PlaceServiceTerms;
  applies_from: string;
  needs_approval: boolean;
  affected: Array<{ shift_id: string; date: string; work_unit_name: string | null; scheduled_start: string; scheduled_end: string; status: string; updated_at: string }>;
  blocked: Array<{ shift_id: string; date: string; reason: string }>;
  next_days: Array<{ date: string; patrols: number | null; window_open: string | null; window_close: string | null; covered: boolean }>;
  warnings: string[];
  preview_fingerprint: string;
}

export interface PlaceServiceSaveResult {
  version_id: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  applied_effective_from: string | null;
  delivery_schedule_id: string | null;
  replayed?: boolean;
}

export interface StaticPostResult {
  version_id: string;
  status: 'pending' | 'approved';
  work_unit_id: string | null;
  replayed?: boolean;
}

async function callRpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    if (error.code === 'PGRST202' || /could not find the function/i.test(error.message ?? '')) {
      throw new Error('Place services are not available yet. The database update for this screen has not been released.');
    }
    throw new Error(error.message);
  }
  if (data === null) throw new Error(`No response from ${name}`);
  return data as T;
}

function changeArgs(input: PlaceServiceChangeInput) {
  return {
    p_location_id: input.locationId,
    p_agreement_id: input.agreementId,
    p_delivery_schedule_id: input.deliveryScheduleId,
    p_change_kind: input.changeKind,
    p_terms: input.terms,
    p_effective_from: input.effectiveFrom,
  };
}

export function fetchPlaceServices(locationId: string): Promise<PlaceServicesWorkspace> {
  return callRpc('get_place_services', { p_location_id: locationId });
}

export function previewPlaceServiceChange(input: PlaceServiceChangeInput): Promise<PlaceServicePreview> {
  return callRpc('preview_place_service_change', changeArgs(input));
}

export function savePlaceServiceChange(input: PlaceServiceChangeInput & {
  requestId: string; reason: string; previewFingerprint: string;
}): Promise<PlaceServiceSaveResult> {
  return callRpc('save_place_service_change', {
    p_client_request_id: input.requestId, ...changeArgs(input),
    p_reason: input.reason, p_preview_fingerprint: input.previewFingerprint,
  });
}

export function decidePlaceServiceChange(
  versionId: string, decision: 'approve' | 'reject' | 'withdraw', reason: string, requestId: string,
): Promise<PlaceServiceSaveResult> {
  return callRpc('decide_place_service_change', {
    p_client_request_id: requestId, p_version_id: versionId, p_decision: decision, p_reason: reason,
  });
}

export function addStaticPost(input: {
  requestId: string; locationId: string; agreementId: string; siteId: string | null; zoneId: string | null;
  postName: string; operatingOrganizationId: string; requiredSkillIds: string[]; reason: string;
}): Promise<StaticPostResult> {
  return callRpc('add_place_static_post', {
    p_client_request_id: input.requestId, p_location_id: input.locationId, p_agreement_id: input.agreementId,
    p_site_id: input.siteId, p_zone_id: input.zoneId, p_post_name: input.postName,
    p_operating_organization_id: input.operatingOrganizationId, p_required_skill_ids: input.requiredSkillIds,
    p_reason: input.reason,
  });
}

export function endStaticPost(workUnitId: string, reason: string, requestId: string): Promise<StaticPostResult> {
  return callRpc('end_place_static_post', { p_client_request_id: requestId, p_work_unit_id: workUnitId, p_reason: reason });
}

export function manageCheckType(input: {
  requestId: string; action: 'create' | 'update' | 'deactivate' | 'reactivate'; organizationId: string; checkTypeId: string | null;
  label: string | null; needsPhoto: boolean | null; needsNote: boolean | null;
}): Promise<{ check_type_id: string; organization_id: string; check_key: string; label: string; needs_photo: boolean; needs_note: boolean; active: boolean; reactivated?: boolean }> {
  return callRpc('manage_patrol_check_type', {
    p_client_request_id: input.requestId, p_action: input.action, p_organization_id: input.organizationId,
    p_check_type_id: input.checkTypeId, p_label: input.label, p_needs_photo: input.needsPhoto, p_needs_note: input.needsNote,
  });
}

export function setOperatingSetting(
  organizationId: string,
  setting: 'place_changes_need_second_approver' | 'branches_may_set_up_static_posts',
  value: boolean,
  requestId: string,
): Promise<{ organization_id: string; setting: string; from: boolean; to: boolean }> {
  return callRpc('set_organization_operating_setting', {
    p_client_request_id: requestId, p_organization_id: organizationId, p_setting: setting, p_value: value,
  });
}

export interface OperatingSkill { id: string; skill_name: string; skill_category: string | null }

export async function fetchOperatingSkills(organizationId: string): Promise<OperatingSkill[]> {
  const { data, error } = await supabase.from('roster_skill_catalog').select('id,skill_name,skill_category')
    .eq('organization_id', organizationId).eq('active', true).order('skill_name');
  if (error) throw new Error(error.message);
  return (data ?? []) as OperatingSkill[];
}

export interface PatrolBillingUnit { code: string; label: string; rate_type: string; active: boolean }

export interface LocationBillingSelection {
  id: string; service_agreement_location_id: string; service_agreement_module_id: string | null;
  rate_type: string; source: 'agreement' | 'rate_rule'; rate_rule_id: string | null;
  billing_unit_code: string | null; effective_from: string; updated_at: string;
}

export interface LocationBillingWorkspace {
  provider_id: string;
  agreements: Array<{ id: string; name: string; currency: string; base_rate_per_hour: number | null }>;
  selections: LocationBillingSelection[];
  rates: Array<{ id: string; name: string; rate_type: string; amount: number }>;
}

export interface LocationPatrolConfig {
  id: string;
  organization_id: string;
  provider_organization_id: string;
  agreement_name: string;
  service_agreement_id: string;
  service_agreement_location_id: string;
  service_agreement_module_id: string;
  contracted_module_key: string;
  contractual_terms: { id: string };
  responsibilities: Array<{ id: string; patrol_route_id: string; work_unit_id: string; effective_from: string;
    effective_to: string | null; superseded_at: string | null }>;
}

export interface LocationPatrolSetup {
  location_id: string;
  service_date: string;
  version: string;
  configs: LocationPatrolConfig[];
  runs: Array<{ id: string; name: string; organization_id: string; is_active: boolean;
    work_units: Array<{ id: string; name: string }> }>;
  billing_workspaces: LocationBillingWorkspace[];
  billing_units: PatrolBillingUnit[];
}

export interface PatrolSetupBilling {
  source: 'agreement' | 'rate_rule';
  rate_type: string;
  billing_unit_code: string;
  rate_rule_id: string | null;
  new_rate: { name: string; amount: number } | null;
  expected_selection_id: string | null;
  expected_updated_at: string | null;
}

export interface PatrolSetupChanges {
  patrol_config_id: string;
  service_agreement_location_id: string;
  service_agreement_module_id: string;
  patrol_route_id: string;
  work_unit_id: string;
  effective_from: string;
  billing: PatrolSetupBilling;
}

export interface PatrolSetupPreview {
  version: string;
  preview_fingerprint: string;
  affected: Array<{ shift_id: string; status: string; scheduled_start: string; scheduled_end: string }>;
  blocked: Array<{ shift_id: string; status: string; scheduled_start: string; reason: string }>;
}

export function fetchLocationPatrolSetup(locationId: string): Promise<LocationPatrolSetup> {
  return callRpc('get_location_patrol_setup', { p_location_id: locationId });
}

export function previewLocationPatrolSetup(locationId: string, changes: PatrolSetupChanges): Promise<PatrolSetupPreview> {
  return callRpc('preview_location_patrol_setup', { p_location_id: locationId, p_changes: changes });
}

export function saveLocationPatrolSetup(input: {
  locationId: string; requestId: string; expectedVersion: string; previewFingerprint: string; changes: PatrolSetupChanges;
}): Promise<{ responsibility_id: string; replayed: boolean }> {
  return callRpc('save_location_patrol_setup', {
    p_location_id: input.locationId, p_client_request_id: input.requestId, p_expected_version: input.expectedVersion,
    p_preview_fingerprint: input.previewFingerprint, p_changes: input.changes,
  });
}

export function monthsForSeasons(seasons: Season[], keys: string[]): number[] {
  return [...new Set(seasons.filter(season => keys.includes(season.season_key)).flatMap(season => season.months))]
    .sort((a, b) => a - b);
}

const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function describeRange(values: number[], names: string[], circular = false): string {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  if (!sorted.length) return '';
  if (circular && sorted.length < names.length && sorted[0] === 1 && sorted[sorted.length - 1] === names.length) {
    const gap = sorted.findIndex((value, index) => index > 0 && value > sorted[index - 1] + 1);
    if (gap > 0) sorted.push(...sorted.splice(0, gap));
  }
  const groups: number[][] = [];
  for (const value of sorted) {
    const group = groups[groups.length - 1];
    if (group && (value === group[group.length - 1] + 1 || (circular && value === 1 && group[group.length - 1] === names.length))) {
      group.push(value);
    } else {
      groups.push([value]);
    }
  }
  return groups.map(group => group.length > 2
    ? `${names[group[0] - 1]}–${names[group[group.length - 1] - 1]}`
    : group.map(value => names[value - 1]).join(', ')).join(', ');
}

function describeEndpoint(endpoint: PlaceServiceEndpoint): string {
  if (endpoint.anchor === 'clock') return endpoint.time;
  if (!endpoint.offset_hours) return endpoint.anchor;
  return `${endpoint.anchor} ${endpoint.offset_hours < 0 ? '−' : '+'}${Math.abs(endpoint.offset_hours)} h`;
}

export function describeTerms(terms: PlaceServiceTerms, labels: { checks: Record<string, string>; seasons: Season[] }): string {
  const dayText = terms.days.mode === 'fixed' ? describeRange(terms.days.weekdays, weekdays)
    : `${terms.days.per_week} random ${terms.days.per_week === 1 ? 'day' : 'days'} a week from ${describeRange(terms.days.allowed, weekdays)}`;
  const windowText = terms.window.mode === 'any' ? 'Any time'
    : terms.window.mode === 'fixed' ? `${terms.window.start}–${terms.window.end}`
      : `${describeEndpoint(terms.window.start)} to ${describeEndpoint(terms.window.end)}`;
  const parts = [dayText, windowText];
  if (terms.months.length && terms.months.length < 12) parts.push(describeRange(terms.months, months, true));
  parts.push(`${terms.visits_per_shift} ${terms.visits_per_shift === 1 ? 'visit' : 'visits'}`);
  if (terms.checks.length) parts.push(terms.checks.map(key => labels.checks[key] ?? key).join(', '));
  return parts.join(' · ');
}

export function localTermsErrors(terms: PlaceServiceTerms, anchorHasPoint: boolean): string[] {
  const errors: string[] = [];
  const days = terms.days.mode === 'fixed' ? terms.days.weekdays : terms.days.allowed;
  const distinctDays = new Set(days);
  if (!days.length || days.some(day => !Number.isInteger(day) || day < 1 || day > 7)) {
    errors.push('Choose at least one day of the week (Monday = 1)');
  } else if (terms.days.mode === 'random'
    && (!Number.isInteger(terms.days.per_week) || terms.days.per_week < 1 || terms.days.per_week > distinctDays.size)) {
    errors.push('Random days per week must be between 1 and the number of allowed days');
  }
  if (terms.window.mode === 'solar') {
    const endpoints = [terms.window.start, terms.window.end];
    if (endpoints.some(endpoint => endpoint.anchor !== 'clock'
      && (!Number.isFinite(endpoint.offset_hours) || endpoint.offset_hours < -12 || endpoint.offset_hours > 12
        || !Number.isInteger(endpoint.offset_hours * 4)))) {
      errors.push('Offsets must be in quarter hours between -12 and 12');
    }
    if (!anchorHasPoint && endpoints.some(endpoint => endpoint.anchor !== 'clock')) {
      errors.push('Draw the boundary for this place before using sunrise or sunset times');
    }
  }
  return errors;
}
