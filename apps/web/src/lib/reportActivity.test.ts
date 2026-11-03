import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  activityAccountingProblem,
  activityLabel,
  countedText,
  describeActivityLine,
  isReportPhotoRef,
  readActivityAccounting,
  readActivityLines,
  readActivityReport,
  reportDate,
  routineSummary,
  REVIEW_SECTIONS,
  reviewSectionCode,
  siteLogGroups,
  summaryMarkup,
  summaryPhotos,
  textParagraphs,
  activityLineKey,
  applyIncidentTriage,
  isIncidentLine,
  type ActivityLine,
  type IncidentTriage,
} from './reportActivity';
import { activityLinesFixture, activityReportFixture } from './reportActivity.fixture';

// The PDF and email renderer the client receives; the review must say exactly the same thing. It has no
// imports, so its exact source loads as a data: URL without widening Vite's file-system allow list.
const SECTIONS_PATH = resolve(process.cwd(), '../../supabase/functions/_shared/report-activity-sections.mjs');
type PdfEntry = { kind: 'entry'; when: string; tags: string[]; title: string; lines: unknown[]; photos: Array<{ b: string; p: string }>; photoCount: number; tone: string };
type PdfBlock = PdfEntry | { kind: 'subsection'; title: string; detail?: string } | { kind: 'text'; text: string } | { kind: string };

const report = readActivityReport({ activityReport: activityReportFixture })!;
const lines = readActivityLines(activityLinesFixture)!.lines;
const line = (index: number): ActivityLine => lines[index];

describe('readActivityReport', () => {
  it('reads a version 2 client report with no hours or distances', () => {
    expect(report.totals).toMatchObject({ entries: 9, incidents: 1, patrolVisits: 3, photos: 6, places: 2 });
    expect(report.byPlace[1].place).toBe('Not location-specific');
    expect(report.incidents).toMatchObject({ total: 1, investigations: 1, bySeverity: [{ code: 'high', entries: 1 }] });
    expect(report.accountedFor).toMatchObject({ reported: 9, withheldTravelAdmin: 2, withheldShiftMarkers: 1, reconciled: true });
    expect(report.pest.ammunition[1]).toEqual({ calibre: 'unspecified', entries: 1, rounds: null });
    expect(JSON.stringify(report)).not.toMatch(/"(hours|km|travelKm)"/);
  });

  it('treats legacy, version 1, malformed and future-version data as absent', () => {
    expect(readActivityReport({ patrolVisits: 3 })).toBeNull();
    expect(readActivityReport({ activityReport: { ...activityReportFixture, version: 1 } })).toBeNull();
    expect(readActivityReport({ activityReport: { ...activityReportFixture, version: 3 } })).toBeNull();
    expect(readActivityReport({ activityReport: { version: 2 } })).toBeNull();
    expect(readActivityReport(null)).toBeNull();
  });

  it('labels codes like the PDF renderer', () => {
    expect(activityLabel(report, 'category', 'pest_control')).toBe('Pest control');
    expect(activityLabel(report, 'module', 'unknown')).toBe('General');
    expect(activityLabel(report, 'investigationStatus', 'court')).toBe('Before the court');
    expect(activityLabel(report, 'workOrderStatus', 'approved')).toBe('Scheduled');
    expect(activityLabel(report, 'subject', 'not_recorded')).toBe('Not recorded');
    expect(activityLabel(report, 'species', '')).toBe('');
  });
});

describe('readActivityLines', () => {
  it('reads compact lines, keeps comments and drops unsafe photo references', () => {
    const parsed = readActivityLines({
      version: 2,
      lines: [{ d: '2026-09-03', k: 'event', c: 'patrol_visit', n: ' Gate open ', pr: [{ b: 'scans', p: 'a.jpg' }, { b: 'scans', p: 'https://x/y.jpg' }, { b: '', p: 'b.jpg' }] }],
    })!;
    expect(parsed.lines[0]).toMatchObject({ place: 'Not location-specific', note: 'Gate open', photoRefs: [{ bucket: 'scans', path: 'a.jpg' }] });
    expect(readActivityLines({ version: 1, lines: [] })).toBeNull();
    expect(readActivityLines(null)).toBeNull();
  });

  it('only signs photos in the report buckets', () => {
    expect(isReportPhotoRef({ bucket: 'scans', path: 'org/a.jpg' })).toBe(true);
    expect(isReportPhotoRef({ bucket: 'bob-uploads', path: 'org/a.jpg' })).toBe(true);
    expect(isReportPhotoRef({ bucket: 'private', path: 'org/a.jpg' })).toBe(false);
    expect(isReportPhotoRef({ bucket: 'scans', path: 'org/../secret.jpg' })).toBe(false);
  });

  it('formats New Zealand report dates', () => {
    expect(reportDate('2026-09-03')).toBe('Thu 3 Sep 2026');
    expect(reportDate('not a date')).toBe('not a date');
    expect(countedText(1, 'entry', 'entries')).toBe('1 entry');
    expect(countedText(1200, 'entry', 'entries')).toBe('1,200 entries');
  });
});

