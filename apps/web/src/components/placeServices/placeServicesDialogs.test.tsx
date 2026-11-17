import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StaticPostDialog } from './StaticPostDialog';
import { CheckTypesDialog } from './CheckTypesDialog';
import { PlaceSettingsPanel } from './PlaceSettingsPanel';
import { ResponsibleRunDialog } from './ResponsibleRunDialog';
import type { PlaceService, PlaceServicesWorkspace } from '../../lib/placeServices';

const rpc = vi.hoisted(() => vi.fn());
const from = vi.hoisted(() => vi.fn());
vi.mock('../../lib/supabase', () => ({ supabase: { rpc, from } }));

const workspace: PlaceServicesWorkspace = {
  location: { id: 'loc', name: 'Island', organization_id: 'client' },
  anchors: [{ kind: 'site', id: 'site', name: 'Main gate', has_point: true }, { kind: 'zone', id: 'zone', name: 'North area', has_point: false }],
  agreements: [{ id: 'agreement', name: 'Service agreement', provider_organization_id: 'provider' }],
  services: [],
  modules: [{ module_key: 'patrol', toolset_key: 'general_patrol' }],
  check_types: [
    { id: 'global-1', check_key: 'gate_check', label: 'Gate check', needs_photo: false, needs_note: false, is_global: true },
    { id: 'own-1', check_key: 'boat_ramp', label: 'Boat ramp', needs_photo: true, needs_note: false, is_global: false },
  ],
  seasons: [],
  operating_branches: [{ id: 'provider', name: 'Head office' }, { id: 'branch', name: 'North branch' }],
  settings: { place_changes_need_second_approver: true, branches_may_set_up_static_posts: false, other_approver_available: false },
  can_manage: true,
};

const patrol: PlaceService = {
  delivery_schedule_id: 'schedule', service_agreement_id: 'agreement', service_kind: 'patrol', module_key: 'patrol',
  anchor: { site_id: 'site', zone_id: null }, active: true, terms: null, effective_from: '2026-11-01',
  pending: null, responsibility: null, work_unit: null,
};

const setup = {
  location_id: 'loc', service_date: '2026-11-17', version: 'setup-version',
  configs: [{
    id: 'config', organization_id: 'provider', provider_organization_id: 'provider', agreement_name: 'Service agreement',
    service_agreement_id: 'agreement', service_agreement_location_id: 'sal', service_agreement_module_id: 'sam',
    contracted_module_key: 'patrol', contractual_terms: { id: 'schedule' }, responsibilities: [],
  }],
  runs: [{ id: 'route', name: 'Night run', organization_id: 'provider', is_active: true, work_units: [{ id: 'unit', name: 'Night patrol unit' }] }],
  billing_workspaces: [{
    provider_id: 'provider',
    agreements: [{ id: 'agreement', name: 'Service agreement', currency: 'NZD', base_rate_per_hour: 48 }],
    selections: [{ id: 'old-selection', service_agreement_location_id: 'sal', service_agreement_module_id: 'sam', rate_type: 'hourly',
      source: 'agreement', rate_rule_id: null, billing_unit_code: 'hourly_officer', effective_from: '2026-11-01', updated_at: '2026-11-01T00:00:00Z' }],
    rates: [{ id: 'rule', name: 'Per visit rate', rate_type: 'per_visit', amount: 30 }],
  }],
  billing_units: [
    { code: 'hourly_officer', label: 'Hourly (officer-hours)', rate_type: 'hourly', active: true },
    { code: 'per_visit', label: 'Per completed visit', rate_type: 'per_visit', active: true },
  ],
};

function skillsQuery(rows: Array<{ id: string; skill_name: string; skill_category: string | null }>) {
  const query = { select: () => query, eq: () => query, order: async () => ({ data: rows, error: null }) };
  return query;
}

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
  from.mockImplementation(() => skillsQuery([{ id: 'skill', skill_name: 'First aid', skill_category: null }]));
});
afterEach(cleanup);

