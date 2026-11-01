import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CCTVQualityPage from './CCTVQualityPage';

const { from, rpc, auth } = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  auth: { profile: { organizationId: 'org-1', id: 'user-1', role: 'admin' } as { organizationId: string | null; id: string; role: string } },
}));
vi.mock('../lib/supabase', () => ({ supabase: { from, rpc } }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }));

const group = (kind: string, accepted: number, rejected: number, extra: Record<string, unknown> = {}) => ({
  entity_kind: kind, engine_version: 'cctv-engine-v2', detector_model: 'rf-detr-large-704-coco', review_basis: 'confirmed_track',
  confidence_band: 'high', total: accepted + rejected + 2, accepted, rejected, inconclusive: 0, pending: 2,
  precision: accepted / (accepted + rejected), precision_lower_bound: 0.8, ...extra,
});

const summary = {
  organization_id: 'org-1', since: '2026-08-01T00:00:00Z', calibration_minimum_decisions: 30,
  groups: [group('person', 38, 2), group('vehicle', 9, 1)],
  missed_detections: [{ entity_kind: 'person', engine_version: 'cctv-engine-v2', open: 1, confirmed_missed: 1, not_missed: 0 }],
};
const report = {
  id: 'report-1', entity_kind: 'person', offset_seconds: 12.5, observed_at: '2026-10-30T01:00:00Z', notes: 'Behind the gate post',
  engine_version: 'cctv-engine-v2', state: 'open', reported_at: '2026-10-30T02:00:00Z', resolution_notes: null,
  evidence_items: { cctv_import_id: 'import-1', storage_path: 'org-1/cctv/gate.mp4', metadata: { file_name: 'Gate camera.mp4' } },
};

function mockTables(results: Record<string, { data?: unknown; error?: { message: string } | null; count?: number }>) {
  from.mockImplementation((table: string) => {
    const result = { data: null, error: null, ...results[table] };
    const query = {
      select: () => query, eq: () => query, gte: () => query, order: () => query, limit: () => query,
      maybeSingle: async () => result,
      then: (resolve: (value: unknown) => unknown) => resolve(result),
    };
    return query;
  });
}

