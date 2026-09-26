import './CustomReportSnapshot.css';

interface CustomReportSnapshotProps {
  data: Record<string, unknown> | null;
  reportScope: Record<string, unknown>;
  idPrefix: string;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function snapshotRows(data: Record<string, unknown> | null, key: string): Array<Record<string, unknown>> {
  const rows = data?.[key];
  return Array.isArray(rows)
    ? rows.map(objectValue).filter((row): row is Record<string, unknown> => row !== null)
    : [];
}

function summaryNumber(data: Record<string, unknown> | null, key: string): string {
  const value = objectValue(data?.summary)?.[key];
  return typeof value === 'number' ? String(value) : '0';
}

function hasSummaryNumber(data: Record<string, unknown> | null, key: string): boolean {
  return typeof objectValue(data?.summary)?.[key] === 'number';
}

function scopeIds(reportScope: Record<string, unknown>, key: string): unknown[] {
  const value = reportScope[key];
  return Array.isArray(value) ? value : [];
}

function scopeLabels(reportScope: Record<string, unknown>, key: string, labelKey: 'name' | 'plate'): string[] {
  const values = objectValue(reportScope.labels)?.[key];
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    const label = objectValue(value)?.[labelKey];
    return typeof label === 'string' && label ? [label] : [];
  });
}

function scopeLabelForId(reportScope: Record<string, unknown>, key: string, id: unknown, labelKey: 'name' | 'plate'): string {
  if (typeof id !== 'string') return 'Not specified';
  const values = objectValue(reportScope.labels)?.[key];
  if (!Array.isArray(values)) return 'Not specified';
  const label = objectValue(values.find((value) => objectValue(value)?.id === id))?.[labelKey];
  return typeof label === 'string' && label ? label : 'Not specified';
}

function snapshotDate(value: unknown): string {
  return typeof value === 'string' ? new Date(value).toLocaleString('en-NZ') : 'Not recorded';
}

