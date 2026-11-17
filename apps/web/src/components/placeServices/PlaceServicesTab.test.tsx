import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PlaceServicesTab } from './PlaceServicesTab';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../lib/supabase', () => ({ supabase: { rpc } }));

const workspace = {
  location: { id: 'loc', name: 'Island', organization_id: 'client' },
  anchors: [{ kind: 'zone', id: 'zone', name: 'North area', has_point: false }],
  agreements: [{ id: 'agreement', name: 'Service agreement', provider_organization_id: 'provider' }],
  services: [],
  modules: [{ module_key: 'patrol', toolset_key: 'general_patrol' }],
  check_types: [{ id: 'check-1', check_key: 'gate_check', label: 'Gate check', needs_photo: false, needs_note: false, is_global: true }],
  seasons: [{ season_key: 'summer', label: 'Summer', months: [12, 1, 2] }, { season_key: 'winter', label: 'Winter', months: [6, 7, 8] }],
  operating_branches: [],
  settings: { place_changes_need_second_approver: false, branches_may_set_up_static_posts: false, other_approver_available: false },
  can_manage: true,
};
const preview = {
  normalised_terms: null, applies_from: '2026-11-17', needs_approval: false,
  affected: [], blocked: [], next_days: [], warnings: [], preview_fingerprint: 'confirmed-fingerprint',
};

beforeEach(() => {
  rpc.mockReset();
  rpc.mockImplementation(async (name: string) => {
    if (name === 'get_place_services') return { data: workspace, error: null };
    if (name === 'preview_place_service_change') return { data: preview, error: null };
    if (name === 'save_place_service_change') return { data: { version_id: 'version', status: 'approved', applied_effective_from: '2026-11-17', delivery_schedule_id: 'schedule' }, error: null };
    throw new Error(`Unexpected RPC ${name}`);
  });
});
afterEach(cleanup);

