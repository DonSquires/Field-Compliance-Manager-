import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ChevronLeft, ChevronRight, FileText, ImageOff, MapPin, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
  activityAccountingProblem,
  activityLabel,
  countedText,
  describeActivityLine,
  formatActivityNumber,
  humaniseCode,
  isReportPhotoRef,
  NO_PLACE_LABEL,
  readActivityAccounting,
  readActivityLines,
  readActivityReport,
  routineSummary,
  siteLogGroups,
  type AccountingProblem,
  type ActivityAccounting,
  type ActivityEntry,
  type ActivityLine,
  type ActivityReport,
  type ReportPhotoRef,
} from '../lib/reportActivity';
import './ReportActivityReview.css';

const ENTRY_PAGE = 60;
const PHOTOS_PER_ENTRY = 3;
const PHOTO_URL_SECONDS = 900;
const SIGN_BATCH = 100;
const count = (value: number) => formatActivityNumber(value);
const counted = countedText;
const REGENERATE_HINT = 'Use Generate report drafts for this period to refresh it. The pack returns to draft for review.';
const REFRESH_HINT = 'This report pack changed since you opened it. Refresh the report list and reopen it before reviewing activity.';

type Column = { label: string; numeric?: boolean };
type Label = (dim: string, code: string) => string;
type PhotoUrls = Record<string, string | null | undefined>;
type OpenPhoto = (photos: ReportPhotoRef[], index: number, caption: string) => void;
type PhotoError = (ref: ReportPhotoRef, url: string) => void;
type ChipTone = 'neutral' | 'danger' | 'warning' | 'info' | 'success';

type LinesState =
  | { state: 'idle' | 'loading' | 'missing' | 'stale' }
  | { state: 'error'; message: string }
  | { state: 'ready'; lines: ActivityLine[]; notItemised: number };

type AccountingState =
  | { state: 'idle' | 'loading' }
  | { state: 'problem'; problem: AccountingProblem }
  | { state: 'ready'; result: ActivityAccounting };

const photoKey = (ref: ReportPhotoRef) => `${ref.bucket}/${ref.path}`;

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

function Group({ title, meta, children, onToggle, className }: { title: string; meta: string; children: ReactNode; onToggle?: (open: boolean) => void; className?: string }) {
  return (
    <details className={`report-activity-group${className ? ` ${className}` : ''}`} onToggle={(event) => onToggle?.(event.currentTarget.open)}>
      <summary>{title}<span>{meta}</span></summary>
      <div className="report-activity-group-body">{children}</div>
    </details>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <p className="report-activity-empty">{children}</p>;
const Chip = ({ tone = 'neutral', children }: { tone?: ChipTone; children: ReactNode }) => <span className={`report-chip report-chip-${tone}`}>{children}</span>;

function tagTone(tag: string): ChipTone {
  if (/^(High|Critical) severity$/.test(tag)) return 'danger';
  if (/ severity$/.test(tag)) return 'warning';
  if (/^(Resolved|Completed|Closed)$/.test(tag)) return 'success';
  if (/^(Open|Under review|Escalated|In progress|Scheduled)$/.test(tag)) return 'info';
  return 'neutral';
}

function placeMix(categories: Record<string, number>, label: Label): string {
  return Object.entries(categories)
    .filter(([, entries]) => entries > 0)
    .sort(([leftCode, left], [rightCode, right]) => right - left || leftCode.localeCompare(rightCode))
    .slice(0, 3)
    .map(([code, entries]) => `${label('category', code)} ${count(entries)}`)
    .join(', ');
}

interface SummaryChart {
  title: string;
  items: Array<{ label: string; value: number }>;
}

function topSummaryChart(title: string, items: Array<{ label: string; value: number }>): SummaryChart | null {
  const top = items.filter((item) => item.label && item.value > 0)
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label))
    .slice(0, 5);
  return top.length ? { title, items: top } : null;
}

function reportSummaryCharts(report: ActivityReport, label: Label): SummaryChart[] {
  const activity = topSummaryChart('Activity type highlights', report.categories.map((row) => ({
    label: label('category', row.code), value: row.entries,
  })));
  const camera = report.categories.find((row) => row.code === 'camera_activation');
  if (activity && camera && camera.entries > 0
    && !activity.items.some((item) => item.label === label('category', 'camera_activation'))) {
    activity.items.push({ label: label('category', 'camera_activation'), value: camera.entries });
  }
  return [
    activity,
    topSummaryChart('Top locations', report.byPlace.map((row) => ({ label: row.place || NO_PLACE_LABEL, value: row.entries }))),
    topSummaryChart('Pest culls by species', report.pest.bySpecies.map((row) => ({
      label: label('species', row.code), value: row.culls,
    }))),
    topSummaryChart('Hunter animals by species', (report.hunterReturns?.bySpecies ?? []).map((row) => ({
      label: row.species, value: row.animals,
    }))),
  ].filter((chart): chart is SummaryChart => chart !== null);
}

