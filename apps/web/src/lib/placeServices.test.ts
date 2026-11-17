import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('./supabase', () => ({ supabase: { rpc } }));

import {
  addStaticPost, decidePlaceServiceChange, describeTerms, endStaticPost, fetchPlaceServices,
  localTermsErrors, manageCheckType, monthsForSeasons, previewPlaceServiceChange,
  ratesApplicableToRun, savePlaceServiceChange, setOperatingSetting,
  type LocationBillingWorkspace, type PlaceServiceChangeInput, type PlaceServiceTerms,
} from './placeServices';

const seasons = [
  { season_key: 'summer', label: 'Summer', months: [12, 1, 2] },
  { season_key: 'winter', label: 'Winter', months: [6, 7, 8] },
];
const fixed: PlaceServiceTerms = {
  anchor: { site_id: 'site', zone_id: null },
  module_key: 'patrol',
  days: { mode: 'fixed', weekdays: [1, 2, 3, 4, 5] },
  window: { mode: 'fixed', start: '22:00', end: '06:00' },
  months: [],
  visits_per_shift: 1,
  min_gap_minutes: 60,
  dwell_minutes: 15,
  checks: ['gate_check', 'lock_up'],
  officer_instructions: null,
};
const labels = { checks: { gate_check: 'Gate check', lock_up: 'Lock-up' }, seasons };
const change: PlaceServiceChangeInput = {
  locationId: 'location', agreementId: 'agreement', deliveryScheduleId: null,
  changeKind: 'create', terms: fixed, effectiveFrom: '2026-12-01',
};

beforeEach(() => rpc.mockReset());

describe('place service RPC errors', () => {
  it('replaces a missing-function error with plain words', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.get_place_services(p_location_id) in the schema cache' } });
    await expect(fetchPlaceServices('location')).rejects.toThrow('Place services are not available yet. The database update for this screen has not been released.');
  });
});

describe('responsible run charge rates', () => {
  const rate = (id: string, extra: Partial<LocationBillingWorkspace['rates'][number]> = {}) => ({
    id, name: id, rate_type: 'hourly', amount: 50, client_org_id: null, site_id: null, zone_id: null,
    module_key: null, service_type: null, effective_from: null, effective_to: null, ...extra,
  });
  const workspace: LocationBillingWorkspace = {
    provider_id: 'provider',
    agreements: [{ id: 'agreement', name: 'Agreement', currency: 'NZD', base_rate_per_hour: null }],
    places: [{ id: 'covered-gate', service_agreement_id: 'agreement', client_organization_id: 'client', site_id: null, zone_id: 'gate' }],
    modules: [
      { id: 'patrol-module', service_agreement_id: 'agreement', module_key: 'patrol', service_type: 'patrol' },
      { id: 'access-module', service_agreement_id: 'agreement', module_key: 'access_control', service_type: 'access_control' },
    ],
    selections: [],
    rates: [
      rate('any'),
      rate('patrol-only', { service_type: 'patrol' }),
      rate('access-only', { service_type: 'access_control' }),
      rate('other-client', { client_org_id: 'someone-else' }),
      rate('other-zone', { zone_id: 'elsewhere' }),
      rate('future', { effective_from: '2027-01-01' }),
      rate('per-km', { rate_type: 'per_km' }),
    ],
  };

  it('offers only rates the save accepts for this run\'s place, service, unit and date', () => {
    const ids = ratesApplicableToRun(workspace, {
      service_agreement_location_id: 'covered-gate', service_agreement_module_id: 'access-module',
    }, 'hourly', '2026-11-17').map(item => item.id);
    expect(ids).toEqual(['any', 'access-only']);
  });
});

describe('place service schedule summaries', () => {
  it('describes a fixed overnight schedule and the selected checks', () => {
    expect(describeTerms(fixed, labels)).toBe('Mon–Fri · 22:00–06:00 · 1 visit · Gate check, Lock-up');
  });

  it('describes random days, solar offsets, months and visits without omitting contracted visits', () => {
    expect(describeTerms({
      ...fixed, days: { mode: 'random', per_week: 3, allowed: [1, 2, 3, 4, 5] },
      window: { mode: 'solar', start: { anchor: 'sunset', offset_hours: -0.5 }, end: { anchor: 'sunrise', offset_hours: 0.5 } },
      months: [6, 7, 8], checks: [],
    }, labels)).toBe('3 random days a week from Mon–Fri · sunset −0.5 h to sunrise +0.5 h · Jun–Aug · 1 visit');
  });

  it('unions season months in calendar order without duplicates', () => {
    expect(monthsForSeasons(seasons, ['summer'])).toEqual([1, 2, 12]);
    expect(monthsForSeasons(seasons, ['winter', 'summer', 'summer'])).toEqual([1, 2, 6, 7, 8, 12]);
  });
});

