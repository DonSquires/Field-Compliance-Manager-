import { userFacingError } from './userFacingError';

export type Place = { kind: 'site' | 'zone'; id: string; name: string };
export type Hazard = {
  id: string; title: string; risk_level: string; controls: string[]; details: string | null;
  status: string; place_name: string; source_name: string | null; source_locator: string | null; has_source_document: boolean;
};
export type Briefing = {
  briefing_hash: string; item_count: number; acknowledged: boolean; is_assigned_officer: boolean;
  hazards: Hazard[]; places: Place[];
  warnings: Array<{ id: string; hazard_class: string; alert_level: string; reason: string | null }>;
};

type Result = { data: unknown; error: { message: string } | null };
type Transport = {
  privateBriefing: (shiftId: string) => PromiseLike<Result>;
  generalBriefing: (shiftId: string) => PromiseLike<Result>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';

function isBriefing(value: unknown, shiftId: string): value is Briefing {
  if (!isRecord(value) || value.shift_id !== shiftId || value.stop_id !== null
    || typeof value.briefing_hash !== 'string' || !value.briefing_hash
    || !Number.isInteger(value.item_count) || typeof value.acknowledged !== 'boolean'
    || typeof value.is_assigned_officer !== 'boolean'
    || !Array.isArray(value.places) || !Array.isArray(value.hazards) || !Array.isArray(value.warnings)
    || value.item_count !== value.hazards.length + value.warnings.length) return false;
  return value.places.every((place) => isRecord(place) && (place.kind === 'site' || place.kind === 'zone')
      && typeof place.id === 'string' && typeof place.name === 'string')
    && value.hazards.every((hazard) => isRecord(hazard) && typeof hazard.id === 'string'
      && typeof hazard.title === 'string' && typeof hazard.risk_level === 'string'
      && typeof hazard.status === 'string' && typeof hazard.place_name === 'string'
      && isNullableString(hazard.details) && isNullableString(hazard.source_name) && isNullableString(hazard.source_locator)
      && typeof hazard.has_source_document === 'boolean' && Array.isArray(hazard.controls)
      && hazard.controls.every((control) => typeof control === 'string'))
    && value.warnings.every((warning) => isRecord(warning) && typeof warning.id === 'string'
      && typeof warning.hazard_class === 'string' && typeof warning.alert_level === 'string' && isNullableString(warning.reason));
}

export async function fetchMobileShiftSafety(transport: Transport, shiftId: string, serviceType: string | null): Promise<Briefing> {
  if (!serviceType?.trim()) throw new Error('The shift type could not be confirmed. Retry before starting work.');
  const isStatic = ['static_guarding', 'site_guard', 'static'].includes(serviceType.trim().toLowerCase());
  const response = await (isStatic ? transport.privateBriefing(shiftId) : transport.generalBriefing(shiftId));
  if (response.error) {
    throw new Error(userFacingError(response.error, 'The safety briefing could not be checked. Retry or contact operations.'));
  }
  let data = response.data;
  if (isStatic) {
    if (!isRecord(data) || !isRecord(data.privacy)) throw new Error('Private safety review could not be confirmed. Contact operations.');
    if (data.privacy.status !== 'checked') {
      throw new Error(typeof data.privacy.message === 'string' ? data.privacy.message : 'Safety details are withheld pending private review. Contact operations.');
    }
    if (!isRecord(data.post) || !isRecord(data.post.shift) || data.post.shift.id !== shiftId) {
      throw new Error('The selected assignment could not be confirmed. Retry or contact operations.');
    }
    data = data.safety;
  }
  if (!isBriefing(data, shiftId)) throw new Error('The server did not return a safety briefing. Retry before starting work.');
  if (isStatic && !data.is_assigned_officer) throw new Error('The assigned officer could not be confirmed for this safety briefing.');
  return data;
}