async function signPhotos(bucket: string, paths: string[]): Promise<PhotoUrls> {
  const result: PhotoUrls = {};
  try {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrls(paths, PHOTO_URL_SECONDS);
    if (error) throw error;
    const signed = new Map((data ?? []).filter((item) => item.signedUrl && !item.error && item.path).map((item) => [item.path as string, item.signedUrl]));
    for (const path of paths) result[`${bucket}/${path}`] = signed.get(path) ?? null;
    if (paths.some((path) => result[`${bucket}/${path}`] === null)) console.warn('Some report photos could not be loaded.');
  } catch {
    console.warn('Report photos could not be loaded.');
    for (const path of paths) result[`${bucket}/${path}`] = null;
  }
  return result;
}

/** Requests only visible photos; an explicit retry renews a failed or expired URL. */
function usePhotoUrls() {
  const [urls, setUrls] = useState<PhotoUrls>({});
  const requested = useRef(new Set<string>());
  const pending = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const request = useCallback((refs: ReportPhotoRef[]) => {
    const byBucket = new Map<string, string[]>();
    for (const ref of refs) {
      const key = photoKey(ref);
      if (!isReportPhotoRef(ref) || requested.current.has(key)) continue;
      requested.current.add(key);
      pending.current.add(key);
      byBucket.set(ref.bucket, [...(byBucket.get(ref.bucket) ?? []), ref.path]);
    }
    for (const [bucket, paths] of byBucket) {
      for (let start = 0; start < paths.length; start += SIGN_BATCH) {
        void signPhotos(bucket, paths.slice(start, start + SIGN_BATCH)).then((signed) => {
          for (const key of Object.keys(signed)) pending.current.delete(key);
          if (mounted.current) setUrls((current) => ({ ...current, ...signed }));
        });
      }
    }
  }, []);
  const retry = useCallback((ref: ReportPhotoRef) => {
    const key = photoKey(ref);
    if (pending.current.has(key)) return;
    requested.current.delete(key);
    setUrls((current) => ({ ...current, [key]: undefined }));
    request([ref]);
  }, [request]);
  const failed: PhotoError = useCallback((ref, url) => {
    console.warn('A report photo could not be displayed.');
    const key = photoKey(ref);
    setUrls((current) => current[key] === url ? { ...current, [key]: null } : current);
  }, []);
  return { urls, request, retry, failed };
}

function PhotoStrip({ entry, caption, urls, onOpen, onPhotoError }: { entry: ActivityEntry; caption: string; urls: PhotoUrls; onOpen: OpenPhoto; onPhotoError: PhotoError }) {
  const photos = entry.photos.filter(isReportPhotoRef);
  const shown = photos.slice(0, PHOTOS_PER_ENTRY);
  const unavailable = shown.filter((ref) => urls[photoKey(ref)] === null).length;
  const onFile = Math.max(entry.photoCount - photos.length, 0);
  if (shown.length === 0 && onFile === 0) return null;
  return (
    <div className="report-entry-photos">
      {shown.length > 0 && (
        <ul aria-label={counted(photos.length, 'photo', 'photos')}>
          {shown.map((ref, index) => {
            const url = urls[photoKey(ref)];
            return (
              <li key={photoKey(ref)}>
                <button
                  type="button"
                  className="report-photo-thumb"
                  onClick={() => onOpen(photos, index, caption)}
                  aria-label={url === null ? `Photo ${index + 1} unavailable. Open to retry` : `Open photo ${index + 1} of ${photos.length}`}
                >
                  {url ? <img src={url} alt="" loading="lazy" decoding="async" onError={() => onPhotoError(ref, url)} /> : url === null ? <ImageOff size={20} aria-hidden="true" /> : <span className="report-photo-loading" aria-hidden="true" />}
                </button>
              </li>
            );
          })}
          {photos.length > shown.length && (
            <li>
              <button type="button" className="report-photo-thumb report-photo-more" onClick={() => onOpen(photos, shown.length, caption)} aria-label={`Open ${counted(photos.length - shown.length, 'more photo', 'more photos')}`}>
                +{count(photos.length - shown.length)}
              </button>
            </li>
          )}
        </ul>
      )}
      {unavailable > 0 && <p role="status">{counted(unavailable, 'photo could', 'photos could')} not be loaded. Open {unavailable === 1 ? 'it' : 'one'} to retry.</p>}
      {onFile > 0 && <p>{counted(onFile, 'further photo', 'further photos')} held on file</p>}
    </div>
  );
}

