import { useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw, ShieldCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
  activityAccountingProblem,
  activityLabel,
  activityLineDetail,
  formatActivityNumber,
  formatNzDate,
  humaniseCode,
  readActivityAccounting,
  readActivityLines,
  readActivityReport,
  type AccountingProblem,
  type ActivityAccounting,
  type ActivityLine,
  type ActivityReport,
} from '../lib/reportActivity';
import './ReportActivityReview.css';

const LINE_PAGE = 200;
const count = (value: number) => formatActivityNumber(value);
const counted = (value: number, one: string, many: string) => `${count(value)} ${value === 1 ? one : many}`;
const hours = (value: number) => formatActivityNumber(value, 2);
const km = (value: number) => formatActivityNumber(value, 1);
const REGENERATE_HINT = 'Use Generate report drafts for this period to refresh it. The pack returns to draft for review.';
const REFRESH_HINT = 'This report pack changed since you opened it. Refresh the report list and reopen it before reviewing activity.';

type Column = { label: string; numeric?: boolean };
type Label = (dim: string, code: string) => string;

type LinesState =
  | { state: 'idle' | 'loading' | 'missing' | 'stale' }
  | { state: 'error'; message: string }
  | { state: 'ready'; lines: ActivityLine[]; notItemised: number };

type AccountingState =
  | { state: 'idle' | 'loading' }
  | { state: 'problem'; problem: AccountingProblem }
  | { state: 'ready'; result: ActivityAccounting };