describe('CCTV detection quality page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.profile = { organizationId: 'org-1', id: 'user-1', role: 'admin' };
    rpc.mockImplementation(async (name: string) => {
      if (name === 'cctv_accuracy_summary') return { data: summary, error: null };
      if (name === 'resolve_cctv_missed_detection') return { data: 'confirmed_missed', error: null };
      if (name === 'set_cctv_inference_policy') return { data: { cloud_vehicle_vlm_enabled: true, cloud_vehicle_vlm_model: 'gemma4:31b', reason: 'Laptop often offline', set_at: '2026-11-02T00:00:00Z' }, error: null };
      return { data: null, error: null };
    });
    mockTables({
      cctv_missed_detection_reports: { data: [report] },
      cctv_inference_policies: { data: null },
      cctv_cloud_inference_receipts: { count: 0 },
    });
  });
  afterEach(cleanup);

  it('shows per-kind precision, its proven lower bound, and calibration from reviewer decisions', async () => {
    render(<MemoryRouter><CCTVQualityPage /></MemoryRouter>);
    const people = await screen.findByRole('article', { name: 'People detection quality' });
    expect(people.textContent).toContain('Calibrated');
    expect(people.textContent).toContain('95%');
    expect(people.textContent).toContain('1 to check');
    const vehicles = screen.getByRole('article', { name: 'Vehicles detection quality' });
    expect(vehicles.textContent).toContain('20 more decisions to calibrate');
    expect(rpc).toHaveBeenCalledWith('cctv_accuracy_summary', expect.objectContaining({ p_organization_id: 'org-1' }));
    expect(screen.getByText('Off · nothing leaves your infrastructure')).toBeTruthy();
  });

  it('lets an administrator resolve a missed sighting once, through the governed RPC', async () => {
    render(<MemoryRouter><CCTVQualityPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Resolve…' }));
    fireEvent.change(screen.getByPlaceholderText(/gate post/), { target: { value: 'Visible for 3 s' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save resolution' }));
    await screen.findByText(/Recorded as a confirmed miss/);
    expect(rpc).toHaveBeenCalledWith('resolve_cctv_missed_detection', { p_report_id: 'report-1', p_state: 'confirmed_missed', p_notes: 'Visible for 3 s' });
    expect(screen.queryByRole('button', { name: 'Resolve…' })).toBeNull();
  });

  it('re-reads the governed summary after a resolution so the quality cards count the decision', async () => {
    let resolved = false;
    rpc.mockImplementation(async (name: string) => {
      if (name === 'resolve_cctv_missed_detection') { resolved = true; return { data: 'confirmed_missed', error: null }; }
      if (name === 'cctv_accuracy_summary') {
        return { data: { ...summary, missed_detections: [{ entity_kind: 'person', engine_version: 'cctv-engine-v2', open: resolved ? 0 : 1, confirmed_missed: resolved ? 2 : 1, not_missed: 0 }] }, error: null };
      }
      return { data: null, error: null };
    });
    render(<MemoryRouter><CCTVQualityPage /></MemoryRouter>);
    expect((await screen.findByRole('article', { name: 'People detection quality' })).textContent).toContain('1 to check');
    fireEvent.click(screen.getByRole('button', { name: 'Resolve…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save resolution' }));
    await waitFor(() => expect(screen.getByRole('article', { name: 'People detection quality' }).textContent).not.toContain('1 to check'));
    expect(rpc.mock.calls.filter(([name]) => name === 'cctv_accuracy_summary')).toHaveLength(2);
  });

  it('discards a slower answer for a period the reviewer has already moved away from', async () => {
    const pending: Array<{ since: string; resolve: (value: unknown) => void }> = [];
    rpc.mockImplementation((name: string, args: { p_since: string }) => {
      if (name !== 'cctv_accuracy_summary') return Promise.resolve({ data: null, error: null });
      return new Promise((resolve) => pending.push({ since: args.p_since, resolve }));
    });
    render(<MemoryRouter><CCTVQualityPage /></MemoryRouter>);
    await waitFor(() => expect(pending).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: '30 days' }));
    await waitFor(() => expect(pending).toHaveLength(2));
    // The newer 30-day answer lands first; the older 90-day answer arrives afterwards and must be ignored.
    pending[1].resolve({ data: { ...summary, groups: [group('person', 38, 2)] }, error: null });
    await screen.findByRole('article', { name: 'People detection quality' });
    pending[0].resolve({ data: { ...summary, groups: [group('person', 5, 5)] }, error: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole('heading', { name: /last 30 days/ })).toBeTruthy();
    expect(screen.getByRole('article', { name: 'People detection quality' }).textContent).toContain('95%');
  });

  it('requires a reason before an administrator allows cloud vehicle hints', async () => {
    render(<MemoryRouter><CCTVQualityPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Change…' }));
    fireEvent.click(screen.getByLabelText('Allow cloud vehicle make and model hints'));
    const save = screen.getByRole('button', { name: 'Save policy' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/vehicle-heavy sites/), { target: { value: 'Laptop often offline' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await screen.findByText(/Cloud vehicle hints allowed/);
    expect(rpc).toHaveBeenCalledWith('set_cctv_inference_policy', {
      p_organization_id: 'org-1', p_cloud_vehicle_vlm_enabled: true, p_cloud_vehicle_vlm_model: 'gemma4:31b', p_reason: 'Laptop often offline',
    });
  });

  it('gives a non-administrator a read-only view', async () => {
    auth.profile = { organizationId: 'org-1', id: 'user-2', role: 'field_officer' };
    render(<MemoryRouter><CCTVQualityPage /></MemoryRouter>);
    await screen.findByRole('article', { name: 'People detection quality' });
    expect(screen.queryByRole('button', { name: 'Resolve…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change…' })).toBeNull();
    expect(screen.getByText('Only an organisation administrator can change this.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Watch footage/ })).toBeTruthy();
  });

  it('says the measurement is not installed when the summary function is missing, without a raw error', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Could not find the function public.cctv_accuracy_summary(p_organization_id, p_since) in the schema cache' } });
    render(<MemoryRouter><CCTVQualityPage /></MemoryRouter>);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('not installed on this environment yet');
    expect(alert.textContent).not.toContain('schema cache');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('refuses to load without a confirmed organisation', async () => {
    auth.profile = { organizationId: null, id: 'user-3', role: 'admin' };
    render(<MemoryRouter><CCTVQualityPage /></MemoryRouter>);
    expect((await screen.findByRole('alert')).textContent).toContain('Organisation access could not be confirmed');
    expect(rpc).not.toHaveBeenCalled();
    await waitFor(() => expect(from).not.toHaveBeenCalled());
  });
});