function EntryCard({ entry, place, urls, onOpenPhoto, onPhotoError }: { entry: ActivityEntry; place?: string; urls: PhotoUrls; onOpenPhoto: OpenPhoto; onPhotoError: PhotoError }) {
  const caption = [entry.title || entry.tags[0], place, entry.when].filter(Boolean).join(' · ');
  return (
    <article className={`report-entry${entry.tone === 'incident' ? ' is-incident' : ''}`}>
      <div className="report-entry-head">
        <p className="report-entry-when">
          {entry.when}
          {place && <span><MapPin size={13} aria-hidden="true" /> {place}</span>}
        </p>
        {entry.tags.length > 0 && (
          <ul className="report-entry-tags">{entry.tags.map((tag, index) => <li key={`${tag}-${index}`}><Chip tone={tagTone(tag)}>{tag}</Chip></li>)}</ul>
        )}
      </div>
      {entry.title && <p className="report-entry-title">{entry.title}</p>}
      {entry.lines.map((line, index) => (
        <p key={index} className="report-entry-line">{line.label && <strong>{line.label}: </strong>}{line.text}</p>
      ))}
      <PhotoStrip entry={entry} caption={caption} urls={urls} onOpen={onOpenPhoto} onPhotoError={onPhotoError} />
    </article>
  );
}

interface ViewerState { photos: ReportPhotoRef[]; index: number; caption: string }

function PhotoViewer({ viewer, urls, onClose, onIndex, onPhotoError, onRetry }: { viewer: ViewerState; urls: PhotoUrls; onClose: () => void; onIndex: (index: number) => void; onPhotoError: PhotoError; onRetry: (ref: ReportPhotoRef) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  const total = viewer.photos.length;
  const ref = viewer.photos[viewer.index];
  const url = ref ? urls[photoKey(ref)] : null;
  const step = (delta: number) => onIndex((viewer.index + delta + total) % total);
  return createPortal(
    <dialog
      ref={dialogRef}
      className="report-photo-viewer"
      aria-modal="true"
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => {
        if (total < 2) return;
        if (event.key === 'ArrowRight') step(1);
        if (event.key === 'ArrowLeft') step(-1);
      }}
    >
      <header className="report-photo-viewer-head">
        <div>
          <h2 id={titleId}>Photo {viewer.index + 1} of {total}</h2>
          <p>{viewer.caption}</p>
        </div>
        <button type="button" className="report-photo-viewer-close" onClick={onClose} aria-label="Close photo"><X size={18} aria-hidden="true" /></button>
      </header>
      <div className="report-photo-viewer-stage">
        {url ? <img src={url} alt={`${viewer.caption}, photo ${viewer.index + 1} of ${total}`} onError={() => onPhotoError(ref, url)} /> : (
          <div className="report-photo-state" role="status">
            <p>{url === null ? 'This photo could not be loaded.' : 'Loading photo…'}</p>
            {url === null && ref && <button type="button" className="btn btn-secondary" onClick={() => onRetry(ref)}><RefreshCw size={16} aria-hidden="true" /> Retry photo</button>}
          </div>
        )}
      </div>
      {total > 1 && (
        <footer className="report-photo-viewer-nav">
          <button type="button" className="btn btn-secondary" onClick={() => step(-1)}><ChevronLeft size={16} aria-hidden="true" /> Previous</button>
          <button type="button" className="btn btn-secondary" onClick={() => step(1)}>Next <ChevronRight size={16} aria-hidden="true" /></button>
        </footer>
      )}
    </dialog>,
    document.body,
  );
}

function LinesNotice({ lines, status, entries, onRetry }: { lines: LinesState; status: string; entries: number; onRetry: () => void }) {
  if (lines.state === 'loading') return <p className="report-activity-empty" role="status">Loading the site log…</p>;
  if (lines.state === 'error') {
    return (
      <div className="alert alert-error report-activity-retry" role="alert">
        <span>{lines.message}</span>
        <button type="button" className="btn btn-secondary" onClick={onRetry}>Retry</button>
      </div>
    );
  }
  if (lines.state === 'missing') return <Empty>The site log is not stored for this pack. {status === 'sent' ? 'It has been sent and is kept as delivered.' : REGENERATE_HINT}</Empty>;
  if (lines.state === 'stale') return <p className="report-review-warning" role="status">{REFRESH_HINT}</p>;
  if (lines.state === 'ready' && lines.lines.length === 0) {
    return <Empty>{entries > 0 ? 'The itemised site log is not available for this report.' : 'Nothing was recorded at these locations during the period.'}</Empty>;
  }
  return null;
}

interface SiteLogProps {
  report: ActivityReport;
  lines: ActivityLine[];
  notItemised: number;
  label: Label;
  urls: PhotoUrls;
  requestPhotos: (refs: ReportPhotoRef[]) => void;
  onOpenPhoto: OpenPhoto;
  onPhotoError: PhotoError;
  idPrefix: string;
}