function ActivityTable({ label, columns, rows, className }: { label: string; columns: Column[]; rows: string[][]; className?: string }) {
  return (
    <div className={`reports-table-wrapper report-activity-table${className ? ` ${className}` : ''}`} role="region" aria-label={label} tabIndex={0}>
      <table className="reports-table">
        <thead>
          <tr>{columns.map((column) => <th key={column.label} scope="col" className={column.numeric ? 'is-numeric' : undefined}>{column.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => <td key={cellIndex} className={columns[cellIndex]?.numeric ? 'is-numeric' : undefined}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Group({ title, meta, children, onOpen }: { title: string; meta: string; children: ReactNode; onOpen?: () => void }) {
  return (
    <details className="report-activity-group" onToggle={(event) => { if (event.currentTarget.open) onOpen?.(); }}>
      <summary>{title}<span>{meta}</span></summary>
      <div className="report-activity-group-body">{children}</div>
    </details>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <p className="report-activity-empty">{children}</p>;

function placeMix(categories: Record<string, number>, label: Label): string {
  return Object.entries(categories)
    .filter(([, entries]) => entries > 0)
    .sort(([leftCode, left], [rightCode, right]) => right - left || leftCode.localeCompare(rightCode))
    .slice(0, 3)
    .map(([code, entries]) => `${label('category', code)} ${count(entries)}`)
    .join(', ');
}

function AccountingResult({ result, status, label }: { result: ActivityAccounting; status: string; label: Label }) {
  const { freshness, provenance, clientMonth, exceptions } = result;
  const checked = result.checkedAt
    ? new Date(result.checkedAt).toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland', dateStyle: 'medium', timeStyle: 'short' })
    : '';
  const hasExceptions = exceptions.futureDated > 0 || exceptions.sparseYears.length > 0 || exceptions.supersededDuplicates > 0;
  return (
    <>
      {freshness.matchesLive ? (
        <p className="report-activity-ok"><ShieldCheck size={16} aria-hidden="true" /> This pack matches live records: {counted(freshness.liveEntries, 'entry', 'entries')}{checked ? `, checked ${checked}` : ''}.</p>
      ) : (
        <div className="report-review-warning report-activity-stale" role="note">
          <AlertTriangle size={17} aria-hidden="true" />
          <div>
            <p>
              {freshness.frozenEntries !== null && freshness.frozenEntries !== freshness.liveEntries
                ? `Live records have changed since this pack was generated: ${counted(freshness.frozenEntries, 'entry', 'entries')} in the pack, ${count(freshness.liveEntries)} now.`
                : 'Live activity details have changed since this pack was generated. Summary statistics or itemised lines differ.'}
            </p>
            <p>{status === 'sent' ? 'This pack has been sent and stays as delivered. Record any correction in next month\u2019s report or a follow-up note.' : REGENERATE_HINT}</p>
          </div>
        </div>
      )}
      {!freshness.matchesLive && freshness.changedCategories.length > 0 && (
        <ActivityTable
          label="Categories that changed since generation"
          columns={[{ label: 'Category' }, { label: 'In pack', numeric: true }, { label: 'Live', numeric: true }]}
          rows={freshness.changedCategories.map((row) => [label('category', row.code), count(row.frozen), count(row.live)])}
        />
      )}

      <h6>Import provenance</h6>
      <ul className="report-activity-facts">
        <li>Patrol-log entries: {count(provenance.events.inScope)} in scope, {count(provenance.events.withLedger)} traced to an import file, {count(provenance.events.withoutLedger)} with no import record.</li>
        <li>Observations: {count(provenance.observations.inScope)} in scope, {count(provenance.observations.withLedger)} traced to an import file, {count(provenance.observations.withoutLedger)} with no import record.</li>
      </ul>
      <p className="report-review-source-note">Entries with no import record were captured in the app or imported before the import ledger existed.</p>
      {provenance.sources.length > 0 && (
        <ActivityTable
          label="Import source files"
          columns={[{ label: 'Source file' }, { label: 'Sheet' }, { label: 'Batch' }, { label: 'Patrol-log entries', numeric: true }, { label: 'Observations', numeric: true }, { label: 'Unresolved rows', numeric: true }]}
          rows={provenance.sources.map((source) => [
            source.sourceFile,
            source.sourceSheet || '—',
            source.batchStatus ? humaniseCode(source.batchStatus) : 'Unknown',
            count(source.events),
            count(source.observations),
            source.batchUnresolved === null ? '—' : count(source.batchUnresolved),
          ])}
        />
      )}

      <h6>Client records this period</h6>
      <ul className="report-activity-facts">
        <li>
          {counted(clientMonth.entries, 'client record', 'client records')}: {count(clientMonth.thisAgreement)} at this agreement&rsquo;s places, {count(clientMonth.otherAgreements)} at places on other agreements and {count(clientMonth.noAgreementPlace)} at places not linked to any active agreement.
        </li>
      </ul>
      {clientMonth.noAgreementPlace > 0 && (
        <>
          <p className="report-review-source-note">Records at unlinked places are not in this report. Link the place to an agreement if the work should be reported.</p>
          <ActivityTable
            label="Unlinked places with client records"
            columns={[{ label: 'Place' }, { label: 'Records', numeric: true }]}
            rows={clientMonth.unlinkedPlaces.map((row) => [row.place, count(row.entries)])}
          />
        </>
      )}

      <h6>Data exceptions</h6>
      {hasExceptions ? (
        <ul className="report-activity-facts">
          {exceptions.futureDated > 0 && <li>{count(exceptions.futureDated)} client records across all periods are dated in the future. Correct the dates in the source file and re-import.</li>}
          {exceptions.sparseYears.length > 0 && <li>Years with fewer than 50 client records (check for date entry errors): {exceptions.sparseYears.map((year) => `${year.year} (${count(year.entries)})`).join(', ')}.</li>}
          {exceptions.supersededDuplicates > 0 && <li>{count(exceptions.supersededDuplicates)} superseded or duplicate imports in this period were set aside and are not counted.</li>}
        </ul>
      ) : (
        <p className="report-activity-ok"><ShieldCheck size={16} aria-hidden="true" /> No date or duplicate exceptions found.</p>
      )}
    </>
  );
}

function ActivityReportBody({ packId, updatedAt, report, status, headingId }: { packId: string; updatedAt: string; report: ActivityReport; status: string; headingId: string }) {
  const [lines, setLines] = useState<LinesState>({ state: 'idle' });
  const [accounting, setAccounting] = useState<AccountingState>({ state: 'idle' });
  const [category, setCategory] = useState('all');
  const [visible, setVisible] = useState(LINE_PAGE);
  const label: Label = (dim, code) => activityLabel(report, dim, code);
  const { totals, accountedFor, pest, observations } = report;

  // A ref, not state: two toggle events in one render would both see the old state and fetch twice.
  const linesRequest = useRef<'idle' | 'loading' | 'done'>('idle');

  const loadLines = async () => {
    if (linesRequest.current !== 'idle') return;
    linesRequest.current = 'loading';
    setLines({ state: 'loading' });
    const { data: row, error } = await supabase.from('monthly_report_packs').select('activity_lines,updated_at').eq('id', packId).maybeSingle();
    if (error || !row) {
      linesRequest.current = 'idle';
      setLines({ state: 'error', message: error ? 'Itemised activity could not be loaded. Try again.' : 'This report pack is no longer available. Refresh the report list.' });
      return;
    }
    linesRequest.current = 'done';
    if (row.updated_at !== updatedAt) {
      setLines({ state: 'stale' });
      return;
    }
    const parsed = readActivityLines(row.activity_lines);
    setLines(parsed ? { state: 'ready', ...parsed } : { state: 'missing' });
  };

  const checkAccounting = async () => {
    setAccounting({ state: 'loading' });
    const { data: result, error } = await supabase.rpc('get_report_pack_activity_accounting', { p_pack_id: packId });
    const parsed = error ? null : readActivityAccounting(result);
    if (parsed && parsed.packUpdatedAt !== updatedAt) {
      setAccounting({ state: 'problem', problem: { kind: 'stale', message: REFRESH_HINT } });
      return;
    }
    setAccounting(parsed ? { state: 'ready', result: parsed } : { state: 'problem', problem: activityAccountingProblem(error) });
  };

  const statement = [
    `${counted(accountedFor.entries, 'entry', 'entries')} reported: ${counted(accountedFor.activityEvents, 'patrol-log entry', 'patrol-log entries')}, ${counted(accountedFor.observationsInScope, 'observation', 'observations')} and ${counted(accountedFor.workOrdersInScope, 'workshop work order', 'workshop work orders')}.`,
    accountedFor.mirrorEventsExcluded > 0 ? `${counted(accountedFor.mirrorEventsExcluded, 'automatic patrol-log copy of an observation was', 'automatic patrol-log copies of observations were')} excluded so nothing is counted twice.` : '',
    accountedFor.unclassified > 0 ? `${counted(accountedFor.unclassified, 'entry has', 'entries have')} no work type recorded and ${accountedFor.unclassified === 1 ? 'shows' : 'show'} as \u201cNot yet classified\u201d.` : '',
  ].filter(Boolean).join(' ');

  const metrics: Array<[string, string]> = [
    ['Activity entries', count(totals.entries)],
    ['Places', count(totals.places)],
    ['Work hours', hours(totals.hours)],
    ['Travel (km)', km(totals.travelKm)],
    ['Photos', count(totals.photos)],
    ['Patrol visits', count(totals.patrolVisits)],
    ['Camera activations', count(totals.cameraActivations)],
    ['Observations', count(totals.observations)],
    ['Work orders', count(totals.workOrders)],
  ];
  if (totals.unattributedEntries > 0) metrics.push(['Entries without a visit', count(totals.unattributedEntries)]);

  const readyLines = lines.state === 'ready' ? lines.lines : [];
  const filteredLines = category === 'all' ? readyLines : readyLines.filter((line) => line.category === category);
  const lineCategories = report.categories.filter((row) => readyLines.some((line) => line.category === row.code));
  const filterId = `report-activity-filter-${packId}`;

  return (
    <section className="report-activity" aria-labelledby={headingId}>
      <div className="report-activity-heading">
        <div>
          <h4 id={headingId}>Month-end activity</h4>
          <p>Frozen when this pack was generated from agreement-linked places. Values cannot be edited here.</p>
        </div>
        <span className={`badge ${accountedFor.reconciled ? 'badge-success' : 'badge-warning'}`}>
          {accountedFor.reconciled ? (accountedFor.entries === 1 ? '1 entry accounted for' : `All ${count(accountedFor.entries)} entries accounted for`) : 'Totals need review'}
        </span>
      </div>

      <div className="report-activity-metrics" role="group" aria-label="Month-end activity totals">
        {metrics.map(([name, value]) => <div key={name}><span>{name}</span><strong>{value}</strong></div>)}
      </div>
      <p className="report-review-source-note">{statement}</p>
      {!accountedFor.reconciled && (
        <p className="report-review-warning" role="note"><AlertTriangle size={17} aria-hidden="true" /> The record, category and place totals in this pack do not agree. Regenerate the draft and run the live accounting check before publishing.</p>
      )}
      {report.basis && <p className="report-review-source-note">{report.basis}</p>}

      <h5>Activity by category</h5>
      {report.categories.length > 0 ? (
        <ActivityTable
          label="Activity by category"
          columns={[{ label: 'Category' }, { label: 'Entries', numeric: true }, { label: 'Hours', numeric: true }, { label: 'km', numeric: true }, { label: 'Photos', numeric: true }]}
          rows={report.categories.map((row) => [label('category', row.code), count(row.entries), hours(row.hours), km(row.km), count(row.photos)])}
        />
      ) : (
        <Empty>No activity was recorded at the places covered by this agreement during the period.</Empty>
      )}

      <Group title="Activity by place" meta={`${count(report.byPlace.length)} places`}>
        {report.byPlace.length > 0 ? (
          <ActivityTable
            label="Activity by place"
            columns={[{ label: 'Place' }, { label: 'Entries', numeric: true }, { label: 'Hours', numeric: true }, { label: 'km', numeric: true }, { label: 'Photos', numeric: true }, { label: 'Main activity' }]}
            rows={report.byPlace.map((row) => [row.place, count(row.entries), hours(row.hours), km(row.km), count(row.photos), placeMix(row.categories, label)])}
          />
        ) : <Empty>No place recorded activity during the period.</Empty>}
      </Group>

      <Group title="Pest control" meta={`${counted(pest.entries, 'entry', 'entries')} \u00b7 ${hours(pest.hours)} h`}>
        {pest.entries > 0 ? (
          <>
            <p className="report-review-source-note">{counted(pest.entries, 'entry', 'entries')}, {hours(pest.hours)} hours, {km(pest.km)} km. Species counts are recorded entries, not a population estimate.</p>
            {pest.bySpecies.length > 0 && (
              <ActivityTable
                label="Pest control by species"
                columns={[{ label: 'Species' }, { label: 'Culls', numeric: true }, { label: 'Sightings', numeric: true }, { label: 'Other', numeric: true }, { label: 'Total', numeric: true }]}
                rows={pest.bySpecies.map((row) => [label('species', row.code), count(row.culls), count(row.sightings), count(row.other), count(row.total)])}
              />
            )}
            {pest.byActivity.length > 0 && (
              <ActivityTable
                label="Pest control by activity"
                columns={[{ label: 'Activity' }, { label: 'Entries', numeric: true }, { label: 'Hours', numeric: true }]}
                rows={pest.byActivity.map((row) => [label('activity', row.code), count(row.entries), hours(row.hours)])}
              />
            )}
            {pest.byEquipment.length > 0 && (
              <ActivityTable
                label="Traps, bait stations and equipment"
                columns={[{ label: 'Traps, bait stations and equipment' }, { label: 'Entries', numeric: true }]}
                rows={pest.byEquipment.map((row) => [label('equipment', row.code), count(row.entries)])}
              />
            )}
            {pest.ammunition.length > 0 && (
              <ActivityTable
                label="Ammunition by calibre"
                columns={[{ label: 'Ammunition calibre' }, { label: 'Entries', numeric: true }, { label: 'Rounds recorded', numeric: true }]}
                rows={pest.ammunition.map((row) => [
                  row.calibre && row.calibre !== 'unspecified' ? row.calibre : 'Calibre not recorded',
                  count(row.entries),
                  row.rounds === null ? 'Not recorded' : count(row.rounds),
                ])}
              />
            )}
          </>
        ) : <Empty>No pest-control activity was recorded at the places covered by this agreement during the period.</Empty>}
      </Group>

      {([
        ['maintenance', 'Maintenance and repairs', 'No maintenance or repair work was recorded during the period.'],
        ['manufacture', 'Manufacture and fabrication', 'No manufacture or fabrication work was recorded during the period.'],
      ] as const).map(([key, title, empty]) => {
        const work = report[key];
        return (
          <Group key={key} title={title} meta={`${counted(work.entries, 'entry', 'entries')} \u00b7 ${hours(work.hours)} h`}>
            {work.entries > 0 ? (
              <>
                <p className="report-review-source-note">{counted(work.entries, 'entry', 'entries')}, {hours(work.hours)} hours, {km(work.km)} km. Workshop work orders: {count(work.completed)} completed, {count(work.open)} in progress or approved.</p>
                {work.bySubject.length > 0 && (
                  <ActivityTable
                    label={`${title} by item`}
                    columns={[{ label: 'Item worked on' }, { label: 'Entries', numeric: true }, { label: 'Hours', numeric: true }]}
                    rows={work.bySubject.map((row) => [label('subject', row.code) || 'Not specified', count(row.entries), hours(row.hours)])}
                  />
                )}
              </>
            ) : <Empty>{empty}</Empty>}
          </Group>
        );
      })}

      <Group title="Observations and photos" meta={`${counted(observations.total, 'observation', 'observations')} \u00b7 ${counted(totals.photos, 'photo', 'photos')}`}>
        {observations.byModule.length > 0 ? (
          <ActivityTable
            label="Observations by type"
            columns={[{ label: 'Observation type' }, { label: 'Observations', numeric: true }, { label: 'With photo', numeric: true }, { label: 'Photos', numeric: true }]}
            rows={observations.byModule.map((row) => [label('module', row.module), count(row.entries), count(row.withPhoto), count(row.photos)])}
          />
        ) : <Empty>No observations were recorded at the places covered by this agreement during the period.</Empty>}
        <p className="report-review-source-note">Photos attached to patrol-log entries: {count(observations.eventPhotos)}. Photos attached to observations: {count(observations.photos)}.</p>
      </Group>

      <Group title="Itemised activity" meta={counted(accountedFor.itemised, 'line', 'lines')} onOpen={() => void loadLines()}>
        <div className="report-activity-lines" aria-live="polite">
          {lines.state === 'loading' && <p className="report-activity-empty" role="status">Loading itemised activity…</p>}
          {lines.state === 'error' && (
            <div className="alert alert-error report-activity-retry" role="alert">
              <span>{lines.message}</span>
              <button type="button" className="btn btn-secondary" onClick={() => void loadLines()}>Retry</button>
            </div>
          )}
          {lines.state === 'missing' && <Empty>Itemised lines are not stored for this pack. {status === 'sent' ? 'It has been sent and is kept as delivered.' : REGENERATE_HINT}</Empty>}
          {lines.state === 'ready' && readyLines.length === 0 && (
            <Empty>{totals.entries > 0 ? 'Itemised lines are not available for this report pack.' : 'No activity was recorded during the period, so there is nothing to itemise.'}</Empty>
          )}
          {lines.state === 'stale' && <p className="report-review-warning" role="status">{REFRESH_HINT}</p>}
          {lines.state === 'ready' && readyLines.length > 0 && (
            <>
              <div className="report-activity-filter">
                <label htmlFor={filterId}>Category</label>
                <select id={filterId} value={category} onChange={(event) => { setCategory(event.target.value); setVisible(LINE_PAGE); }}>
                  <option value="all">All categories ({count(readyLines.length)})</option>
                  {lineCategories.map((row) => (
                    <option key={row.code} value={row.code}>{label('category', row.code)} ({count(readyLines.filter((line) => line.category === row.code).length)})</option>
                  ))}
                </select>
                <span role="status">Showing {count(Math.min(visible, filteredLines.length))} of {count(filteredLines.length)}</span>
              </div>
              <ActivityTable
                label="Itemised activity lines"
                className="report-activity-lines-table"
                columns={[{ label: 'Date' }, { label: 'Place' }, { label: 'Category' }, { label: 'Detail' }, { label: 'Ref' }, { label: 'Hours', numeric: true }, { label: 'km', numeric: true }]}
                rows={filteredLines.slice(0, visible).map((line) => [
                  formatNzDate(line.date),
                  line.place,
                  label('category', line.category),
                  activityLineDetail(report, line),
                  line.job,
                  line.hours > 0 ? hours(line.hours) : '',
                  line.km > 0 ? km(line.km) : '',
                ])}
              />
              {filteredLines.length > visible && (
                <button type="button" className="btn btn-secondary report-activity-more" onClick={() => setVisible((current) => current + LINE_PAGE)}>
                  Show {count(Math.min(LINE_PAGE, filteredLines.length - visible))} more
                </button>
              )}
              <p className="report-review-source-note">
                New Zealand dates. Free-text notes, staff and vehicle details are not included.
                {lines.notItemised > 0 && ` ${counted(lines.notItemised, 'further entry is', 'further entries are')} counted in the totals but ${lines.notItemised === 1 ? 'is' : 'are'} not itemised because of the line limit.`}
              </p>
            </>
          )}
        </div>
      </Group>

      <div className="report-activity-check">
        <div className="report-activity-check-heading">
          <div>
            <h5>Live accounting check</h5>
            <p>Provider only. Compares this pack with live records and traces entries to their import files. Nothing here is shared with the client.</p>
          </div>
          <button type="button" className="btn btn-secondary" onClick={() => void checkAccounting()} disabled={accounting.state === 'loading'}>
            <RefreshCw size={15} aria-hidden="true" />
            {accounting.state === 'loading' ? 'Checking…' : accounting.state === 'ready' ? 'Check again' : 'Check against live records'}
          </button>
        </div>
        <div aria-live="polite">
          {accounting.state === 'problem' && (
            <div className={`alert ${accounting.problem.kind === 'error' ? 'alert-error' : 'alert-info'}`} role={accounting.problem.kind === 'error' ? 'alert' : 'status'}>
              {accounting.problem.message}
            </div>
          )}
          {accounting.state === 'ready' && <AccountingResult result={accounting.result} status={status} label={label} />}
        </div>
      </div>
    </section>
  );
}

interface ReportActivityReviewProps {
  packId: string;
  updatedAt: string;
  data: Record<string, unknown> | null;
  status: string;
}

export function ReportActivityReview({ packId, updatedAt, data, status }: ReportActivityReviewProps) {
  const report = useMemo(() => readActivityReport(data), [data]);
  const headingId = `report-activity-${packId}`;
  if (!report) {
    return (
      <section className="report-activity" aria-labelledby={headingId}>
        <h4 id={headingId}>Month-end activity</h4>
        <p className="report-activity-notice" role="note">
          This pack was generated before categorised month-end activity reporting.{' '}
          {status === 'sent' ? 'It has been sent and is kept exactly as delivered.' : 'Use Generate report drafts for this period to add the activity summary and itemised lines. The pack returns to draft for review.'}
        </p>
      </section>
    );
  }
  return <ActivityReportBody key={`${packId}:${updatedAt}`} packId={packId} updatedAt={updatedAt} report={report} status={status} headingId={headingId} />;
}