describe('describeActivityLine', () => {
  it('describes an incident with its investigation reference and status only', () => {
    expect(describeActivityLine(report, line(0))).toEqual({
      when: 'Wed 2 Sep 2026 · 21:40',
      tags: ['High severity', 'Under review'],
      title: 'Trespass',
      lines: [
        { text: 'Two people seen cutting the boundary fence near the north gate.' },
        { label: 'Investigation', text: 'INV-2026-014 · Awaiting evidence' },
        { label: 'Video', text: '1 video clip held on file' },
      ],
      photos: [{ bucket: 'bob-uploads', path: 'org/incidents/fence-1.jpg' }, { bucket: 'bob-uploads', path: 'org/incidents/fence-2.jpg' }],
      photoCount: 2,
      tone: 'incident',
    });
  });

  it('omits a short imported label that repeats the category and lists materials and action taken', () => {
    const entry = describeActivityLine(report, line(1));
    expect(entry.tags).toEqual(['Pest control']);
    expect(entry.title).toBe('Shooting · Goat');
    expect(entry.lines).toEqual([
      { text: 'Two goats culled on the eastern ridge.' },
      { label: 'Used', text: 'Ammunition .223 × 14' },
      { label: 'Action taken', text: 'Carcasses removed from the track.' },
    ]);
  });

  it('describes work orders and observations', () => {
    expect(describeActivityLine(report, line(3))).toMatchObject({ tags: ['Maintenance and repairs', 'Completed', 'Ref WO-1'], title: 'Repair north gate latch', lines: [{ label: 'Completion', text: 'Latch replaced and tested.' }] });
    expect(describeActivityLine(report, line(4)).tags).toEqual(['Observations', 'General observation']);
  });
});

describe('siteLogGroups', () => {
  it('groups by location, folds routine patrols and keeps incidents and CCTV reviews out of the site log', () => {
    const groups = siteLogGroups(lines);
    expect(groups.map((group) => group.place)).toEqual(['Alpha Reserve']);
    expect(lines.some((entry) => reviewSectionCode(entry) === 'camera_activation')).toBe(true);
    expect(groups[0].lines).toHaveLength(7);
    expect(groups[0].routine).toHaveLength(2);
    expect(groups[0].entries.some((entry) => entry.kind === 'incident')).toBe(false);
    expect(routineSummary(groups[0].routine)).toBe('2 routine patrols with nothing further to report (7, 9 Sep).');
  });
});