function entrySearchText(entry: ActivityEntry, place: string): string {
  return [entry.when, place, entry.title, ...entry.tags, ...entry.lines.map((line) => `${line.label ?? ''} ${line.text}`)].join(' ').toLowerCase();
}

function SiteLog({ report, lines, notItemised, label, urls, requestPhotos, onOpenPhoto, onPhotoError, idPrefix }: SiteLogProps) {
  const [place, setPlace] = useState('all');
  const [category, setCategory] = useState('all');
  const [photosOnly, setPhotosOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [visible, setVisible] = useState(ENTRY_PAGE);

  const groups = useMemo(() => {
    const order = new Map(lines.map((line, index) => [line, index]));
    return siteLogGroups(lines).map((group) => ({
      ...group,
      cards: group.entries.map((line) => {
        const entry = describeActivityLine(report, line);
        return { key: order.get(line) ?? 0, line, entry, search: entrySearchText(entry, group.place) };
      }),
    }));
  }, [lines, report]);
  const categories = report.categories.filter((row) => groups.some((group) => group.lines.some((line) => line.category === row.code)));

  const needle = query.trim().toLowerCase();
  const filtersActive = place !== 'all' || category !== 'all' || photosOnly || needle !== '';
  const filtered = groups
    .filter((group) => place === 'all' || group.place === place)
    .map((group) => ({
      ...group,
      cards: group.cards.filter((card) => (category === 'all' || card.line.category === category) && (!photosOnly || card.line.photos > 0) && (!needle || card.search.includes(needle))),
      showRoutine: group.routine.length > 0 && !photosOnly && !needle && (category === 'all' || category === 'patrol_visit'),
    }))
    .filter((group) => group.cards.length > 0 || group.showRoutine);
  const matching = filtered.reduce((sum, group) => sum + group.cards.length, 0);

  let remaining = visible;
  const page = filtered.flatMap((group) => {
    if (remaining <= 0) return [];
    const cards = group.cards.slice(0, remaining);
    remaining -= cards.length;
    return [{ ...group, cards }];
  });
  const shown = page.reduce((sum, group) => sum + group.cards.length, 0);
  const pageRefs = page.flatMap((group) => group.cards.flatMap((card) => card.entry.photos.slice(0, PHOTOS_PER_ENTRY)));
  const pageRefsKey = pageRefs.map(photoKey).join('|');
  // Keyed on the photo paths on screen, so signing runs when the page of entries changes, not on every render.
  useEffect(() => { requestPhotos(pageRefs); }, [pageRefsKey, requestPhotos]);

  const reset = () => { setPlace('all'); setCategory('all'); setPhotosOnly(false); setQuery(''); setVisible(ENTRY_PAGE); };
  const narrow = (apply: () => void) => { apply(); setVisible(ENTRY_PAGE); };

  return (
    <div className="report-log">
      <div className="report-log-filters" role="search" aria-label="Filter the site log">
        <label className="report-log-field">
          <span>Location</span>
          <select value={place} onChange={(event) => narrow(() => setPlace(event.target.value))}>
            <option value="all">All locations ({count(groups.length)})</option>
            {groups.map((group) => <option key={group.place} value={group.place}>{group.place} ({count(group.lines.length)})</option>)}
          </select>
        </label>
        <label className="report-log-field">
          <span>Type of activity</span>
          <select value={category} onChange={(event) => narrow(() => setCategory(event.target.value))}>
            <option value="all">All types</option>
            {categories.map((row) => <option key={row.code} value={row.code}>{label('category', row.code)}</option>)}
          </select>
        </label>
        <label className="report-log-field report-log-search">
          <span>Search comments</span>
          <input type="search" value={query} onChange={(event) => narrow(() => setQuery(event.target.value))} placeholder="Gate, fence, goat…" />
        </label>
        <label className="report-log-check">
          <input type="checkbox" checked={photosOnly} onChange={(event) => narrow(() => setPhotosOnly(event.target.checked))} />
          <span>With photos only</span>
        </label>
      </div>
      <div className="report-log-status">
        <span role="status">{filtersActive ? `${counted(matching, 'entry matches', 'entries match')} these filters` : `${counted(matching, 'entry', 'entries')} with comments, work or photos`}</span>
        {filtersActive && <button type="button" className="btn btn-secondary" onClick={reset}>Clear filters</button>}
      </div>

      {page.length === 0 ? (
        <Empty>No entries match these filters.</Empty>
      ) : page.map((group, index) => (
        <section key={group.place} className="report-log-place" aria-labelledby={`${idPrefix}-place-${index}`}>
          <header>
            <h5 id={`${idPrefix}-place-${index}`}><MapPin size={15} aria-hidden="true" /> {group.place}</h5>
            <span>{counted(group.lines.length, 'entry', 'entries')}</span>
          </header>
          {group.cards.map((card) => <EntryCard key={card.key} entry={card.entry} urls={urls} onOpenPhoto={onOpenPhoto} onPhotoError={onPhotoError} />)}
          {group.showRoutine && <p className="report-log-routine">{routineSummary(group.routine)}</p>}
        </section>
      ))}
      {matching > shown && (
        <button type="button" className="btn btn-secondary report-activity-more" onClick={() => setVisible((current) => current + ENTRY_PAGE)}>
          Show {count(Math.min(ENTRY_PAGE, matching - shown))} more
        </button>
      )}
      <p className="report-review-source-note">
        New Zealand dates and times. The client PDF lists the same entries with up to {PHOTOS_PER_ENTRY} photos each (60 per report); further photos are noted as held on file.
        {notItemised > 0 && ` A further ${counted(notItemised, 'entry is', 'entries are')} included in the totals and noted as held on file.`}
      </p>
    </div>
  );
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

      <h6>Source records</h6>
      <ul className="report-activity-facts">
        <li>Patrol-log entries: {count(provenance.events.inScope)} in scope, {count(provenance.events.withLedger)} traced to an import file, {count(provenance.events.withoutLedger)} with no import record.</li>
        <li>Observations: {count(provenance.observations.inScope)} in scope, {count(provenance.observations.withLedger)} traced to an import file, {count(provenance.observations.withoutLedger)} with no import record.</li>
      </ul>
      <p className="report-review-source-note">Entries with no import record were captured in the app or imported before the import ledger existed.</p>
      {provenance.sources.length > 0 && (
        <ActivityTable
          label="Source files"
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
  const [logOpen, setLogOpen] = useState(false);
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const { urls, request: requestPhotos, retry: retryPhoto, failed: photoFailed } = usePhotoUrls();
  const label: Label = useCallback((dim: string, code: string) => activityLabel(report, dim, code), [report]);
  const { totals, accountedFor, pest, observations, incidents } = report;

  // A ref, not state: two toggle events in one render would both see the old state and fetch twice.
  const linesRequest = useRef<'idle' | 'loading' | 'done'>('idle');

  const loadLines = useCallback(async () => {
    if (linesRequest.current !== 'idle') return;
    linesRequest.current = 'loading';
    setLines({ state: 'loading' });
    const { data: row, error } = await supabase.from('monthly_report_packs').select('activity_lines,updated_at').eq('id', packId).maybeSingle();
    if (error || !row) {
      linesRequest.current = 'idle';
      setLines({ state: 'error', message: error ? 'The site log could not be loaded. Try again.' : 'This report pack is no longer available. Refresh the report list.' });
      return;
    }
    linesRequest.current = 'done';
    if (row.updated_at !== updatedAt) {
      setLines({ state: 'stale' });
      return;
    }
    const parsed = readActivityLines(row.activity_lines);
    setLines(parsed ? { state: 'ready', ...parsed } : { state: 'missing' });
  }, [packId, updatedAt]);

  // Incidents lead the report, so their detail loads straight away; the site log waits until it is opened.
  useEffect(() => {
    if (incidents.total > 0) void loadLines();
  }, [incidents.total, loadLines]);

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

  const openPhoto: OpenPhoto = (photos, index, caption) => {
    requestPhotos(photos);
    setViewer({ photos, index, caption });
  };

  const incidentEntries = useMemo(() => (lines.state === 'ready' ? lines.lines : [])
    .filter((line) => line.kind === 'incident')
    .map((line) => ({ line, entry: describeActivityLine(report, line) })), [lines, report]);
  useEffect(() => {
    requestPhotos(incidentEntries.flatMap(({ entry }) => entry.photos.slice(0, PHOTOS_PER_ENTRY)));
  }, [incidentEntries, requestPhotos]);

  const incidentSummary = [
    `${counted(incidents.total, 'incident was', 'incidents were')} recorded at these locations`,
    incidents.investigations > 0 ? `${counted(incidents.investigations, 'investigation is', 'investigations are')} linked` : '',
    incidents.withMedia > 0 ? `${count(incidents.withMedia)} with photo or video evidence` : '',
  ].filter(Boolean).join('; ');
  const unlistedIncidents = lines.state === 'ready' ? incidents.total - incidentEntries.length : 0;

  const metrics: Array<[string, number, boolean?]> = [
    ['Locations with activity', totals.places],
    ['Entries recorded', totals.entries],
    ['Incidents', totals.incidents, totals.incidents > 0],
    ['Observations', totals.observations],
    ['Patrols', totals.patrolVisits],
    ['CCTV activity', totals.cameraActivations],
    ['Photos', totals.photos],
    ['Pest culls recorded', pest.bySpecies.reduce((sum, row) => sum + row.culls, 0)],
  ];
  const hunters = report.hunterReturns;
  if (hunters) metrics.push(['Hunter-reported kills', hunters.animals]);
  const summaryCharts = reportSummaryCharts(report, label);
  const logEntries = Math.max(totals.entries - totals.incidents, 0);
  const accountedBadge = accountedFor.reconciled
    ? (accountedFor.entries === 1 ? '1 record accounted for' : `All ${count(accountedFor.entries)} records accounted for`)
    : 'Totals need review';

  return (
    <section className="report-activity" aria-labelledby={headingId}>
      <header className="report-activity-heading">
        <div>
          <span className="report-activity-kicker"><FileText size={15} aria-hidden="true" /> Client report preview</span>
          <h4 id={headingId}>Site activity report</h4>
          <p>A location-by-location account of recorded activity, observations and investigations, with comments and supporting photos.</p>
        </div>
      </header>
      {!accountedFor.reconciled && (
        <p className="report-review-warning" role="note"><AlertTriangle size={17} aria-hidden="true" /> The record, category and location totals in this pack do not agree. Regenerate the draft and open the completeness check before publishing.</p>
      )}

      <div className="report-activity-metrics" role="group" aria-label="Report at a glance">
        {metrics.map(([name, value, alert]) => <div key={name} className={alert ? 'is-alert' : undefined}><span>{name}</span><strong>{count(value)}</strong></div>)}
      </div>
      {report.basis && <p className="report-review-source-note">{report.basis}</p>}
      {summaryCharts.length > 0 && (
        <div className="report-activity-charts" role="group" aria-label="Activity statistics charts">
          {summaryCharts.map((chart) => {
            const maxValue = Math.max(1, ...chart.items.map((item) => item.value));
            return (
              <figure className="report-activity-chart" key={chart.title}>
                <figcaption>{chart.title}</figcaption>
                <ol>
                  {chart.items.map((item) => (
                    <li key={item.label}>
                      <span className="report-activity-chart-label">{item.label}</span>
                      <span className="report-activity-chart-track" aria-hidden="true">
                        <span style={{ width: `${Math.min(100, (item.value / maxValue) * 100)}%` }} />
                      </span>
                      <strong>{count(item.value)}</strong>
                    </li>
                  ))}
                </ol>
              </figure>
            );
          })}
          <p className="report-activity-chart-note">Charts highlight the highest recorded counts; complete figures remain in the tables below.</p>
        </div>
      )}

      <section className="report-activity-section" aria-labelledby={`${headingId}-overview`}>
        <h5 id={`${headingId}-overview`}>Activity overview</h5>
        {report.categories.length > 0 ? (
          <ActivityTable
            label="Entries by type of activity"
            columns={[{ label: 'Type of activity' }, { label: 'Entries', numeric: true }, { label: 'Photos', numeric: true }]}
            rows={report.categories.map((row) => [label('category', row.code), count(row.entries), count(row.photos)])}
          />
        ) : <Empty>Nothing was recorded at the locations covered by this agreement during the period.</Empty>}
      </section>

      <section className="report-activity-section report-incidents" aria-labelledby={`${headingId}-incidents`}>
        <div className="report-section-head">
          <h5 id={`${headingId}-incidents`}>Incidents and investigations</h5>
          {incidents.total > 0 && <Chip tone="danger">{counted(incidents.total, 'incident', 'incidents')}</Chip>}
        </div>
        {incidents.total === 0 ? (
          <Empty>No incidents were recorded at these locations during the period.</Empty>
        ) : (
          <>
            <p className="report-incident-summary">{incidentSummary}.</p>
            {(incidents.bySeverity.length > 0 || incidents.byStatus.length > 0) && (
              <ul className="report-incident-breakdown" aria-label="Incidents by severity and status">
                {incidents.bySeverity.map((row) => <li key={`severity-${row.code}`}><Chip tone={tagTone(`${label('severity', row.code)} severity`)}>{label('severity', row.code)} severity · {count(row.entries)}</Chip></li>)}
                {incidents.byStatus.map((row) => <li key={`status-${row.code}`}><Chip tone={tagTone(label('incidentStatus', row.code))}>{label('incidentStatus', row.code)} · {count(row.entries)}</Chip></li>)}
              </ul>
            )}
            <div aria-live="polite">
              <LinesNotice lines={lines} status={status} entries={totals.entries} onRetry={() => void loadLines()} />
              {incidentEntries.map(({ line, entry }, index) => <EntryCard key={index} entry={entry} place={line.place} urls={urls} onOpenPhoto={openPhoto} onPhotoError={photoFailed} />)}
              {unlistedIncidents > 0 && <p className="report-review-source-note">{counted(unlistedIncidents, 'further incident is', 'further incidents are')} held on file.</p>}
            </div>
          </>
        )}
      </section>

      <Group title="Activity by location" meta={counted(report.byPlace.length, 'location', 'locations')}>
        {report.byPlace.length > 0 ? (
          <ActivityTable
            label="Activity by location"
            columns={[{ label: 'Location' }, { label: 'Entries', numeric: true }, { label: 'Photos', numeric: true }, { label: 'Main activity' }]}
            rows={report.byPlace.map((row) => [row.place, count(row.entries), count(row.photos), placeMix(row.categories, label)])}
          />
        ) : <Empty>No location recorded activity during the period.</Empty>}
      </Group>

      <Group title="Pest control" meta={counted(pest.entries, 'entry', 'entries')}>
        {pest.entries > 0 ? (
          <>
            <p className="report-review-source-note">{counted(pest.entries, 'pest-control entry', 'pest-control entries')}. Species figures count recorded entries, not population estimates.</p>
            {pest.bySpecies.length > 0 && (
              <ActivityTable
                label="Pest control by species"
                columns={[{ label: 'Species' }, { label: 'Culls', numeric: true }, { label: 'Sightings', numeric: true }, { label: 'Other', numeric: true }, { label: 'Total', numeric: true }]}
                rows={pest.bySpecies.map((row) => [label('species', row.code), count(row.culls), count(row.sightings), count(row.other), count(row.total)])}
              />
            )}
            {pest.byActivity.length > 0 && (
              <ActivityTable label="Pest-control work" columns={[{ label: 'Pest-control work' }, { label: 'Entries', numeric: true }]} rows={pest.byActivity.map((row) => [label('activity', row.code), count(row.entries)])} />
            )}
            {pest.byEquipment.length > 0 && (
              <ActivityTable label="Traps, bait stations and equipment" columns={[{ label: 'Traps, bait stations and equipment' }, { label: 'Entries', numeric: true }]} rows={pest.byEquipment.map((row) => [label('equipment', row.code), count(row.entries)])} />
            )}
            {pest.ammunition.length > 0 && (
              <ActivityTable
                label="Ammunition"
                columns={[{ label: 'Ammunition calibre' }, { label: 'Entries', numeric: true }, { label: 'Rounds recorded', numeric: true }]}
                rows={pest.ammunition.map((row) => [row.calibre && row.calibre !== 'unspecified' ? row.calibre : 'Calibre not recorded', count(row.entries), row.rounds === null ? 'Not recorded' : count(row.rounds)])}
              />
            )}
          </>
        ) : <Empty>No pest-control work was recorded at these locations during the period.</Empty>}
      </Group>

      {hunters && (
        <Group title="Hunter kill returns" meta={counted(hunters.returns, 'return', 'returns')}>
          {hunters.returns > 0 ? (
            <>
              <p className="report-review-source-note">
                {counted(hunters.returns, 'hunter return was', 'hunter returns were')} submitted through RAMS for hunts in the period: {count(hunters.killReturns)} with kills and {count(hunters.nilReturns)} nil, reporting {counted(hunters.animals, 'animal', 'animals')}. Figures are as reported by permit holders; hunter identities stay with R &amp; M.
              </p>
              {hunters.bySpecies.length > 0 && (
                <ActivityTable
                  label="Hunter-reported animals by species"
                  columns={[{ label: 'Species' }, { label: 'Animals reported', numeric: true }, { label: 'Returns', numeric: true }]}
                  rows={hunters.bySpecies.map((row) => [row.species, count(row.animals), count(row.returns)])}
                />
              )}
              {hunters.byArea.length > 0 && (
                <ActivityTable
                  label="Hunter returns by hunting area"
                  columns={[{ label: 'Hunting area' }, { label: 'Returns', numeric: true }, { label: 'With kills', numeric: true }, { label: 'Nil', numeric: true }, { label: 'Animals', numeric: true }]}
                  rows={hunters.byArea.map((row) => [row.area, count(row.returns), count(row.kill), count(row.nil), count(row.animals)])}
                />
              )}
            </>
          ) : <Empty>No hunter kill or nil returns were submitted for hunts in the period.</Empty>}
        </Group>
      )}

      {([['maintenance', 'Maintenance and repairs', 'No maintenance or repair work was recorded during the period.'], ['manufacture', 'Manufacture and fabrication', 'No manufacture or fabrication work was recorded during the period.']] as const).map(([key, title, empty]) => {
        const work = report[key];
        return (
          <Group key={key} title={title} meta={counted(work.entries, 'entry', 'entries')}>
            {work.entries > 0 ? (
              <>
                {work.completed + work.open > 0 && (
                  <p className="report-review-source-note">Workshop jobs: {count(work.completed)} completed, {count(work.open)} scheduled or in progress.</p>
                )}
                {work.bySubject.length > 0 && (
                  <ActivityTable label={`${title} by item`} columns={[{ label: 'Item worked on' }, { label: 'Entries', numeric: true }]} rows={work.bySubject.map((row) => [label('subject', row.code) || 'Not specified', count(row.entries)])} />
                )}
              </>
            ) : <Empty>{empty}</Empty>}
          </Group>
        );
      })}

      <Group title="Observations" meta={`${counted(observations.total, 'observation', 'observations')} · ${counted(observations.photos, 'photo', 'photos')}`}>
        {observations.byModule.length > 0 ? (
          <>
            <p className="report-review-source-note">{counted(observations.total, 'observation', 'observations')}; {count(observations.withPhoto)} with photos.</p>
            <ActivityTable
              label="Observations by type"
              columns={[{ label: 'Observation type' }, { label: 'Observations', numeric: true }, { label: 'With photo', numeric: true }, { label: 'Photos', numeric: true }]}
              rows={observations.byModule.map((row) => [label('module', row.module), count(row.entries), count(row.withPhoto), count(row.photos)])}
            />
          </>
        ) : <Empty>No observations were recorded at these locations during the period.</Empty>}
      </Group>

      <Group
        className="report-activity-log"
        title="Site log"
        meta={`${counted(logEntries, 'entry', 'entries')} by location, with comments and photos`}
        onToggle={(open) => { setLogOpen(open); if (open) void loadLines(); }}
      >
        <div aria-live="polite">
          <LinesNotice lines={lines} status={status} entries={totals.entries} onRetry={() => void loadLines()} />
        </div>
        {logOpen && lines.state === 'ready' && lines.lines.length > 0 && (
          <SiteLog report={report} lines={lines.lines} notItemised={lines.notItemised} label={label} urls={urls} requestPhotos={requestPhotos} onOpenPhoto={openPhoto} onPhotoError={photoFailed} idPrefix={headingId} />
        )}
      </Group>

      <Group className="report-activity-check" title="Completeness check" meta={`Provider only · ${accountedBadge}`}>
        <p className="report-review-source-note">Not part of the client report. Confirms every record in scope is either reported or deliberately kept out, and compares this pack with live records.</p>
        <ul className="report-activity-facts">
          <li>{counted(accountedFor.reported, 'entry is', 'entries are')} in the client report{accountedFor.reconciled ? '; every record in scope is accounted for.' : '.'}</li>
          {accountedFor.withheldTravelAdmin > 0 && <li>{counted(accountedFor.withheldTravelAdmin, 'travel or materials record is', 'travel and materials records are')} kept out of the client report.</li>}
          {accountedFor.withheldShiftMarkers > 0 && <li>{counted(accountedFor.withheldShiftMarkers, 'shift start or finish marker is', 'shift start and finish markers are')} kept out of the client report.</li>}
          {accountedFor.mirrorEventsExcluded > 0 && <li>{counted(accountedFor.mirrorEventsExcluded, 'automatic patrol-log copy of an observation was', 'automatic patrol-log copies of observations were')} excluded so nothing is counted twice.</li>}
          {accountedFor.unclassified > 0 && <li>{counted(accountedFor.unclassified, 'entry has', 'entries have')} no work type recorded and {accountedFor.unclassified === 1 ? 'appears' : 'appear'} as &ldquo;{label('category', 'unclassified')}&rdquo;.</li>}
          {accountedFor.notItemised > 0 && <li>{counted(accountedFor.notItemised, 'entry is', 'entries are')} counted in the totals but not listed in the site log because of the line limit.</li>}
        </ul>
        <div className="report-activity-check-heading">
          <p>Compare this pack with live records and trace entries to their source files.</p>
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
      </Group>

      {viewer && <PhotoViewer viewer={viewer} urls={urls} onPhotoError={photoFailed} onRetry={retryPhoto} onClose={() => setViewer(null)} onIndex={(index) => setViewer((current) => (current ? { ...current, index } : current))} />}
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
        <h4 id={headingId}>Site activity report</h4>
        <p className="report-activity-notice" role="note">
          This pack was generated before the client site activity report.{' '}
          {status === 'sent' ? 'It has been sent and is kept exactly as delivered.' : 'Use Generate report drafts for this period to add the activity summary, incidents and site log. The pack returns to draft for review.'}
        </p>
      </section>
    );
  }
  return <ActivityReportBody key={`${packId}:${updatedAt}`} packId={packId} updatedAt={updatedAt} report={report} status={status} headingId={headingId} />;
}