describe('place service local validation', () => {
  it('uses the server messages for invalid weekdays and random counts', () => {
    expect(localTermsErrors({ ...fixed, days: { mode: 'fixed', weekdays: [] } }, true))
      .toContain('Choose at least one day of the week (Monday = 1)');
    expect(localTermsErrors({ ...fixed, days: { mode: 'random', per_week: 3, allowed: [1, 1, 2] } }, true))
      .toContain('Random days per week must be between 1 and the number of allowed days');
  });

  it('rejects non-quarter-hour offsets and solar times without a place point', () => {
    const terms: PlaceServiceTerms = {
      ...fixed, window: { mode: 'solar', start: { anchor: 'sunset', offset_hours: 0.3 }, end: { anchor: 'sunrise', offset_hours: 0 } },
    };
    expect(localTermsErrors(terms, false)).toEqual(expect.arrayContaining([
      'Offsets must be in quarter hours between -12 and 12',
      'Draw the boundary for this place before using sunrise or sunset times',
    ]));
    expect(localTermsErrors({ ...terms, window: { mode: 'solar', start: { anchor: 'clock', time: '22:00' }, end: { anchor: 'clock', time: '06:00' } } }, false)).toEqual([]);
  });
});

describe('place service save', () => {
  it('sends the confirmed preview fingerprint and reports the server error', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Preview has changed; preview again' } });
    await expect(savePlaceServiceChange({
      ...change, requestId: 'request', reason: 'Client request', previewFingerprint: 'fingerprint',
    })).rejects.toThrow('Preview has changed; preview again');
    expect(rpc).toHaveBeenCalledWith('save_place_service_change', {
      p_client_request_id: 'request', p_location_id: 'location', p_agreement_id: 'agreement',
      p_delivery_schedule_id: null, p_change_kind: 'create', p_terms: fixed,
      p_effective_from: '2026-12-01', p_reason: 'Client request', p_preview_fingerprint: 'fingerprint',
    });
  });

  it('does not treat a missing save receipt as success', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(savePlaceServiceChange({
      ...change, requestId: 'request', reason: 'Client request', previewFingerprint: 'fingerprint',
    })).rejects.toThrow('No response');
  });

  it('passes each operation to its matching RPC with all authorization and retry inputs', async () => {
    rpc.mockResolvedValue({ data: { version_id: 'version' }, error: null });
    await fetchPlaceServices('location');
    expect(rpc).toHaveBeenLastCalledWith('get_place_services', { p_location_id: 'location' });
    await previewPlaceServiceChange(change);
    expect(rpc).toHaveBeenLastCalledWith('preview_place_service_change', {
      p_location_id: 'location', p_agreement_id: 'agreement', p_delivery_schedule_id: null,
      p_change_kind: 'create', p_terms: fixed, p_effective_from: '2026-12-01',
    });
    await decidePlaceServiceChange('version', 'reject', 'reason', 'request');
    expect(rpc).toHaveBeenLastCalledWith('decide_place_service_change', {
      p_client_request_id: 'request', p_version_id: 'version', p_decision: 'reject', p_reason: 'reason',
    });
    await addStaticPost({
      requestId: 'request', locationId: 'location', agreementId: 'agreement', siteId: null, zoneId: 'zone',
      postName: 'Gate', operatingOrganizationId: 'branch', requiredSkillIds: ['skill'], reason: 'reason',
    });
    expect(rpc).toHaveBeenLastCalledWith('add_place_static_post', {
      p_client_request_id: 'request', p_location_id: 'location', p_agreement_id: 'agreement',
      p_site_id: null, p_zone_id: 'zone', p_post_name: 'Gate', p_operating_organization_id: 'branch',
      p_required_skill_ids: ['skill'], p_reason: 'reason',
    });
    await endStaticPost('unit', 'reason', 'request');
    expect(rpc).toHaveBeenLastCalledWith('end_place_static_post', {
      p_client_request_id: 'request', p_work_unit_id: 'unit', p_reason: 'reason',
    });
    await manageCheckType({
      requestId: 'request', action: 'update', organizationId: 'org', checkTypeId: 'check',
      label: 'Gate', needsPhoto: true, needsNote: false,
    });
    expect(rpc).toHaveBeenLastCalledWith('manage_patrol_check_type', {
      p_client_request_id: 'request', p_action: 'update', p_organization_id: 'org', p_check_type_id: 'check',
      p_label: 'Gate', p_needs_photo: true, p_needs_note: false,
    });
    await setOperatingSetting('org', 'branches_may_set_up_static_posts', true, 'request');
    expect(rpc).toHaveBeenLastCalledWith('set_organization_operating_setting', {
      p_client_request_id: 'request', p_organization_id: 'org', p_setting: 'branches_may_set_up_static_posts', p_value: true,
    });
  });
});
