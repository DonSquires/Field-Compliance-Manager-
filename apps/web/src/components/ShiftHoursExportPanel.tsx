import { useEffect, useMemo, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { downloadCsv } from '../lib/nztaRegister';
import { formatHours } from '../lib/shiftHoursTotals';
import { buildShiftHoursExport, parseShiftHoursRows, shiftHoursVersion,
  type ShiftHoursExport, type ShiftHoursExportMode, type ShiftHoursReviewRow } from '../lib/shiftHoursExport';
import { workforceWeek } from '../lib/workforceScope';
import './ShiftHoursExportPanel.css';

export const shiftHoursError = (error: unknown) =>
  error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
    ? error.message : 'Hours could not be verified. No CSV was downloaded; retry the check.';

export function ShiftHoursExportPanel({ organizationId, from, to, staffId = null, rows, clientOnly = false, disabled = false }: {
  organizationId: string | null; from: string; to: string; staffId?: string | null;
  rows?: ShiftHoursReviewRow[]; clientOnly?: boolean; disabled?: boolean;
}) {
  const [selectedMode, setMode] = useState<ShiftHoursExportMode>('payroll');
  const mode = clientOnly ? 'client' : selectedMode;
  const [clientId, setClientId] = useState('');
  const [loaded, setLoaded] = useState<{ key: string; rows: ShiftHoursReviewRow[] } | null>(null);
  const [preview, setPreview] = useState<{ key: string; version: string; result: ShiftHoursExport } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const generation = useRef(0);
  const dateDays = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
  const rangeProblem = !Number.isFinite(dateDays) || dateDays < 1 || dateDays > 63
    ? 'Choose a valid date range of 63 days or fewer.' : null;
  const sourceKey = JSON.stringify([organizationId, from, to, staffId]);
  const sourceRows = rows ?? (loaded?.key === sourceKey ? loaded.rows : []);
  const scopeKey = JSON.stringify([sourceKey, mode, clientId, rows === undefined ? null : shiftHoursVersion(rows)]);
  const currentKey = useRef(scopeKey);
  currentKey.current = scopeKey;
  const clients = useMemo(() => [...new Map(sourceRows.filter((row) => row.client_organization_id)
    .map((row) => [row.client_organization_id!, row.client_name ?? 'Client name unavailable'])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1])), [sourceRows]);

  const readRows = async () => {
    if (!organizationId || rangeProblem) throw new Error(rangeProblem ?? 'Choose an operating organisation.');
    const response = await supabase.rpc('get_timesheet_shift_rows', {
      p_organization_id: organizationId, p_from: from, p_to: to, p_staff_id: staffId,
    });
    if (response.error) throw response.error;
    const fresh = parseShiftHoursRows(response.data);
    if (!rows) return fresh;
    const ids = new Set(rows.map((row) => row.id));
    const selected = fresh.filter((row) => ids.has(row.id));
    if (selected.length !== ids.size) throw new Error('Some displayed shifts are no longer available. Refresh the shift review before exporting.');
    return selected;
  };

  useEffect(() => {
    const token = ++generation.current;
    setPreview(null); setError(null); setNotice(null); setBusy(false);
    if (rows !== undefined || !organizationId || rangeProblem) return;
    setBusy(true);
    void readRows().then((fresh) => {
      if (token === generation.current) setLoaded({ key: sourceKey, rows: fresh });
    }).catch((failure: unknown) => {
      if (token === generation.current) setError(shiftHoursError(failure));
    }).finally(() => { if (token === generation.current) setBusy(false); });
    return () => { generation.current++; };
  }, [scopeKey, rows === undefined, loadAttempt]);

  const prepare = async (download: boolean) => {
    if (busy || disabled || rangeProblem || !organizationId) return;
    const key = scopeKey;
    const previous = preview?.key === key ? preview : null;
    const token = ++generation.current;
    setBusy(true); setError(null); setNotice(null);
    try {
      const fresh = await readRows();
      if (token !== generation.current || currentKey.current !== key) return;
      const result = buildShiftHoursExport(fresh, mode, clientId || null);
      const version = shiftHoursVersion(fresh);
      setPreview({ key, version, result });
      if (download && previous) {
        if (previous.version !== version || previous.result.csv !== result.csv) {
          setError('Hours changed since your preview. Review the refreshed preview, then download again.');
        } else if (result.lines.length) {
          downloadCsv(`${mode}-hours-${from}-${to}.csv`, result.csv);
          setNotice('CSV download requested. No payroll payment or invoice was created.');
        }
      }
    } catch (failure) { if (token === generation.current) { setError(shiftHoursError(failure)); setPreview(null); } }
    finally { if (token === generation.current) setBusy(false); }
  };
  const shown = preview?.key === scopeKey ? preview.result : null;
  const blocked = busy || disabled || !!rangeProblem || !organizationId || (mode === 'client' && !clients.some(([id]) => id === clientId));

  return <section className="shift-hours-export" aria-label="Hours export">
    <h2>{clientOnly ? 'Client hours for invoicing' : 'Preview and hand off hours'}</h2>
    <p>{from} to {to} · Pacific/Auckland · {rows ? 'Currently displayed shifts only.' : 'Operating organisation shift hours.'}</p>
    <p>Approved source hours only. Downloading does not mark payroll paid, create an invoice or send anything.</p>
    <div className="shift-hours-export__controls">
      {!clientOnly && <label>Handoff<select value={mode} onChange={(event) => setMode(event.target.value === 'client' ? 'client' : 'payroll')} disabled={busy}>
        <option value="payroll">Accountant / payroll hours</option><option value="client">Client invoicing hours</option>
      </select></label>}
      {mode === 'client' && <label>Client for hours export<select value={clients.some(([id]) => id === clientId) ? clientId : ''} onChange={(event) => setClientId(event.target.value)} disabled={busy}>
        <option value="">Choose an agreement client</option>{clients.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select></label>}
      <button type="button" className="btn btn-secondary" disabled={blocked} onClick={() => void prepare(false)}>
        {busy ? 'Checking hours...' : `Preview ${mode === 'payroll' ? 'payroll' : 'client'} hours`}
      </button>
    </div>
    {rangeProblem && <p role="alert">{rangeProblem}</p>}
    {!organizationId && <p role="alert">Choose an operating organisation to check hours.</p>}
    {error && <p role="alert">{error}</p>}
    {error && rows === undefined && <button type="button" className="btn btn-secondary"
      disabled={busy || disabled || !!rangeProblem || !organizationId} onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
      Retry loading hours
    </button>}
    {notice && <p role="status">{notice}</p>}
    {rows === undefined && !busy && !error && !sourceRows.length && <p>No shifts in this period. Change the dates to check another period.</p>}
    {mode === 'client'
      ? <p>Supporting hours only, not a tax invoice. No wage rates, employee numbers or internal review notes are included. Agreement billing basis, prices and tax must be confirmed separately in Finance.</p>
      : <p>Accountant-ready hours breakdown, not a native Xero Payroll import. Employee numbers are included where recorded; the payroll person must confirm employee mapping and earnings rules.</p>}
    {shown && <>
      {shown.lines.length > 0 ? <>
        <div className="shift-hours-export__table"><table aria-label="Hours export preview">
          <caption>{shown.lines.length} approved shifts included. Dates and UTC offsets are shown for overnight and daylight-saving shifts.</caption>
          <thead><tr><th scope="col">Staff</th><th scope="col">Location / client</th><th scope="col">Payable start</th><th scope="col">Payable finish</th><th scope="col">Unpaid break</th><th scope="col">Payable hours</th></tr></thead>
          <tbody>{shown.lines.map((line) => <tr key={line.reference}><td>{line.staff_name}</td><td>{line.location}<br />{line.client}</td><td>{line.start}</td><td>{line.finish}</td><td>{line.unpaid_minutes} minutes</td><td>{line.hours}</td></tr>)}</tbody>
        </table></div>
        <ul aria-label="Hours subtotals">{shown.groups.map((group, index) => <li key={index}>{group.name}: {formatHours(group.hours)}</li>)}</ul>
        <strong>Grand total: {formatHours(shown.totalHours)}</strong>
        <button type="button" className="btn btn-primary" disabled={blocked} onClick={() => void prepare(true)}><Download size={16} aria-hidden="true" />{busy ? 'Rechecking...' : 'Download reviewed CSV'}</button>
      </> : <p role="status">No approved, complete and unfinalised hours are eligible for this handoff. Review the exclusions below.</p>}
      {shown.excluded.length > 0 && <details open><summary>{shown.excluded.length} shifts excluded from this file</summary><ul>
        {shown.excluded.map((item) => <li key={item.id}>{item.name}: {item.reason} <small>Shift {item.id}</small></li>)}
      </ul></details>}
    </>}
  </section>;
}

export function ClientShiftHoursExport({ organizationId }: { organizationId: string | null }) {
  const [range, setRange] = useState(workforceWeek);
  return <section aria-label="Client hours date range">
    <div className="shift-hours-export__controls">
      <label>Client hours from<input type="date" value={range.from} max={range.to} onChange={(event) => setRange({ ...range, from: event.target.value })} /></label>
      <label>Client hours to<input type="date" value={range.to} min={range.from} onChange={(event) => setRange({ ...range, to: event.target.value })} /></label>
    </div>
    <ShiftHoursExportPanel organizationId={organizationId} from={range.from} to={range.to} clientOnly />
  </section>;
}
