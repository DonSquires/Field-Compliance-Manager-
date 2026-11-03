import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ReportActivityReview } from './ReportActivityReview';
import { activityLinesFixture, activityReportFixture } from '../lib/reportActivity.fixture';
import { activityLineKey } from '../lib/reportActivity';

const { rpc, accountingRpc, triageRpc, invoke, maybeSingle, select, eq, from, createSignedUrls, storageFrom } = vi.hoisted(() => {
  const maybeSingle = vi.fn();
  const eq = vi.fn();
  const select = vi.fn();
  const from = vi.fn();
  const createSignedUrls = vi.fn();
  const storageFrom = vi.fn();
  return { rpc: vi.fn(), accountingRpc: vi.fn(), triageRpc: vi.fn(), invoke: vi.fn(), maybeSingle, select, eq, from, createSignedUrls, storageFrom };
});
vi.mock('../lib/supabase', () => ({ supabase: { from, rpc, functions: { invoke }, storage: { from: storageFrom } } }));

const updatedAt = '2026-10-01T00:00:00Z';
const data = { patrolVisits: 3, activityReport: activityReportFixture };
const linesRow = (lines: unknown = activityLinesFixture, at = updatedAt) => ({ data: { updated_at: at, activity_lines: lines }, error: null });
const signed = (bucket: string, path: string) => `https://storage.test/${bucket}/${path}?token=t`;
const noIncidents = {
  ...activityReportFixture,
  totals: { ...activityReportFixture.totals, entries: 8, incidents: 0 },
  incidents: { total: 0, investigations: 0, withMedia: 0, bySeverity: [], byStatus: [] },
};