describe('place patrols and services', () => {
  it('shows loading and a truthful empty state', async () => {
    render(<PlaceServicesTab locationId="loc" />);
    expect(screen.getByRole('status').textContent).toContain('Loading');
    expect(await screen.findByText('No patrols or services at this place yet.')).toBeTruthy();
  });

  it('does not claim there are no services when the workspace is not available to the caller', async () => {
    rpc.mockResolvedValue({ data: { ...workspace, location: null, services: [], agreements: [], can_manage: false }, error: null });
    render(<PlaceServicesTab locationId="loc" />);
    expect(await screen.findByText(/No operational agreement is available to you/)).toBeTruthy();
    expect(screen.queryByText('No patrols or services at this place yet.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add patrol' })).toBeNull();
  });

  it('supports zone-only setup and season shortcuts', async () => {
    render(<PlaceServicesTab locationId="loc" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add patrol' }));
    expect((screen.getByLabelText('Place anchor') as HTMLSelectElement).value).toBe('zone:zone');
    fireEvent.click(screen.getByRole('button', { name: 'Summer' }));
    for (const month of ['January', 'February', 'December']) expect((screen.getByLabelText(month) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('March') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Winter' }));
    expect((screen.getByLabelText('January') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('July') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Summer' }));
    expect((screen.getByLabelText('January') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('July') as HTMLInputElement).checked).toBe(true);
  });

  it('does not show an old location if its slower request finishes last', async () => {
    let resolveOld: (result: { data: typeof workspace; error: null }) => void = () => {};
    rpc.mockImplementation((_name: string, args: { p_location_id: string }) => args.p_location_id === 'loc'
      ? new Promise(resolve => { resolveOld = resolve; })
      : Promise.resolve({ data: { ...workspace, services: [{ delivery_schedule_id: 'new', service_agreement_id: 'agreement',
        service_kind: 'patrol', module_key: 'patrol', anchor: { site_id: null, zone_id: 'zone' }, active: true,
        terms: null, effective_from: null, pending: null, responsibility: { work_unit_name: 'New run' }, work_unit: null }] }, error: null }));
    const { rerender } = render(<PlaceServicesTab locationId="loc" />);
    rerender(<PlaceServicesTab locationId="new-loc" />);
    expect(await screen.findByText('New run')).toBeTruthy();
    await act(async () => resolveOld({ data: workspace, error: null }));
    expect(screen.getByText('New run')).toBeTruthy();
  });

  it('does not reload an old location when a pending save finishes after navigation', async () => {
    let resolveSave: (result: { data: { status: string }; error: null }) => void = () => {};
    rpc.mockImplementation((name: string, args: { p_location_id: string }) => {
      if (name === 'get_place_services') return Promise.resolve({ data: {
        ...workspace, services: args.p_location_id === 'new-loc' ? [{
          delivery_schedule_id: 'new', service_agreement_id: 'agreement', service_kind: 'patrol', module_key: 'patrol',
          anchor: { site_id: null, zone_id: 'zone' }, active: true, terms: null, effective_from: null,
          pending: null, responsibility: { work_unit_name: 'New run' }, work_unit: null,
        }] : [],
      }, error: null });
      if (name === 'preview_place_service_change') return Promise.resolve({ data: preview, error: null });
      if (name === 'save_place_service_change') return new Promise(resolve => { resolveSave = resolve; });
      throw new Error(`Unexpected RPC ${name}`);
    });
    const { rerender } = render(<PlaceServicesTab locationId="loc" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add patrol' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    fireEvent.change(await screen.findByLabelText('Reason for change'), { target: { value: 'Client request' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    rerender(<PlaceServicesTab locationId="new-loc" />);
    expect(await screen.findByText('New run')).toBeTruthy();
    await act(async () => resolveSave({ data: { status: 'approved' }, error: null }));
    expect(screen.getByText('New run')).toBeTruthy();
    expect(rpc.mock.calls.filter(([name, args]) => name === 'get_place_services' && args.p_location_id === 'loc')).toHaveLength(1);
  });

  it('lists the shifts affected by a change before confirmation', async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === 'get_place_services') return { data: workspace, error: null };
      if (name === 'preview_place_service_change') return { data: { ...preview,
        affected: [{ shift_id: 'shift-1', date: '2026-11-18', work_unit_name: 'North run',
          scheduled_start: '2026-11-18T07:00:00Z', scheduled_end: '2026-11-18T15:00:00Z',
          status: 'scheduled', updated_at: '2026-11-17T00:00:00Z' }],
      }, error: null };
      throw new Error(`Unexpected RPC ${name}`);
    });
    render(<PlaceServicesTab locationId="loc" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add patrol' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText(/North run/)).toBeTruthy();
    expect(screen.getByText(/2026-11-18/)).toBeTruthy();
  });

  it('prevents solar preview without a point and explains what to do', async () => {
    render(<PlaceServicesTab locationId="loc" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add patrol' }));
    fireEvent.click(screen.getByLabelText('Sunrise / sunset'));
    expect(screen.getByText('Draw the boundary for this place before using sunrise or sunset times')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Preview' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('passes the reviewed fingerprint and required reason to save', async () => {
    render(<PlaceServicesTab locationId="loc" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add patrol' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    fireEvent.change(await screen.findByLabelText('Reason for change'), { target: { value: 'Client request' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('save_place_service_change', expect.objectContaining({
      p_preview_fingerprint: 'confirmed-fingerprint', p_reason: 'Client request', p_agreement_id: 'agreement',
    })));
    expect(await screen.findByRole('status')).toHaveProperty('textContent', expect.stringContaining('saved'));
  });

  it('shows server errors without pretending the change was saved', async () => {
    rpc.mockImplementation(async (name: string) => name === 'get_place_services'
      ? { data: workspace, error: null }
      : { data: null, error: { message: 'Agreement no longer active' } });
    render(<PlaceServicesTab locationId="loc" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add patrol' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Agreement no longer active');
  });

  it('identifies changes waiting for approval', async () => {
    const pending = {
      delivery_schedule_id: 'schedule', service_agreement_id: 'agreement', service_kind: 'patrol', module_key: 'patrol',
      anchor: { site_id: null, zone_id: 'zone' }, active: true, terms: null, effective_from: null,
      responsibility: null, work_unit: null,
      pending: { version_id: 'version', change_kind: 'end', effective_from: '2026-12-01', terms: null, requested_by: 'person', requested_by_name: null },
    };
    rpc.mockResolvedValue({ data: { ...workspace, services: [pending] }, error: null });
    render(<PlaceServicesTab locationId="loc" />);
    expect(await screen.findByText('Waiting for approval')).toBeTruthy();
  });

  it('identifies the proposed post while static guarding is waiting for approval', async () => {
    const pending = {
      delivery_schedule_id: null, service_agreement_id: 'agreement', service_kind: 'static_guarding', module_key: 'static_guarding',
      anchor: { site_id: null, zone_id: 'zone' }, active: false, terms: null, effective_from: null,
      responsibility: null, work_unit: null,
      pending: { version_id: 'version', change_kind: 'create', effective_from: '2026-12-01',
        terms: { post_name: 'Gate post', operating_organization_id: 'branch' }, requested_by: 'person', requested_by_name: null },
    };
    rpc.mockResolvedValue({ data: { ...workspace, services: [pending] }, error: null });
    render(<PlaceServicesTab locationId="loc" />);
    expect(await screen.findByText('Gate post')).toBeTruthy();
    expect(screen.queryByText('No responsible run yet')).toBeNull();
  });

  it('keeps a check that is no longer offered visible so it can be unticked', async () => {
    const patrol = {
      delivery_schedule_id: 'schedule', service_agreement_id: 'agreement', service_kind: 'patrol', module_key: 'patrol',
      anchor: { site_id: null, zone_id: 'zone' }, active: true, effective_from: '2026-11-01',
      terms: { anchor: { site_id: null, zone_id: 'zone' }, module_key: 'patrol', days: { mode: 'fixed', weekdays: [1] },
        window: { mode: 'any' }, months: [], visits_per_shift: 1, min_gap_minutes: 60, dwell_minutes: 15,
        checks: ['gate_check', 'boat_ramp'], officer_instructions: null },
      responsibility: null, work_unit: null, pending: null,
    };
    rpc.mockResolvedValue({ data: { ...workspace, services: [patrol] }, error: null });
    render(<PlaceServicesTab locationId="loc" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const retired = screen.getByLabelText('boat ramp (no longer offered — untick to remove)') as HTMLInputElement;
    expect(retired.checked).toBe(true);
    fireEvent.click(retired);
    expect(screen.queryByLabelText(/no longer offered/)).toBeNull();
    expect((screen.getByLabelText('Gate check') as HTMLInputElement).checked).toBe(true);
  });

  it('ends an active static post with a reason and confirms it ended', async () => {
    const post = {
      delivery_schedule_id: null, service_agreement_id: 'agreement', service_kind: 'static_guarding', module_key: 'static_guarding',
      anchor: { site_id: null, zone_id: 'zone' }, active: true, effective_from: '2026-11-01',
      terms: { post_name: 'Gate post', operating_organization_id: 'provider' },
      responsibility: null, work_unit: { id: 'unit', name: 'Gate post', active: true }, pending: null,
    };
    rpc.mockImplementation(async (name: string) => {
      if (name === 'get_place_services') return { data: { ...workspace, services: [post] }, error: null };
      if (name === 'end_place_static_post') return { data: { version_id: 'v', status: 'approved', work_unit_id: 'unit' }, error: null };
      throw new Error(`Unexpected RPC ${name}`);
    });
    render(<PlaceServicesTab locationId="loc" />);
    fireEvent.click(await screen.findByRole('button', { name: 'End post' }));
    const confirm = screen.getByRole('button', { name: 'Confirm end' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Reason for ending Gate post'), { target: { value: 'Client cancelled guarding' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('end_place_static_post', expect.objectContaining({
      p_work_unit_id: 'unit', p_reason: 'Client cancelled guarding',
    })));
    expect(await screen.findByText('Static post ended. Existing rostered shifts are kept.')).toBeTruthy();
  });

  it('describes a pending change in plain words', async () => {
    const pending = {
      delivery_schedule_id: 'schedule', service_agreement_id: 'agreement', service_kind: 'patrol', module_key: 'patrol',
      anchor: { site_id: null, zone_id: 'zone' }, active: true, terms: null, effective_from: null,
      responsibility: null, work_unit: null,
      pending: { version_id: 'version', change_kind: 'end', effective_from: '2026-12-01', terms: null, requested_by: 'person', requested_by_name: null },
    };
    rpc.mockResolvedValue({ data: { ...workspace, services: [pending] }, error: null });
    render(<PlaceServicesTab locationId="loc" />);
    expect(await screen.findByText('End service from 2026-12-01')).toBeTruthy();
  });

  it('shows affected shift times in New Zealand time with a plain status', async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === 'get_place_services') return { data: workspace, error: null };
      if (name === 'preview_place_service_change') return { data: { ...preview,
        affected: [{ shift_id: 'shift-1', date: '2026-11-18', work_unit_name: 'North run',
          scheduled_start: '2026-11-18T07:00:00Z', scheduled_end: '2026-11-18T15:00:00Z',
          status: 'in_progress', updated_at: '2026-11-17T00:00:00Z' }],
      }, error: null };
      throw new Error(`Unexpected RPC ${name}`);
    });
    render(<PlaceServicesTab locationId="loc" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add patrol' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const row = (await screen.findByText(/North run/)).textContent ?? '';
    expect(row).not.toContain('T20:00');
    expect(row).toMatch(/8:00\s?pm/i);
    expect(row).toContain('In progress');
  });

  it('opens the responsible run for a patrol without one and returns to the list on cancel', async () => {
    const patrol = {
      delivery_schedule_id: 'schedule', service_agreement_id: 'agreement', service_kind: 'patrol', module_key: 'patrol',
      anchor: { site_id: null, zone_id: 'zone' }, active: true, terms: null, effective_from: '2026-11-01',
      responsibility: null, work_unit: null, pending: null,
    };
    rpc.mockImplementation(async (name: string) => {
      if (name === 'get_place_services') return { data: { ...workspace, services: [patrol] }, error: null };
      if (name === 'get_location_patrol_setup') return { data: { configs: [], runs: [], billing_workspaces: [], billing_units: [] }, error: null };
      throw new Error(`Unexpected RPC ${name}`);
    });
    render(<PlaceServicesTab locationId="loc" />);
    expect(await screen.findByText('No responsible run yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Responsible run' }));
    expect(await screen.findByText(/This patrol has no operational setup yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('button', { name: 'Add static post' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check types' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
  });
});