describe('static post dialog', () => {
  it('lists only the returned operating branches', async () => {
    render(<StaticPostDialog locationId="loc" workspace={workspace} onClose={() => {}} />);
    const branch = screen.getByLabelText('Operating branch') as HTMLSelectElement;
    expect([...branch.options].map(option => option.textContent)).toEqual(['Head office', 'North branch']);
    expect(await screen.findByLabelText('First aid')).toBeTruthy();
  });

  it('creates the post and links to the roster', async () => {
    rpc.mockResolvedValue({ data: { version_id: 'v', status: 'approved', work_unit_id: 'unit' }, error: null });
    render(<StaticPostDialog locationId="loc" workspace={workspace} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Post name'), { target: { value: 'Gatehouse' } });
    fireEvent.click(await screen.findByLabelText('First aid'));
    fireEvent.change(screen.getByLabelText('Reason for change'), { target: { value: 'Client requested a guard' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create static post' }));
    expect(await screen.findByText('Post created; roster it from the Roster.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the Roster' }).getAttribute('href')).toBe('/admin/roster');
    expect(rpc).toHaveBeenCalledWith('add_place_static_post', expect.objectContaining({
      p_location_id: 'loc', p_agreement_id: 'agreement', p_site_id: 'site', p_zone_id: null, p_post_name: 'Gatehouse',
      p_operating_organization_id: 'provider', p_required_skill_ids: ['skill'], p_reason: 'Client requested a guard',
    }));
  });

  it('reports a pending approval instead of a created post', async () => {
    rpc.mockResolvedValue({ data: { version_id: 'v', status: 'pending', work_unit_id: null }, error: null });
    render(<StaticPostDialog locationId="loc" workspace={workspace} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Post name'), { target: { value: 'Gatehouse' } });
    fireEvent.change(screen.getByLabelText('Reason for change'), { target: { value: 'Client request' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create static post' }));
    expect(await screen.findByText(/Waiting for approval/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Open the Roster' })).toBeNull();
  });
});

describe('check types dialog', () => {
  it('shows default types without edit controls and edits own types', async () => {
    rpc.mockResolvedValue({ data: { check_type_id: 'own-1', organization_id: 'provider', check_key: 'boat_ramp', label: 'Boat ramp north', needs_photo: true, needs_note: false, active: true }, error: null });
    render(<CheckTypesDialog workspace={workspace} onClose={() => {}} />);
    const defaultRow = screen.getByText('Gate check').closest('li') as HTMLElement;
    expect(within(defaultRow).getByText('Default')).toBeTruthy();
    expect(within(defaultRow).queryByRole('button')).toBeNull();
    const ownRow = screen.getByText('Boat ramp').closest('li') as HTMLElement;
    fireEvent.click(within(ownRow).getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('New name for Boat ramp'), { target: { value: 'Boat ramp north' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByText('Boat ramp north')).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith('manage_patrol_check_type', expect.objectContaining({
      p_action: 'update', p_organization_id: 'provider', p_check_type_id: 'own-1', p_label: 'Boat ramp north',
    }));
  });

  it('reactivates a deactivated own type and moves it back to the active list', async () => {
    rpc.mockResolvedValue({ data: { check_type_id: 'old-1', organization_id: 'provider', check_key: 'hatch', label: 'Hatch check', needs_photo: false, needs_note: true, active: true }, error: null });
    render(<CheckTypesDialog workspace={{ ...workspace, inactive_check_types: [
      { id: 'old-1', check_key: 'hatch', label: 'Hatch check', needs_photo: false, needs_note: true, is_global: false },
    ] }} onClose={() => {}} />);
    const inactive = screen.getByRole('list', { name: 'Deactivated check types' });
    fireEvent.click(within(inactive).getByRole('button', { name: 'Reactivate Hatch check' }));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Deactivated check types' })).toBeNull());
    const active = screen.getByRole('list', { name: 'Active check types' });
    expect(within(active).getByText('Hatch check')).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith('manage_patrol_check_type', expect.objectContaining({
      p_action: 'reactivate', p_organization_id: 'provider', p_check_type_id: 'old-1', p_label: null,
    }));
  });

  it('lists a newly deactivated own type for reactivation', async () => {
    rpc.mockResolvedValue({ data: { check_type_id: 'own-1', organization_id: 'provider', check_key: 'boat_ramp', label: 'Boat ramp', needs_photo: true, needs_note: false, active: false }, error: null });
    render(<CheckTypesDialog workspace={workspace} onClose={() => {}} />);
    const ownRow = screen.getByText('Boat ramp').closest('li') as HTMLElement;
    fireEvent.click(within(ownRow).getByRole('button', { name: 'Deactivate' }));
    fireEvent.click(within(ownRow).getByRole('button', { name: 'Confirm deactivate' }));
    const inactive = await screen.findByRole('list', { name: 'Deactivated check types' });
    expect(within(inactive).getByRole('button', { name: 'Reactivate Boat ramp' })).toBeTruthy();
  });
});

describe('place settings panel', () => {
  it('saves nothing until Save settings is pressed', async () => {
    rpc.mockResolvedValue({ data: { organization_id: 'provider', setting: 'branches_may_set_up_static_posts', from: false, to: true }, error: null });
    const onClose = vi.fn();
    render(<PlaceSettingsPanel workspace={workspace} onClose={onClose} />);
    const save = screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Branches may set up static posts'));
    expect(rpc).not.toHaveBeenCalled();
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    expect(rpc).toHaveBeenCalledWith('set_organization_operating_setting', expect.objectContaining({
      p_organization_id: 'provider', p_setting: 'branches_may_set_up_static_posts', p_value: true,
    }));
    expect(await screen.findByText('Settings saved.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('discards unsaved changes', () => {
    const onClose = vi.fn();
    render(<PlaceSettingsPanel workspace={workspace} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Branches may set up static posts'));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(rpc).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Branches may set up static posts') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('retries a failed save with the same request ID', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'Network lost' } })
      .mockResolvedValueOnce({ data: { organization_id: 'provider', setting: 'branches_may_set_up_static_posts', from: false, to: true }, error: null });
    render(<PlaceSettingsPanel workspace={workspace} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText('Branches may set up static posts'));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Network lost')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    expect(rpc.mock.calls[0][1].p_client_request_id).toBe(rpc.mock.calls[1][1].p_client_request_id);
  });

  it('warns when second approval has no other approver and offers to turn it off', async () => {
    rpc.mockResolvedValue({ data: { organization_id: 'provider', setting: 'place_changes_need_second_approver', from: true, to: false }, error: null });
    render(<PlaceSettingsPanel workspace={workspace} onClose={() => {}} />);
    expect(screen.getByText('No other administrator can approve changes. Turn this off, or add an approver.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Turn off second approval' }));
    expect(rpc).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(screen.queryByText(/No other administrator can approve/)).toBeNull());
    expect(rpc).toHaveBeenCalledWith('set_organization_operating_setting', expect.objectContaining({
      p_organization_id: 'provider', p_setting: 'place_changes_need_second_approver', p_value: false,
    }));
  });
});

describe('responsible run dialog', () => {
  it('saves the work unit with the version and fingerprint from the preview', async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === 'get_location_patrol_setup') return { data: setup, error: null };
      if (name === 'preview_location_patrol_setup') return { data: { version: 'preview-version', preview_fingerprint: 'fp', affected: [], blocked: [] }, error: null };
      if (name === 'save_location_patrol_setup') return { data: { responsibility_id: 'r', replayed: false }, error: null };
      throw new Error(name);
    });
    const onSaved = vi.fn();
    render(<ResponsibleRunDialog locationId="loc" service={patrol} onClose={() => {}} onSaved={onSaved} />);
    fireEvent.change(await screen.findByLabelText('Responsible work unit'), { target: { value: 'route:unit' } });
    expect((screen.getByLabelText('Charging basis') as HTMLSelectElement).value).toBe('hourly_officer');
    expect((screen.getByLabelText("Agreement's standard rate") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm responsible run' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const save = rpc.mock.calls.find(([name]) => name === 'save_location_patrol_setup')?.[1];
    expect(save).toMatchObject({
      p_location_id: 'loc', p_expected_version: 'preview-version', p_preview_fingerprint: 'fp',
      p_changes: {
        patrol_config_id: 'config', service_agreement_location_id: 'sal', service_agreement_module_id: 'sam',
        patrol_route_id: 'route', work_unit_id: 'unit',
        billing: { source: 'agreement', rate_type: 'hourly', billing_unit_code: 'hourly_officer', rate_rule_id: null, new_rate: null,
          expected_selection_id: 'old-selection', expected_updated_at: '2026-11-01T00:00:00Z' },
      },
    });
  });

  it('requires a charge rate when the basis has no agreement rate', async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === 'get_location_patrol_setup') return { data: setup, error: null };
      throw new Error(name);
    });
    render(<ResponsibleRunDialog locationId="loc" service={patrol} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Charging basis'), { target: { value: 'per_visit' } });
    expect((screen.getByLabelText("Agreement's standard rate") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Existing charge rate') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('option', { name: 'Per visit rate ($30.00)' })).toBeTruthy();
  });
});
