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
  isRoutineCheck,
  routineCheckRows,
  REVIEW_SECTIONS,
  reviewSectionCode,
  siteLogGroups,
  summaryMarkup,
  textParagraphs,
  activityLineKey,
  applyIncidentTriage,
  clientActivityReport,
  isInternalWorkLine,
  isIncidentLine,
  isReportedLine,
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

  it('keeps administration out of the report unless it is confirmed as an incident, and keeps card reviews', () => {
    const parsed = readActivityLines({
      version: 2,
      lines: [
        { d: '2026-10-08', t: '00:00', p: 'HQ', k: 'event', c: 'administration', n: 'Permits reconciled.' },
        { d: '2026-10-09', t: '00:00', p: 'Smiths', k: 'event', c: 'administration', ti: 'Card review', n: 'Two vehicles at the gate.' },
        { d: '2026-10-10', t: '00:00', p: 'HQ', k: 'event', c: 'travel_admin', n: 'Fuel card missing from the office.' },
      ],
    })!;
    expect(parsed.lines.map((item) => item.withheld)).toEqual([true, false, true]);
    expect(reviewSectionCode(parsed.lines[1])).toBe('observation');
    const triage = new Map<string, IncidentTriage>([[parsed.lines[2].key, { decision: 'incident', incidentType: 'theft' } as IncidentTriage]]);
    const reported = applyIncidentTriage(parsed.lines, triage).filter(isReportedLine);
    expect(reported.map((item) => item.note)).toEqual(['Two vehicles at the gate.', 'Fuel card missing from the office.']);
    expect(isIncidentLine(reported[1])).toBe(true);
  });

  it('drops administration from every aggregate of an older pack', () => {
    const first = activityReportFixture.byPlace[0];
    const older = readActivityReport({ activityReport: {
      ...activityReportFixture,
      totals: { ...activityReportFixture.totals, entries: activityReportFixture.totals.entries + 4, places: activityReportFixture.totals.places + 1 },
      categories: [...activityReportFixture.categories, { code: 'administration', entries: 4, photos: 0 }],
      byPlace: [
        { ...first, entries: first.entries + 1, categories: { ...first.categories, administration: 1 } },
        ...activityReportFixture.byPlace.slice(1),
        { place: 'HQ', entries: 3, photos: 0, categories: { administration: 3 } },
      ],
    } })!;
    expect(older.totals.entries).toBe(report.totals.entries);
    expect(older.totals.places).toBe(report.byPlace.length);
    expect(older.byPlace).toEqual(report.byPlace);
    expect(older.categories).toEqual(report.categories);
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

  it('titles an attended call-out and labels its response times', () => {
    const [callOut] = readActivityLines({
      version: 2,
      lines: [{
        d: '2026-11-04', t: '22:44', p: 'Burger N Beast Richmond', k: 'event', c: 'call_out',
        ti: 'Call-out attended: Patrol Support (high priority)',
        n: 'No one inside during site visit.',
        ac: 'Requested 22:32, on scene 22:44 (12 min response; 30 min target met), completed 23:07.',
      }],
    })!.lines;
    const entry = describeActivityLine(report, callOut);
    expect(entry.title).toBe('Call-out attended: Patrol Support (high priority)');
    expect(entry.lines).toEqual([
      { text: 'No one inside during site visit.' },
      { label: 'Response', text: 'Requested 22:32, on scene 22:44 (12 min response; 30 min target met), completed 23:07.' },
    ]);
  });
});

describe('siteLogGroups', () => {
  it('groups by location and keeps incidents, observations and routine checks out of the site log', () => {
    const groups = siteLogGroups(lines);
    expect(groups.map((group) => group.place)).toEqual(['Alpha Reserve']);
    expect(lines.some((entry) => reviewSectionCode(entry) === 'observation')).toBe(true);
    expect(lines.filter(isRoutineCheck)).toHaveLength(2);
    expect(groups[0].lines.some((entry) => entry.kind === 'incident' || isRoutineCheck(entry))).toBe(false);
  });

  it('treats only short status-only patrols and checks as routine', () => {
    const base = line(0);
    const check = (patch: Partial<ActivityLine>) => isRoutineCheck({ ...base, kind: 'event', category: 'inspection', action: '', photos: 0, photoRefs: [], materials: [], note: '', confirmedType: null, ...patch } as ActivityLine);
    expect(check({ note: 'Secure' })).toBe(true);
    expect(check({ note: '4 vehicles all permitted.' })).toBe(true);
    expect(check({ note: 'Large log beside gate freshly pulled out' })).toBe(false);
    expect(check({ note: 'Secure', photos: 1 })).toBe(false);
    expect(check({ note: 'Secure', action: 'Relocked' })).toBe(false);
    expect(check({ category: 'work_order' })).toBe(false);
  });
});