function snapshotText(value: unknown, fallback = 'Not recorded'): string {
  if (typeof value === 'string' && value) return value.replaceAll('_', ' ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return fallback;
}

function snapshotRowKey(row: Record<string, unknown>, index: number): string {
  return typeof row.id === 'string' ? row.id : `snapshot-row-${index}`;
}

function observationOutcome(row: Record<string, unknown>): string {
  let outcome = 'Not assessed';
  if (row.is_compliant === true) outcome = 'Compliant';
  if (row.is_compliant === false) outcome = 'Non-compliant';
  return typeof row.compliance_reason === 'string' && row.compliance_reason
    ? `${outcome} · ${row.compliance_reason}`
    : outcome;
}

function observationPlace(reportScope: Record<string, unknown>, row: Record<string, unknown>): string {
  const places = [
    row.site_id ? snapshotText(row.site_name, scopeLabelForId(reportScope, 'sites', row.site_id, 'name')) : null,
    row.zone_id ? snapshotText(row.zone_name, scopeLabelForId(reportScope, 'zones', row.zone_id, 'name')) : null,
  ].filter((place): place is string => Boolean(place));
  return places.join(' · ') || 'Not specified';
}

function observationVehicle(reportScope: Record<string, unknown>, row: Record<string, unknown>): string {
  const canonicalLabel = scopeLabelForId(reportScope, 'vehicles', row.canonical_vehicle_id, 'plate');
  return canonicalLabel === 'Not specified' ? snapshotText(row.vehicle_plate, snapshotText(row.plate_number)) : canonicalLabel;
}

function observationPerson(reportScope: Record<string, unknown>, row: Record<string, unknown>): string {
  const canonicalLabel = scopeLabelForId(reportScope, 'people', row.canonical_person_id, 'name');
  return canonicalLabel === 'Not specified' ? snapshotText(row.person_name) : canonicalLabel;
}

export function CustomReportSnapshot({ data, reportScope, idPrefix }: CustomReportSnapshotProps) {
  const observations = snapshotRows(data, 'observations');
  const breaches = snapshotRows(data, 'breaches');
  const incidents = snapshotRows(data, 'incidents');
  const checkpointVisits = snapshotRows(data, 'checkpoint_visits');
  const hasSummary = objectValue(data?.summary) !== null;
  const hasPlaceSelection = scopeIds(reportScope, 'site_ids').length + scopeIds(reportScope, 'zone_ids').length > 0;
  return (
    <div className="custom-report-snapshot">
      {hasSummary && <div className="custom-report-snapshot-metrics" aria-label="Generated source metrics">
        <div><span>Observations</span><strong>{summaryNumber(data, 'observation_count')}</strong></div>
        <div><span>Compliant</span><strong>{summaryNumber(data, 'compliant_count')}</strong></div>
        <div><span>Non-compliant</span><strong>{summaryNumber(data, 'non_compliant_count')}</strong></div>
        <div><span>Linked breaches</span><strong>{summaryNumber(data, 'breach_count')}</strong></div>
        {hasSummaryNumber(data, 'incident_count') && <div><span>Incidents</span><strong>{summaryNumber(data, 'incident_count')}</strong></div>}
        {hasSummaryNumber(data, 'checkpoint_visit_count') && <div><span>Checkpoint visits</span><strong>{summaryNumber(data, 'checkpoint_visit_count')}</strong></div>}
      </div>}
      <dl className="custom-report-snapshot-scope" aria-label="Frozen custom report scope">
        <div><dt>Sites</dt><dd>{scopeLabels(reportScope, 'sites', 'name').join(', ') || (hasPlaceSelection ? 'None selected' : 'All agreement Sites')}</dd></div>
        <div><dt>Zones</dt><dd>{scopeLabels(reportScope, 'zones', 'name').join(', ') || (hasPlaceSelection ? 'None selected' : 'All agreement Zones')}</dd></div>
        <div><dt>People</dt><dd>{scopeLabels(reportScope, 'people', 'name').join(', ') || 'All linked people'}</dd></div>
        <div><dt>Vehicles</dt><dd>{scopeLabels(reportScope, 'vehicles', 'plate').join(', ') || 'All linked vehicles'}</dd></div>
      </dl>
      {observations.length + breaches.length + incidents.length + checkpointVisits.length > 0 && (
        <div className="custom-report-snapshot-details">
          <h4>Frozen source detail</h4>
          {observations.length > 0 && <section aria-labelledby={`${idPrefix}-observations`}><h5 id={`${idPrefix}-observations`}>Observations ({observations.length})</h5><div className="custom-report-snapshot-table"><table><thead><tr><th>Date</th><th>Place</th><th>Vehicle</th><th>Person</th><th>Outcome</th></tr></thead><tbody>{observations.map((row, index) => <tr key={snapshotRowKey(row, index)}><td>{snapshotDate(row.observed_at)}</td><td>{observationPlace(reportScope, row)}</td><td>{observationVehicle(reportScope, row)}</td><td>{observationPerson(reportScope, row)}</td><td>{observationOutcome(row)}</td></tr>)}</tbody></table></div></section>}
          {breaches.length > 0 && <section aria-labelledby={`${idPrefix}-breaches`}><h5 id={`${idPrefix}-breaches`}>Breaches ({breaches.length})</h5><div className="custom-report-snapshot-table"><table><thead><tr><th>Date</th><th>Place</th><th>Vehicle</th><th>Type</th><th>Status</th></tr></thead><tbody>{breaches.map((row, index) => <tr key={snapshotRowKey(row, index)}><td>{snapshotDate(row.created_at)}</td><td>{observationPlace(reportScope, row)}</td><td>{snapshotText(row.plate_number)}</td><td>{snapshotText(row.breach_type)}</td><td>{snapshotText(row.status)}</td></tr>)}</tbody></table></div></section>}
          {incidents.length > 0 && <section aria-labelledby={`${idPrefix}-incidents`}><h5 id={`${idPrefix}-incidents`}>Incidents ({incidents.length})</h5><div className="custom-report-snapshot-table"><table><thead><tr><th>Date</th><th>Place</th><th>Type</th><th>Severity</th><th>Status</th></tr></thead><tbody>{incidents.map((row, index) => <tr key={snapshotRowKey(row, index)}><td>{snapshotDate(row.occurred_at)}</td><td>{observationPlace(reportScope, row)}</td><td>{snapshotText(row.incident_type)}</td><td>{snapshotText(row.severity)}</td><td>{snapshotText(row.status)}</td></tr>)}</tbody></table></div></section>}
          {checkpointVisits.length > 0 && <section aria-labelledby={`${idPrefix}-checkpoints`}><h5 id={`${idPrefix}-checkpoints`}>Checkpoint visits ({checkpointVisits.length})</h5><div className="custom-report-snapshot-table"><table><thead><tr><th>Date</th><th>Place</th><th>Method</th><th>Within radius</th></tr></thead><tbody>{checkpointVisits.map((row, index) => <tr key={snapshotRowKey(row, index)}><td>{snapshotDate(row.visited_at)}</td><td>{observationPlace(reportScope, row)}</td><td>{snapshotText(row.scan_method)}</td><td>{snapshotText(row.within_radius)}</td></tr>)}</tbody></table></div></section>}
        </div>
      )}
    </div>
  );
}