describe('parity with the client PDF renderer', () => {
  it('produces the same entries, locations and routine fold as report-activity-sections.mjs', async () => {
    const sections = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(readFileSync(SECTIONS_PATH)).toString('base64')}`) as {
      siteLogBlocks: (data: unknown, lines: unknown) => PdfBlock[];
      monthlyActivityBlocks: (data: unknown, lines: unknown, options?: { summary?: string; highlights?: string }) => PdfBlock[] | null;
      summaryMarkup: (value: unknown) => unknown;
      activityLineKey: (line: unknown) => string;
      applyIncidentTriage: (lines: unknown, triage: unknown[]) => unknown;
    };
    const data = { activityReport: activityReportFixture };
    const asWeb = (block: PdfEntry) => {
      const { kind: _kind, photos, ...rest } = block;
      return { ...rest, photos: photos.map((photo) => ({ bucket: photo.b, path: photo.p })) };
    };
    const isEntry = (block: PdfBlock): block is PdfEntry => block.kind === 'entry';

    const logBlocks = sections.siteLogBlocks(data, activityLinesFixture);
    const groups = siteLogGroups(lines);
    expect(logBlocks.filter(isEntry).map(asWeb)).toEqual(groups.flatMap((group) => group.entries.map((entry) => describeActivityLine(report, entry))));
    expect(logBlocks.filter((block): block is { kind: 'subsection'; title: string; detail?: string } => block.kind === 'subsection'))
      .toEqual(groups.map((group) => ({ kind: 'subsection', title: group.place, detail: countedText(group.lines.length, 'entry', 'entries') })));
    expect(logBlocks.flatMap((block) => (block.kind === 'text' && 'text' in block && /routine patrol/.test(block.text) ? [block.text] : [])))
      .toEqual(groups.filter((group) => group.routine.length > 0).map((group) => routineSummary(group.routine)));

    const incidentBlocks = (sections.monthlyActivityBlocks(data, activityLinesFixture) ?? []).filter(isEntry);
    const withPlace = (entry: ActivityLine) => {
      const described = describeActivityLine(report, entry);
      return { ...described, tags: [entry.place, ...described.tags] };
    };
    expect(incidentBlocks.map(asWeb)).toEqual([
      ...lines.filter((entry) => entry.kind === 'incident'),
      ...REVIEW_SECTIONS.flatMap((review) => lines.filter((entry) => reviewSectionCode(entry) === review.code)),
    ].map(withPlace));

    const monthly = sections.monthlyActivityBlocks(data, activityLinesFixture) ?? [];
    const gallery = summaryPhotos(report, lines);
    expect(monthly.some((block) => block.kind === 'rich')).toBe(false);
    const summary = '**Executive Summary: October 2026**\n\n**Significant Issues**\n* **Smiths:** gate forced.\n- Lock failed.\n\nFirst.\nSecond line.';
    const written = sections.monthlyActivityBlocks(data, activityLinesFixture, { summary }) ?? [];
    const writtenEnd = written.findIndex((block) => block.kind === 'section' && 'title' in block && block.title === 'At a Glance');
    const rich = written.slice(1, writtenEnd).flatMap((block) => (block.kind === 'rich' && 'runs' in block && 'style' in block ? [{ style: block.style, runs: block.runs }] : []));
    expect(rich).toEqual(summaryMarkup(summary).slice(1));
    expect(sections.summaryMarkup(summary)).toEqual(summaryMarkup(summary));

    for (const raw of activityLinesFixture.lines) expect(activityLineKey(raw)).toBe(sections.activityLineKey(raw));
    expect(activityLineKey({ d: '2026-10-14', t: '09:30', p: 'Smiths', k: 'event', c: 'patrol_visit', ti: '', n: 'Gate chain cut, log winched aside', ac: 'Reported' })).toBe('v1:0fe9500921b782');
    expect(activityLineKey({})).toBe('v1:15202279b28c9e');

    const target = lines.find((entry) => entry.kind !== 'incident' && entry.note)!;
    const decision = { lineKey: target.key, decision: 'incident', incidentType: 'trespass' } as IncidentTriage;
    const triagedPdf = sections.applyIncidentTriage(activityLinesFixture, [{ line_key: target.key, decision: 'incident', incident_type: 'trespass' }]);
    const triagedWeb = applyIncidentTriage(lines, new Map([[target.key, decision]]));
    const confirmedBlocks = (sections.monthlyActivityBlocks(data, triagedPdf) ?? []).filter(isEntry);
    expect(confirmedBlocks.map(asWeb)).toEqual([
      ...triagedWeb.filter(isIncidentLine),
      ...REVIEW_SECTIONS.flatMap((review) => triagedWeb.filter((entry) => reviewSectionCode(entry) === review.code)),
    ].map(withPlace));
    const pdfGallery = monthly.find((block): block is { kind: 'gallery'; photos: Array<{ ref: { b: string; p: string }; caption: string }> } => block.kind === 'gallery');
    expect(pdfGallery?.photos.map((photo) => ({ ref: { bucket: photo.ref.b, path: photo.ref.p }, caption: photo.caption })) ?? []).toEqual(gallery);
  });
});

describe('activity accounting', () => {
  it('reads the provider accounting result', () => {
    const result = readActivityAccounting({
      version: 1,
      packUpdatedAt: '2026-09-30T00:00:00Z',
      checkedAt: '2026-10-01T00:00:00Z',
      freshness: { hasFrozenReport: true, frozenEntries: 6, liveEntries: 7, matchesLive: false, changedCategories: [{ code: 'pest_control', frozen: 3, live: 4 }] },
      provenance: { events: { inScope: 4, withLedger: 3, withoutLedger: 1 }, observations: { inScope: 1, withLedger: 0, withoutLedger: 1 }, sources: [{ sourceFile: 'rm.xlsx', sourceSheet: 'Log', batchStatus: 'completed', batchRows: 10, batchDuplicates: 0, batchUnresolved: null, events: 3, observations: 0 }] },
      clientMonth: { entries: 9, thisAgreement: 7, otherAgreements: 0, noAgreementPlace: 2, unlinkedPlaces: [{ place: null, entries: 2 }] },
      exceptions: { futureDated: 2, sparseYears: [{ year: 2926, entries: 2 }], supersededDuplicates: 1 },
    });
    expect(result?.freshness.matchesLive).toBe(false);
    expect(result?.packUpdatedAt).toBe('2026-09-30T00:00:00Z');
    expect(result?.provenance.sources[0].batchUnresolved).toBeNull();
    expect(result?.clientMonth.unlinkedPlaces[0].place).toBe('No place recorded');
    expect(result?.exceptions.sparseYears).toEqual([{ year: 2926, entries: 2 }]);
    expect(readActivityAccounting({ version: 2 })).toBeNull();
  });

  it('maps server errors to safe, specific messages', () => {
    expect(activityAccountingProblem({ message: 'Provider administrator access required' }).kind).toBe('permission');
    expect(activityAccountingProblem({ message: 'Authenticated provider administrator required' }).kind).toBe('permission');
    expect(activityAccountingProblem({ code: 'PGRST202', message: 'Could not find the function' }).kind).toBe('unavailable');
    expect(activityAccountingProblem({ message: 'Report pack not found' }).kind).toBe('missing');
    const generic = activityAccountingProblem({ message: 'canceling statement due to statement timeout' });
    expect(generic.kind).toBe('error');
    expect(generic.message).not.toContain('statement');
    expect(activityAccountingProblem(null).kind).toBe('error');
  });
});
