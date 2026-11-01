import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ReportActivityReview } from './ReportActivityReview';
import { activityReportFixture } from '../lib/reportActivity.fixture';

const { rpc, maybeSingle, select, eq, from } = vi.hoisted(() => {
  const maybeSingle = vi.fn();
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { rpc: vi.fn(), maybeSingle, select, eq, from };
});
vi.mock('../lib/supabase', () => ({ supabase: { from, rpc } }));

const data = { patrolVisits: 2, activityReport: activityReportFixture };
const group = (name: RegExp) => screen.getByText(name, { selector: 'summary' }).closest('details')!;
// Waits for the browser's own toggle event rather than dispatching a synthetic one.
const setOpen = async (details: HTMLDetailsElement, open: boolean) => {
  await act(async () => {
    const toggled = new Promise((resolve) => details.addEventListener('toggle', resolve, { once: true }));
    details.open = open;
    await toggled;
  });
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ReportActivityReview', () => {
  it('explains how to add activity to a legacy draft and keeps sent packs unchanged', () => {
    const { rerender } = render(<ReportActivityReview packId="p1" data={{ patrolVisits: 2 }} status="draft" />);
    expect(screen.getByRole('note').textContent).toContain('Use Generate report drafts for this period');
    rerender(<ReportActivityReview packId="p1" data={{ patrolVisits: 2 }} status="sent" />);
    expect(screen.getByRole('note').textContent).toContain('kept exactly as delivered');
    expect(from).not.toHaveBeenCalled();
  });

  it('shows the reconciled summary, categories and sections without loading lines', () => {
    render(<ReportActivityReview packId="p1" data={data} status="draft" />);
    expect(screen.getByText('All 6 entries accounted for')).toBeTruthy();
    const totals = screen.getByRole('group', { name: 'Month-end activity totals' });
    expect(within(totals).getByText('Work hours').nextSibling?.textContent).toBe('3.5');
    expect(within(totals).getByText('Entries without a visit')).toBeTruthy();
    const categories = screen.getByRole('region', { name: 'Activity by category' });
    expect(within(categories).getByText('Pest control')).toBeTruthy();
    expect(screen.getByText(/1 automatic patrol-log copy of an observation was excluded/)).toBeTruthy();
    const pest = group(/^Pest control/);
    expect(within(pest).getByText('Goat')).toBeTruthy();
    expect(within(pest).getByText('Calibre not recorded')).toBeTruthy();
    expect(within(pest).getByText('Not recorded')).toBeTruthy();
    expect(screen.getByText('No manufacture or fabrication work was recorded during the period.')).toBeTruthy();
    expect(from).not.toHaveBeenCalled();
  });

  it('uses singular wording for single entries', () => {
    const report = activityReportFixture;
    const single = {
      ...report,
      pestControl: { ...report.pestControl, entries: 1 },
      accountedFor: { ...report.accountedFor, entries: 1, activityEvents: 1, observationsInScope: 0, workOrdersInScope: 0, itemised: 1 },
    };
    render(<ReportActivityReview packId="p1" data={{ activityReport: single }} status="draft" />);
    expect(screen.getByText(/^1 entry reported: 1 patrol-log entry, 0 observations and 0 workshop work orders\./)).toBeTruthy();
    expect(group(/^Pest control/).querySelector('summary')?.textContent).toContain('1 entry ·');
    expect(group(/^Itemised activity/).querySelector('summary')?.textContent).toContain('1 line');
    expect(document.body.textContent).not.toMatch(/\b1 (entries|lines|observations|photos)\b/);
  });

  it('lazy-loads itemised lines once, filters by category and retries after an error', async () => {
    maybeSingle.mockResolvedValueOnce({ data: null, error: { message: 'network' } });
    render(<ReportActivityReview packId="p1" data={data} status="draft" />);
    const itemised = group(/^Itemised activity/);
    await setOpen(itemised, true);
    expect(await within(itemised).findByRole('alert')).toBeTruthy();
    expect(within(itemised).getByRole('alert').textContent).not.toContain('network');

    maybeSingle.mockResolvedValueOnce({
      data: {
        activity_lines: {
          version: 1,
          notItemised: 0,
          lines: [
            { d: '2026-09-03', p: 'Alpha Reserve', k: 'event', c: 'pest_control', a: 'shooting', sp: 'goat', h: 1.5, km: 12 },
            { d: '2026-09-04', p: 'Alpha Reserve', k: 'work_order', c: 'maintenance', s: 'gate', j: 'WO-1', ws: 'completed' },
          ],
        },
      },
      error: null,
    });
    fireEvent.click(within(itemised).getByRole('button', { name: 'Retry' }));
    const table = await within(itemised).findByRole('region', { name: 'Itemised activity lines' });
    expect(from).toHaveBeenCalledWith('monthly_report_packs');
    expect(select).toHaveBeenCalledWith('activity_lines');
    expect(eq).toHaveBeenCalledWith('id', 'p1');
    expect(within(table).getByText('03/09/2026')).toBeTruthy();
    expect(within(table).getByText('WO-1')).toBeTruthy();

    fireEvent.change(within(itemised).getByLabelText('Category'), { target: { value: 'maintenance' } });
    expect(within(table).queryByText('03/09/2026')).toBeNull();
    expect(within(itemised).getByText('Showing 1 of 1')).toBeTruthy();

    await setOpen(itemised, false);
    await setOpen(itemised, true);
    expect(maybeSingle).toHaveBeenCalledTimes(2);
    expect(within(itemised).getByText('WO-1')).toBeTruthy();
  });

  it('runs the provider accounting check and warns when live records changed', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        version: 1,
        checkedAt: '2026-10-01T00:00:00Z',
        freshness: { hasFrozenReport: true, frozenEntries: 6, liveEntries: 7, matchesLive: false, changedCategories: [{ code: 'pest_control', frozen: 3, live: 4 }] },
        provenance: { events: { inScope: 4, withLedger: 3, withoutLedger: 1 }, observations: { inScope: 1, withLedger: 0, withoutLedger: 1 }, sources: [] },
        clientMonth: { entries: 9, thisAgreement: 7, otherAgreements: 0, noAgreementPlace: 2, unlinkedPlaces: [{ place: 'Beta Hut', entries: 2 }] },
        exceptions: { futureDated: 0, sparseYears: [], supersededDuplicates: 0 },
      },
      error: null,
    });
    render(<ReportActivityReview packId="p1" data={data} status="generated" />);
    fireEvent.click(screen.getByRole('button', { name: 'Check against live records' }));
    expect(await screen.findByText(/6 entries in the pack, 7 now/)).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith('get_report_pack_activity_accounting', { p_pack_id: 'p1' });
    expect(screen.getByText(/Use Generate report drafts for this period to refresh it/)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Categories that changed since generation' })).getByText('4')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Unlinked places with client records' })).getByText('Beta Hut')).toBeTruthy();
    expect(screen.getByText('No date or duplicate exceptions found.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy();
  });

  it('shows a permission state instead of the raw error for non-administrators', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'Provider administrator access required' } });
    render(<ReportActivityReview packId="p1" data={data} status="draft" />);
    fireEvent.click(screen.getByRole('button', { name: 'Check against live records' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Only a provider administrator'));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
