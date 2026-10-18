/**
 * PatrolTravelSummary — recorded patrol travel distance for a scope.
 *
 * Shared by three surfaces so the number means the same thing everywhere:
 *   - Patrol evidence (field operations oversight)
 *   - Cost of service (standalone report)
 *   - Workshop (travel recorded by the assigned technician at the job's site)
 *
 * This is observed history, not a priced cost line. The footnote says so on
 * every surface, because `patrol_travel_km_summary` is explicitly outside the
 * finance/invoicing write pipeline and must not be read as billable.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Car, RefreshCw } from 'lucide-react';
import {
  fetchPatrolTravelSummary,
  formatKm,
  formatMonth,
  summariseTravel,
  totalsByOfficer,
  type PatrolTravelRow,
} from '../lib/patrolTravel';
import './PatrolTravelSummary.css';

export interface PatrolTravelSummaryProps {
  organizationId: string | null;
  monthsBack: number;
  officerId?: string | null;
  siteId?: string | null;
  zoneId?: string | null;
  /** Display names keyed by officer id, supplied by the host page where known. */
  officerNames?: Record<string, string>;
  /** Display names keyed by site id, supplied by the host page where known. */
  placeNames?: Record<string, string>;
  title?: string;
  description?: string;
  /** `monthly` shows a month-by-month table; `officer` ranks officers. */
  breakdown?: 'monthly' | 'officer';
  /** Hides the per-row table and shows headline figures only. */
  compact?: boolean;
  /** Message shown when the scope legitimately has no recorded travel. */
  emptyHint?: string;
}

const PatrolTravelSummary: React.FC<PatrolTravelSummaryProps> = ({
  organizationId,
  monthsBack,
  officerId = null,
  siteId = null,
  zoneId = null,
  officerNames = {},
  placeNames = {},
  title = 'Recorded travel',
  description,
  breakdown = 'monthly',
  compact = false,
  emptyHint,
}) => {
  const [rows, setRows] = useState<PatrolTravelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!organizationId) {
      setRows([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await fetchPatrolTravelSummary({ organizationId, monthsBack, officerId, siteId, zoneId });
      setRows(data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Recorded travel could not be loaded.');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [monthsBack, officerId, organizationId, siteId, zoneId]);

  useEffect(() => { void load(); }, [load]);

  const totals = useMemo(() => summariseTravel(rows), [rows]);
  const officerRows = useMemo(() => totalsByOfficer(rows), [rows]);
  const monthlyRows = useMemo(() => {
    const byMonth = new Map<string, { month: string; distanceKm: number; visitCount: number }>();
    for (const row of rows) {
      const existing = byMonth.get(row.month) ?? { month: row.month, distanceKm: 0, visitCount: 0 };
      existing.distanceKm += row.total_distance_km ?? 0;
      existing.visitCount += row.visit_count;
      byMonth.set(row.month, existing);
    }
    return [...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month));
  }, [rows]);

  const officerLabel = (id: string | null) => (id ? officerNames[id] ?? `Officer ${id.slice(0, 8)}` : 'Not attributed to an officer');
  const placeLabel = (id: string | null) => (id ? placeNames[id] ?? `Place ${id.slice(0, 8)}` : 'No place recorded');

  if (!organizationId) {
    return (
      <section className="travel-summary" aria-label={title}>
        <header className="travel-summary__head"><h3><Car size={17} aria-hidden="true" />{title}</h3></header>
        <p className="travel-summary__state" role="status">
          Organisation access could not be confirmed, so recorded travel is unavailable.
        </p>
      </section>
    );
  }

  return (
    <section className="travel-summary" aria-label={title}>
      <header className="travel-summary__head">
        <div>
          <h3><Car size={17} aria-hidden="true" />{title}</h3>
          {description && <p className="travel-summary__description">{description}</p>}
        </div>
        <button type="button" className="travel-summary__refresh" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={15} className={loading ? 'is-spinning' : ''} aria-hidden="true" />
          Refresh
        </button>
      </header>

      {error && (
        <p className="travel-summary__state travel-summary__state--error" role="alert">
          <AlertTriangle size={15} aria-hidden="true" />
          {error}
        </p>
      )}

      {loading ? (
        <p className="travel-summary__state" role="status">
          <RefreshCw size={15} className="is-spinning" aria-hidden="true" />
          Loading recorded travel…
        </p>
      ) : rows.length === 0 && !error ? (
        <p className="travel-summary__state" role="status">
          {emptyHint ?? `No travel distance has been recorded for this scope in the last ${monthsBack} months. Distance appears here once an officer records it on a visit, or a patrol log is imported.`}
        </p>
      ) : (
        <>
          <dl className="travel-summary__figures">
            <div><dt>Distance recorded</dt><dd>{formatKm(totals.distanceKm)}</dd></div>
            <div><dt>Visits with distance</dt><dd>{totals.visitCount.toLocaleString('en-NZ')}</dd></div>
            <div><dt>Officers</dt><dd>{totals.officerCount.toLocaleString('en-NZ')}</dd></div>
            <div><dt>Places</dt><dd>{totals.placeCount.toLocaleString('en-NZ')}</dd></div>
          </dl>

          {!compact && breakdown === 'monthly' && (
            <table className="travel-summary__table">
              <thead><tr><th scope="col">Month</th><th scope="col">Visits</th><th scope="col">Distance</th></tr></thead>
              <tbody>
                {monthlyRows.map((row) => (
                  <tr key={row.month}>
                    <th scope="row">{formatMonth(row.month)}</th>
                    <td>{row.visitCount.toLocaleString('en-NZ')}</td>
                    <td>{formatKm(row.distanceKm)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {!compact && breakdown === 'officer' && (
            <table className="travel-summary__table">
              <thead><tr><th scope="col">Officer</th><th scope="col">Visits</th><th scope="col">Distance</th></tr></thead>
              <tbody>
                {officerRows.map((row) => (
                  <tr key={row.officerId ?? 'unattributed'}>
                    <th scope="row">{officerLabel(row.officerId)}</th>
                    <td>{row.visitCount.toLocaleString('en-NZ')}</td>
                    <td>{formatKm(row.distanceKm)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {!compact && siteId && (
            <p className="travel-summary__note">Scoped to {placeLabel(siteId)}.</p>
          )}
        </>
      )}

      <p className="travel-summary__note">
        Officer-recorded distance observed on visits, not a GPS estimate and not a priced cost line.
        Use it for cost-of-service and vehicle-usage context; invoicing stays on the finance pipeline.
      </p>
    </section>
  );
};

export default PatrolTravelSummary;