describe('parity with the client PDF renderer', () => {
  it('projects identical client figures and exclusions without removing original incident-review records', async () => {
    const sections = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(readFileSync(SECTIONS_PATH)).toString('base64')}`) as {
      clientActivitySnapshot: (data: unknown, lines: unknown) => { report: unknown; lines: unknown[] };
      isInternalWorkLine: (line: unknown) => boolean;
    };
    const raw = [
      { d: '2026-10-01', p: 'A', k: 'event', c: 'maintenance', s: 'camera', n: 'Replace battery.', ph: 1 },
      { d: '2026-10-02', p: 'A', k: 'event', c: 'installation_removal', s: 'camera', n: 'Remove Tapo.' },
      { d: '2026-10-03', p: 'A', k: 'event', c: 'inspection', s: 'gate', n: 'Open', ph: 1 },
      { d: '2026-10-04', p: 'A', k: 'event', c: 'maintenance', s: 'camera', ti: 'Card review', n: 'Vehicle seen.', ph: 1 },
      { d: '2026-10-05', p: 'A', k: 'event', c: 'maintenance', s: 'camera', n: 'Lens damaged.', tri: 'surveillance_tampering' },
      { d: '2026-10-06', p: 'A', k: 'event', c: 'maintenance', s: 'gate', n: 'Gate hinge repaired.' },
    ];
    const input = { version: 2, lines: raw };
    const source = readActivityLines(input)!.lines;
    const parsed = applyIncidentTriage(source, new Map([[source[4].key, {
      lineKey: source[4].key, decision: 'incident', incidentType: 'surveillance_tampering',
      bobFlagged: false, bobType: '', bobReason: '', bobConfidence: null,
      note: '', decidedAt: '', inSentReport: false,
    }]]));
    expect(parsed).toHaveLength(6);
    expect(parsed.map(isInternalWorkLine)).toEqual([true, true, true, false, false, false]);
    expect(parsed.map(isInternalWorkLine)).toEqual(raw.map(sections.isInternalWorkLine));
    const client = clientActivityReport(report, parsed);
    const pdf = sections.clientActivitySnapshot({ activityReport: activityReportFixture }, input);
    expect(client).toEqual(readActivityReport({ activityReport: pdf.report }));
    expect(pdf.lines).toHaveLength(3);
    expect(client.totals.entries).toBe(report.totals.entries - 3);
    expect(client.totals.photos).toBe(report.totals.photos - 2);
    expect(report.totals.entries).toBe(9);
    expect(siteLogGroups(parsed).flatMap((group) => group.lines)).toHaveLength(1);
  });

  it('produces the same entries, locations and routine checks as report-activity-sections.mjs', async () => {
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
    expect(logBlocks.filter(isEntry).map(asWeb)).toEqual(groups.flatMap((group) => group.lines.map((entry) => describeActivityLine(report, entry))));
    expect(logBlocks.filter((block): block is { kind: 'subsection'; title: string; detail?: string } => block.kind === 'subsection'))
      .toEqual(groups.map((group) => ({ kind: 'subsection', title: group.place, detail: countedText(group.lines.length, 'entry', 'entries') })));
    expect(logBlocks.some((block) => block.kind === 'text' && 'text' in block && /routine patrol/.test(block.text))).toBe(false);
    // Both client views omit routine statuses; the source remains available to incident review.
    const routineChecks = routineCheckRows(report, lines).reduce((total, row) => total + row.checks, 0);
    expect(routineChecks).toBeGreaterThan(0);
    expect((sections.monthlyActivityBlocks(data, activityLinesFixture) ?? [])
      .some((block) => block.kind === 'text' && 'text' in block && block.text.startsWith(`${routineChecks} routine patrol`))).toBe(false);

    const incidentBlocks = (sections.monthlyActivityBlocks(data, activityLinesFixture) ?? []).filter(isEntry);
    const withPlace = (entry: ActivityLine) => {
      const described = describeActivityLine(report, entry);
      return { ...described, tags: [entry.place, ...described.tags] };
    };
    expect(incidentBlocks.map(asWeb)).toEqual([
      ...lines.filter((entry) => entry.kind === 'incident'),
      ...REVIEW_SECTIONS.flatMap((review) => lines.filter((entry) => reviewSectionCode(entry) === review.code)),
      ...['maintenance', 'manufacture'].flatMap((work) => lines.filter((entry) => !isIncidentLine(entry) && entry.category === work)),
    ].map(withPlace));

    const monthly = sections.monthlyActivityBlocks(data, activityLinesFixture) ?? [];
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
      ...['maintenance', 'manufacture'].flatMap((work) => triagedWeb.filter((entry) => !isIncidentLine(entry) && entry.category === work)),
    ].map(withPlace));
    expect(monthly.some((block) => block.kind === 'gallery')).toBe(false);
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
