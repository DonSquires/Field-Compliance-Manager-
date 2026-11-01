import { describe, expect, it } from 'vitest';
import {
  activityAccountingProblem,
  activityLabel,
  activityLineDetail,
  formatNzDate,
  readActivityAccounting,
  readActivityLines,
  readActivityReport,
} from './reportActivity';
import { activityReportFixture } from './reportActivity.fixture';

describe('readActivityReport', () => {
  it('reads a version 1 report and fills safe defaults', () => {
    const report = readActivityReport({ activityReport: activityReportFixture });
    expect(report?.totals).toMatchObject({ entries: 6, travelKm: 19.5, hours: 3.5, photos: 4 });
    expect(report?.byPlace[1].place).toBe('Not place-specific');
    expect(report?.pest.ammunition[1]).toEqual({ calibre: 'unspecified', entries: 1, rounds: null });
    expect(report?.maintenance).toMatchObject({ completed: 1, open: 0 });
    expect(report?.accountedFor.reconciled).toBe(true);
  });

  it('treats legacy, malformed and future-version data as absent', () => {
    expect(readActivityReport(null)).toBeNull();
    expect(readActivityReport({ patrolVisits: 3 })).toBeNull();
    expect(readActivityReport({ activityReport: { version: 2, totals: {} } })).toBeNull();
    expect(readActivityReport({ activityReport: { version: 1 } })).toBeNull();
    expect(readActivityReport({ activityReport: [] })).toBeNull();
  });

  it('labels codes like the PDF renderer', () => {
    const report = readActivityReport({ activityReport: activityReportFixture })!;
    expect(activityLabel(report, 'species', 'goat')).toBe('Goat');
    expect(activityLabel(report, 'subject', 'water_trough')).toBe('Water trough');
    expect(activityLabel(report, 'serviceLine', 'none')).toBe('No source category');
    expect(activityLabel(report, 'module', 'unknown')).toBe('Not specified');
    expect(activityLabel(report, 'activity', '')).toBe('');
  });
});

describe('readActivityLines', () => {
  it('reads compact lines and builds the same detail text as the PDF appendix', () => {
    const report = readActivityReport({ activityReport: activityReportFixture })!;
    const parsed = readActivityLines({
      version: 1,
      notItemised: 2,
      lines: [
        { d: '2026-09-03', p: 'Alpha Reserve', k: 'event', c: 'pest_control', a: 'shooting', sp: 'goat', m: [{ t: 'ammunition', cal: '.223', q: 7 }], h: 1.5, km: 12, ph: 1 },
        { d: '2026-09-04', p: null, k: 'work_order', c: 'maintenance', a: 'maintenance', s: 'gate', j: 'WO-1', ws: 'in_progress' },
      ],
    });
    expect(parsed?.notItemised).toBe(2);
    expect(parsed?.lines[1].place).toBe('Not place-specific');
    expect(activityLineDetail(report, parsed!.lines[0])).toBe('Shooting · Goat · Ammunition .223 × 7 · 1 photo');
    expect(activityLineDetail(report, parsed!.lines[1])).toBe('Work order in progress · Maintenance · Gate');
    expect(readActivityLines({ version: 2, lines: [] })).toBeNull();
    expect(readActivityLines(null)).toBeNull();
  });

  it('formats ISO dates as New Zealand dates', () => {
    expect(formatNzDate('2026-09-03')).toBe('03/09/2026');
    expect(formatNzDate('not a date')).toBe('not a date');
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