const group = (name: RegExp) => screen.getByText(name, { selector: 'summary' }).closest('details')!;
const signCalls = (bucket: string) => createSignedUrls.mock.calls.filter(([called]) => called === bucket).length;
const incidentsSection = () => screen.getByRole('region', { name: 'Incidents and investigations' });
// Waits for the browser's own toggle event rather than dispatching a synthetic one.
const setOpen = async (details: HTMLDetailsElement, open: boolean) => {
  await act(async () => {
    const toggled = new Promise((resolve) => details.addEventListener('toggle', resolve, { once: true }));
    details.open = open;
    await toggled;
  });
};

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute('open'); };
});

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  eq.mockImplementation(() => ({ maybeSingle }));
  select.mockImplementation(() => ({ eq }));
  from.mockImplementation(() => ({ select }));
  maybeSingle.mockResolvedValue(linesRow());
  triageRpc.mockResolvedValue({ data: [], error: null });
  rpc.mockImplementation((name: string, args: unknown) => (name.endsWith('_incident_triage') ? triageRpc(name, args) : accountingRpc(name, args)));
  storageFrom.mockImplementation((bucket: string) => ({ createSignedUrls: (paths: string[], seconds: number) => createSignedUrls(bucket, paths, seconds) }));
  createSignedUrls.mockImplementation(async (bucket: string, paths: string[]) => ({
    data: paths.map((path) => ({ path, signedUrl: signed(bucket, path), error: null })),
    error: null,
  }));
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe('ReportActivityReview', () => {
  it('explains how to add the client report to a legacy draft and keeps sent packs unchanged', () => {
    const { rerender } = render(<ReportActivityReview packId="p1" updatedAt={updatedAt} data={{ patrolVisits: 2 }} status="draft" />);
    expect(screen.getByRole('note').textContent).toContain('Use Generate report drafts for this period');
    rerender(<ReportActivityReview packId="p1" updatedAt={updatedAt} data={{ patrolVisits: 2 }} status="sent" />);
    expect(screen.getByRole('note').textContent).toContain('kept exactly as delivered');
    expect(from).not.toHaveBeenCalled();
  });

  it('previews the client report without hours, travel or internal checks in the client sections', async () => {
    render(<ReportActivityReview packId="p1" updatedAt={updatedAt} data={data} status="draft" />);
    expect(screen.getByText('Client report preview')).toBeTruthy();

    const glance = screen.getByRole('group', { name: 'Report at a glance' });
    expect([...glance.querySelectorAll('span')].map((node) => node.textContent)).toEqual([
      'Locations with activity', 'Entries recorded', 'Incidents', 'Observations', 'Patrols', 'CCTV activity', 'Photos', 'Pest culls recorded',
    ]);
    expect(within(glance).getByText('Incidents').closest('div')?.className).toBe('is-alert');
    expect(within(glance).getByText('Pest culls recorded').nextSibling?.textContent).toBe('2');
    expect(glance.textContent).not.toMatch(/hour|km|travel|distance/i);

    const overview = screen.getByRole('region', { name: 'Entries by type of activity' });
    expect(within(overview).getByText('CCTV and camera activity')).toBeTruthy();
    const pest = group(/^Pest control/);
    expect(within(pest).getByText('Goat')).toBeTruthy();
    expect(within(pest).getByText('DOC 200 trap')).toBeTruthy();
    expect(within(pest).getByText('Calibre not recorded')).toBeTruthy();
    expect(within(pest).getByText('Not recorded')).toBeTruthy();
    expect(within(group(/^Maintenance and repairs/)).getByText('Gate')).toBeTruthy();
    expect(screen.getByText('No manufacture or fabrication work was recorded during the period.')).toBeTruthy();

    const clientSections = [...document.querySelectorAll('.report-activity-section, .report-activity-group:not(.report-activity-check)')];
    for (const section of clientSections) expect(section.textContent).not.toMatch(/import|ledger|batch|reconcil|start or finish|travel/i);
    await screen.findByText('Trespass');
  });

  it('shows accessible summary charts for activity, locations, culls and hunter returns', async () => {
    const report = {
      ...activityReportFixture,
      hunterReturns: {
        animals: 15,
        bySpecies: [{ species: 'Possum', animals: 12 }, { species: 'Goat', animals: 3 }],
      },
    };
    render(<ReportActivityReview packId="p1" updatedAt={updatedAt} data={{ ...data, activityReport: report }} status="draft" />);
    const charts = screen.getByRole('group', { name: 'Activity statistics charts' });
    expect(within(charts).getByText('Activity type highlights')).toBeTruthy();
    expect(within(charts).getByText('Top locations')).toBeTruthy();
    expect(within(charts).getByText('Pest culls by species')).toBeTruthy();
    const hunterChart = within(charts).getByText('Hunter animals by species').closest('figure')!;
    expect(within(hunterChart).getByText('Possum')).toBeTruthy();
    expect(within(hunterChart).getByText('12')).toBeTruthy();
    expect(within(hunterChart).getByRole('list').querySelectorAll('li')).toHaveLength(2);
    expect(within(charts).getByText(/Charts highlight the highest recorded counts/)).toBeTruthy();
    await screen.findByText('Trespass');
  });

  it('leads with incidents and investigations, loading their detail and photos straight away', async () => {
    render(<ReportActivityReview packId="p1" updatedAt={updatedAt} data={data} status="generated" />);
    const incidents = incidentsSection();
    expect(within(incidents).getByText(/^1 incident was recorded at these locations; 1 investigation is linked; 1 with photo or video evidence\.$/)).toBeTruthy();
    const breakdown = within(incidents).getByRole('list', { name: 'Incidents by severity and status' });
    expect(within(breakdown).getByText('High severity · 1').className).toContain('report-chip-danger');
    expect(within(breakdown).getByText('Under review · 1').className).toContain('report-chip-info');

    const card = (await within(incidents).findByText('Trespass')).closest('article')!;
    expect(card.className).toContain('is-incident');
    expect(within(card).getByText('Wed 2 Sep 2026 · 21:40')).toBeTruthy();
    expect(within(card).getByText(/Alpha Reserve/)).toBeTruthy();
    expect(within(card).getByText('INV-2026-014 · Awaiting evidence')).toBeTruthy();
    expect(within(card).getByText('1 video clip held on file')).toBeTruthy();
    expect(from).toHaveBeenCalledWith('monthly_report_packs');
    expect(select).toHaveBeenCalledWith('activity_lines,updated_at');
    expect(eq).toHaveBeenCalledWith('id', 'p1');

    await waitFor(() => expect(card.querySelectorAll('img')).toHaveLength(2));
    expect(createSignedUrls).toHaveBeenCalledWith('bob-uploads', ['org/incidents/fence-1.jpg', 'org/incidents/fence-2.jpg'], 900);
    expect(card.querySelector('img')?.getAttribute('src')).toBe(signed('bob-uploads', 'org/incidents/fence-1.jpg'));
    expect(within(card).getByRole('button', { name: 'Open photo 2 of 2' })).toBeTruthy();
    expect(maybeSingle).toHaveBeenCalledTimes(1);
  });

  it('opens with the reviewer text and a photo gallery whose viewer caption follows each photo', async () => {
    render(<ReportActivityReview packId="p1" updatedAt={updatedAt} data={data} status="draft" summary="A quiet month overall." highlights="  " />);
    const summary = screen.getByRole('region', { name: 'Executive summary' });
    const paragraphs = [...summary.querySelectorAll('.report-activity-summary-text')].map((node) => node.textContent);
    expect(paragraphs[0]).toBe('A quiet month overall.');
    expect(paragraphs.some((paragraph) => /were recorded across/.test(paragraph ?? ''))).toBe(false);
    const gallery = await within(summary).findByRole('list', { name: 'Selected photos' });
    const captions = [...gallery.querySelectorAll('li > span')].map((node) => node.textContent);
    expect(captions.length).toBeGreaterThan(1);
    fireEvent.click(within(gallery).getAllByRole('button')[0]);
    const viewer = await screen.findByRole('dialog', { name: `Photo 1 of ${captions.length}` });
    expect(within(viewer).getByText(captions[0]!)).toBeTruthy();
    fireEvent.click(within(viewer).getByRole('button', { name: /Next/ }));
    expect(within(screen.getByRole('dialog')).getByText(captions[1]!)).toBeTruthy();
  });

  it('opens photos in an accessible viewer, steps through them and returns focus', async () => {
    const lines = {
      ...activityLinesFixture,
      lines: [{
        ...activityLinesFixture.lines[0],
        ph: 6,
        pr: [1, 2, 3, 4].map((index) => ({ b: 'bob-uploads', p: `org/incidents/fence-${index}.jpg` })),
      }],
    };
    maybeSingle.mockResolvedValue(linesRow(lines));
    createSignedUrls.mockImplementation(async (bucket: string, paths: string[]) => ({
      data: paths.map((path) => (path.endsWith('fence-3.jpg') ? { path, signedUrl: '', error: 'Object not found' } : { path, signedUrl: signed(bucket, path), error: null })),
      error: null,
    }));
    render(<ReportActivityReview packId="p1" updatedAt={updatedAt} data={data} status="draft" />);
    const card = (await within(incidentsSection()).findByText('Trespass')).closest('article')!;
    await within(card).findByRole('button', { name: 'Photo 3 unavailable. Open to retry' });
    expect(within(card).getByRole('status').textContent).toBe('1 photo could not be loaded. Open it to retry.');
    expect(within(card).getByText('2 further photos held on file')).toBeTruthy();

    const opener = within(card).getByRole('button', { name: 'Open photo 2 of 4' });
    opener.focus();
    fireEvent.click(opener);
    const viewer = await screen.findByRole('dialog', { name: 'Photo 2 of 4' });
    expect(viewer.hasAttribute('open')).toBe(true);
    expect(within(viewer).getByText('Trespass · Alpha Reserve · Wed 2 Sep 2026 · 21:40')).toBeTruthy();
    expect(within(viewer).getByRole('img').getAttribute('alt')).toBe('Trespass · Alpha Reserve · Wed 2 Sep 2026 · 21:40, photo 2 of 4');

    fireEvent.keyDown(viewer, { key: 'ArrowRight' });
    expect(within(viewer).getByText('This photo could not be loaded.', { exact: false })).toBeTruthy();
    fireEvent.click(within(viewer).getByRole('button', { name: /Next/ }));
    expect(screen.getByRole('dialog', { name: 'Photo 4 of 4' })).toBeTruthy();
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('img').getAttribute('src')).toBe(signed('bob-uploads', 'org/incidents/fence-4.jpg')));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Next/ }));
    expect(screen.getByRole('dialog', { name: 'Photo 1 of 4' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Close photo' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);

    fireEvent.click(within(card).getByRole('button', { name: 'Open 1 more photo' }));
    expect(await screen.findByRole('dialog', { name: 'Photo 4 of 4' })).toBeTruthy();
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each(['response', 'rejection'])('offers a safe retry after a photo signing %s failure', async (failure) => {
    if (failure === 'response') createSignedUrls.mockResolvedValueOnce({ data: null, error: { message: 'PRIVATE_STORAGE_DETAIL' } });
    else createSignedUrls.mockRejectedValueOnce(new Error('PRIVATE_STORAGE_DETAIL'));
    render(<ReportActivityReview packId="p1" updatedAt={updatedAt} data={data} status="draft" />);
    const incidents = incidentsSection();
    const opener = await within(incidents).findByRole('button', { name: 'Photo 1 unavailable. Open to retry' });
    expect(within(incidents).getByRole('status').textContent).toBe('2 photos could not be loaded. Open one to retry.');
    fireEvent.click(opener);
    const viewer = screen.getByRole('dialog', { name: 'Photo 1 of 2' });
    fireEvent.click(within(viewer).getByRole('button', { name: 'Retry photo' }));
    await waitFor(() => expect(within(viewer).getByRole('img').getAttribute('src')).toBe(signed('bob-uploads', 'org/incidents/fence-1.jpg')));
    expect(createSignedUrls).toHaveBeenLastCalledWith('bob-uploads', ['org/incidents/fence-1.jpg'], 900);
    expect(signCalls('bob-uploads')).toBe(2);
    expect(within(incidents).getByRole('button', { name: 'Photo 2 unavailable. Open to retry' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('PRIVATE_STORAGE_DETAIL');
    expect(console.warn).toHaveBeenCalledWith('Report photos could not be loaded.');
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('PRIVATE_STORAGE_DETAIL'));
  });

  it.each(['thumbnail', 'viewer'])('recovers a failed or expired %s image without losing its context', async (surface) => {
    render(<ReportActivityReview packId="p1" updatedAt={updatedAt} data={data} status="draft" />);
    const card = (await within(incidentsSection()).findByText('Trespass')).closest('article')!;
    await waitFor(() => expect(card.querySelectorAll('img')).toHaveLength(2));
    const open = () => fireEvent.click(within(card).getByRole('button', { name: /(?:Open photo 1|Photo 1 unavailable)/ }));
    if (surface === 'thumbnail') {
      fireEvent.error(card.querySelector('img')!);
      open();
    } else {
      open();
      fireEvent.error(within(screen.getByRole('dialog')).getByRole('img'));
    }
    const viewer = screen.getByRole('dialog', { name: 'Photo 1 of 2' });
    expect(within(viewer).getByText('This photo could not be loaded.')).toBeTruthy();
    expect(within(viewer).getByText('Trespass · Alpha Reserve · Wed 2 Sep 2026 · 21:40')).toBeTruthy();

    let finish!: (value: unknown) => void;
    createSignedUrls.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(within(viewer).getByRole('button', { name: 'Retry photo' }));
    expect(within(viewer).getByRole('status').textContent).toBe('Loading photo…');
    expect(within(viewer).queryByRole('button', { name: 'Retry photo' })).toBeNull();
    await act(async () => finish({ data: [{ path: 'org/incidents/fence-1.jpg', signedUrl: 'https://storage.test/renewed', error: null }], error: null }));
    expect(within(viewer).getByRole('img').getAttribute('src')).toBe('https://storage.test/renewed');
    expect(card.querySelector('img')?.getAttribute('src')).toBe('https://storage.test/renewed');
    expect(signCalls('bob-uploads')).toBe(2);
    expect(maybeSingle).toHaveBeenCalledTimes(1);
    expect(accountingRpc).not.toHaveBeenCalled();
  });

  it('loads entries straight away when there are no incidents, then filters, searches and folds routine patrols', async () => {
    maybeSingle.mockResolvedValueOnce({ data: null, error: { message: 'network' } });
    render(<ReportActivityReview packId="p1" updatedAt={updatedAt} data={{ activityReport: noIncidents }} status="draft" />);
    expect(within(incidentsSection()).getByText('No incidents were recorded at these locations during the period.')).toBeTruthy();
    expect(from).toHaveBeenCalledWith('monthly_report_packs');

    const alert = await within(incidentsSection()).findByRole('alert');
    expect(alert.textContent).not.toContain('network');
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(within(incidentsSection()).queryByRole('alert')).toBeNull());
    expect(maybeSingle).toHaveBeenCalledTimes(2);

    const log = group(/^Site log/);
    expect(log.querySelector('summary')?.textContent).toContain('8 entries by location, with comments and photos');
    await setOpen(log, true);

    const status = await within(log).findByText('6 entries with comments, work or photos');
    expect(within(log).getByRole('heading', { name: 'Alpha Reserve' })).toBeTruthy();
    expect(within(log).getByRole('heading', { name: 'Not location-specific' })).toBeTruthy();
    expect(within(log).getByText('2 routine patrols with nothing further to report (7, 9 Sep).')).toBeTruthy();
    expect(within(log).queryByText('Trespass')).toBeNull();
    expect(within(log).getByText('Ref WO-1')).toBeTruthy();

    fireEvent.change(within(log).getByLabelText('Type of activity'), { target: { value: 'maintenance' } });
    expect(status.textContent).toBe('1 entry matches these filters');
    expect(within(log).getByText('Repair north gate latch')).toBeTruthy();
    expect(within(log).queryByText(/routine patrols/)).toBeNull();
    expect(within(log).queryByRole('heading', { name: 'Not location-specific' })).toBeNull();

    fireEvent.click(within(log).getByRole('button', { name: 'Clear filters' }));
    fireEvent.change(within(log).getByRole('searchbox', { name: 'Search comments' }), { target: { value: 'GOAT' } });
    expect(status.textContent).toBe('1 entry matches these filters');
    expect(within(log).getByText('Shooting · Goat')).toBeTruthy();

    fireEvent.click(within(log).getByRole('button', { name: 'Clear filters' }));
    fireEvent.click(within(log).getByRole('checkbox', { name: 'With photos only' }));
    expect(status.textContent).toBe('2 entries match these filters');
    await waitFor(() => expect(createSignedUrls.mock.calls.filter(([bucket]) => bucket === 'scans').flatMap(([, paths]) => paths).sort()).toEqual(['org/obs/1.jpg', 'org/obs/2.jpg', 'org/obs/3.jpg', 'org/pest/ridge.jpg']));

    fireEvent.change(within(log).getByRole('searchbox', { name: 'Search comments' }), { target: { value: 'nothing like this' } });
    expect(within(log).getByText('No entries match these filters.')).toBeTruthy();

    await setOpen(log, false);
    await setOpen(log, true);
    expect(maybeSingle).toHaveBeenCalledTimes(2);
    expect(within(log).getByText('6 entries with comments, work or photos')).toBeTruthy();
  });

  it('refuses newer site log detail and reloads only after the displayed snapshot changes', async () => {
    const newer = '2026-10-02T00:00:00Z';
    maybeSingle.mockResolvedValue(linesRow(activityLinesFixture, newer));
    const { rerender } = render(<ReportActivityReview packId="p1" updatedAt={updatedAt} data={data} status="draft" />);
    expect(await within(incidentsSection()).findByText(/This report pack changed since you opened it/)).toBeTruthy();
    expect(screen.queryByText('Trespass')).toBeNull();
    await setOpen(group(/^Site log/), true);
    expect(maybeSingle).toHaveBeenCalledTimes(1);

    rerender(<ReportActivityReview packId="p1" updatedAt={newer} data={data} status="draft" />);
    expect(await screen.findByText('Trespass')).toBeTruthy();
    expect(maybeSingle).toHaveBeenCalledTimes(2);
  });

  it('keeps the completeness check provider-only and explains what was kept out of the client report', async () => {
    render(<ReportActivityReview packId="p1" updatedAt={updatedAt} data={data} status="draft" />);
    const check = group(/^Completeness check/);
    expect(check.querySelector('summary')?.textContent).toBe('Completeness checkProvider only · All 12 records accounted for');
    expect(within(check).getByText('9 entries are in the client report; every record in scope is accounted for.')).toBeTruthy();
    expect(within(check).getByText('2 travel and materials records are kept out of the client report.')).toBeTruthy();
    expect(within(check).getByText('1 shift start or finish marker is kept out of the client report.')).toBeTruthy();
    expect(within(check).getByText(/1 automatic patrol-log copy of an observation was excluded/)).toBeTruthy();
    expect(screen.queryByRole('note')).toBeNull();
    await screen.findByText('Trespass');
    cleanup();

    const unreconciled = { ...activityReportFixture, accountedFor: { ...activityReportFixture.accountedFor, entries: 1, reconciled: false } };
    render(<ReportActivityReview packId="p1" updatedAt={updatedAt} data={{ activityReport: unreconciled }} status="draft" />);
    expect(screen.getByRole('note').textContent).toContain('do not agree');
    expect(group(/^Completeness check/).querySelector('summary')?.textContent).toContain('Totals need review');
    await screen.findByText('Trespass');
  });

  it('runs the provider accounting check and warns when live records changed', async () => {
    accountingRpc.mockResolvedValueOnce({
      data: {
        version: 1,
        packUpdatedAt: updatedAt,
        checkedAt: '2026-10-01T00:00:00Z',
        freshness: { hasFrozenReport: true, frozenEntries: 9, liveEntries: 10, matchesLive: false, changedCategories: [{ code: 'pest_control', frozen: 2, live: 3 }] },
        provenance: { events: { inScope: 4, withLedger: 3, withoutLedger: 1 }, observations: { inScope: 1, withLedger: 0, withoutLedger: 1 }, sources: [] },
        clientMonth: { entries: 9, thisAgreement: 7, otherAgreements: 0, noAgreementPlace: 2, unlinkedPlaces: [{ place: 'Beta Hut', entries: 2 }] },
        exceptions: { futureDated: 0, sparseYears: [], supersededDuplicates: 0 },
      },
      error: null,
    });
    render(<ReportActivityReview packId="p1" updatedAt={updatedAt} data={data} status="generated" />);
    const check = group(/^Completeness check/);
    await setOpen(check, true);
    fireEvent.click(within(check).getByRole('button', { name: 'Check against live records' }));
    expect(await within(check).findByText(/9 entries in the pack, 10 now/)).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith('get_report_pack_activity_accounting', { p_pack_id: 'p1' });
    expect(within(check).getByText(/Use Generate report drafts for this period to refresh it/)).toBeTruthy();
    expect(within(within(check).getByRole('region', { name: 'Categories that changed since generation' })).getByText('3')).toBeTruthy();
    expect(within(within(check).getByRole('region', { name: 'Unlinked places with client records' })).getByText('Beta Hut')).toBeTruthy();
    expect(within(check).getByText('No date or duplicate exceptions found.')).toBeTruthy();
    expect(within(check).getByRole('button', { name: 'Check again' })).toBeTruthy();
    await screen.findByText('Trespass');
  });

  it('does not certify an older on-screen snapshot using a newer accounting result', async () => {
    accountingRpc.mockResolvedValueOnce({
      data: { version: 1, packUpdatedAt: '2026-10-02T00:00:00Z', freshness: { hasFrozenReport: true, matchesLive: true, liveEntries: 9 } },
      error: null,
    });
    render(<ReportActivityReview packId="p1" updatedAt={updatedAt} data={data} status="draft" />);
    const check = group(/^Completeness check/);
    await setOpen(check, true);
    fireEvent.click(within(check).getByRole('button', { name: 'Check against live records' }));
    expect(await within(check).findByText(/This report pack changed since you opened it/)).toBeTruthy();
    expect(within(check).queryByText(/This pack matches live records/)).toBeNull();
    await screen.findByText('Trespass');
  });

  it('shows a permission state instead of the raw error for non-administrators', async () => {
    accountingRpc.mockResolvedValueOnce({ data: null, error: { message: 'Provider administrator access required' } });
    render(<ReportActivityReview packId="p1" updatedAt={updatedAt} data={data} status="draft" />);
    const check = group(/^Completeness check/);
    await setOpen(check, true);
    fireEvent.click(within(check).getByRole('button', { name: 'Check against live records' }));
    await waitFor(() => expect(within(check).getByRole('status').textContent).toContain('Only a provider administrator'));
    expect(within(check).queryByRole('alert')).toBeNull();
    await screen.findByText('Trespass');
  });
  it('asks Bob to check the logged activity and reports what he highlighted', async () => {
    invoke.mockResolvedValueOnce({ data: { checked: 6, flagged: 1, remaining: 0 }, error: null });
    render(<ReportActivityReview packId="p1" updatedAt={updatedAt} data={data} status="draft" />);
    const section = screen.getByRole('region', { name: 'Potential incidents (Bob)' });
    expect(await within(section).findByText('Bob has not checked this report yet.')).toBeTruthy();
    const ask = within(section).getByRole('button', { name: 'Ask Bob to check for potential incidents' }) as HTMLButtonElement;
    await waitFor(() => expect(ask.disabled).toBe(false));
    fireEvent.click(ask);
    expect(await within(section).findByText('Bob read 6 entries and highlighted 1 possible incident for your review.')).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith('flag-report-potential-incidents', { body: { pack_id: 'p1' } });
    expect(triageRpc.mock.calls.filter(([name]) => name === 'list_report_incident_triage')).toHaveLength(2);
  });

  it('lets a reviewer confirm an entry Bob highlighted, recolouring it and listing it under Incidents', async () => {
    const gate = activityLinesFixture.lines.find((line) => (line as { n?: string }).n === 'Gate found open and secured.')!;
    const key = activityLineKey(gate as Record<string, unknown>);
    const flagged = { line_key: key, bob_flagged: true, bob_incident_type: 'perimeter_compromise', bob_reason: 'An open gate on patrol suggests unauthorised access.', bob_confidence: 0.7, decision: 'unreviewed', incident_type: null, decision_note: null, decided_at: null };
    triageRpc.mockImplementation(async (name: string) => (name === 'list_report_incident_triage'
      ? { data: [flagged], error: null }
      : { data: { ...flagged, decision: 'incident', incident_type: 'perimeter_compromise', decided_at: '2026-10-03T00:00:00Z' }, error: null }));
    render(<ReportActivityReview packId="p1" updatedAt={updatedAt} data={data} status="draft" />);
    const section = screen.getByRole('region', { name: 'Potential incidents (Bob)' });
    const card = (await within(section).findByText('Gate found open and secured.')).closest('article')!;
    expect(card.className).toContain('is-flagged');
    expect(within(card).getByText('Bob: possible perimeter compromise · awaiting review')).toBeTruthy();
    expect(within(incidentsSection()).queryByText('Gate found open and secured.')).toBeNull();

    fireEvent.click(within(card).getByRole('button', { name: 'Review entry' }));
    const dialog = screen.getByRole('dialog', { name: 'Review possible incident' });
    expect(within(dialog).getByText('An open gate on patrol suggests unauthorised access.')).toBeTruthy();
    expect((within(dialog).getByRole('radio', { name: /^Not reviewed/ }) as HTMLInputElement).checked).toBe(true);
    const save = within(dialog).getByRole('button', { name: 'Save decision' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('radio', { name: /^Incident/ }));
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(triageRpc).toHaveBeenCalledWith('set_report_incident_triage', { p_pack_id: 'p1', p_line_key: key, p_decision: 'incident', p_incident_type: 'perimeter_compromise', p_note: null });

    const confirmed = within(section).getByText('Gate found open and secured.').closest('article')!;
    expect(confirmed.className).toContain('is-confirmed');
    expect(within(confirmed).getByText('Confirmed incident · Perimeter compromise')).toBeTruthy();
    expect(within(incidentsSection()).getByText('Gate found open and secured.')).toBeTruthy();
    expect(within(incidentsSection()).getByText(/1 further logged entry was confirmed as an incident on review/)).toBeTruthy();
  });

  it('shows Bob\'s highlights read-only once the report has been sent', async () => {
    render(<ReportActivityReview packId="p1" updatedAt={updatedAt} data={data} status="sent" />);
    const section = screen.getByRole('region', { name: 'Potential incidents (Bob)' });
    expect(await within(section).findByText('Bob did not check this report.')).toBeTruthy();
    expect(within(section).queryByRole('button', { name: /Ask Bob/ })).toBeNull();
  });
});