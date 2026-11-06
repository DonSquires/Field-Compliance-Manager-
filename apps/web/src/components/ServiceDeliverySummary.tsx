import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { readServiceDeliveryOverview, SERVICE_DELIVERY_LABELS } from '../lib/reportServiceDelivery';

type Overview = NonNullable<ReturnType<typeof readServiceDeliveryOverview>>;
type Result = { key: string } & (
  { state: 'loading' } | { state: 'error' } | { state: 'ready'; overview: Overview }
);

export function ServiceDeliverySummary({ agreementIds, start, end }: {
  agreementIds: string[]; start: string; end: string;
}) {
  const ids = [...new Set(agreementIds)].sort().join(',');
  const key = `${ids}:${start}:${end}`;
  const [result, setResult] = useState<Result>({ key, state: 'loading' });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    if (!ids) return;
    setResult({ key, state: 'loading' });
    const to = new Date(`${end}T00:00:00.000Z`);
    to.setUTCDate(to.getUTCDate() + 1);
    void (async () => {
      try {
        const { data, error } = await supabase.rpc('get_agreement_service_delivery_summary', {
          p_agreement_ids: ids.split(','), p_from: `${start}T00:00:00.000Z`, p_to: to.toISOString(),
        });
        const overview = error ? null : readServiceDeliveryOverview(data);
        if (active) setResult(overview ? { key, state: 'ready', overview } : { key, state: 'error' });
      } catch {
        if (active) setResult({ key, state: 'error' });
      }
    })();
    return () => { active = false; };
  }, [ids, start, end, key, retry]);

  const current = result.key === key ? result : { state: 'loading' as const };
  return <section className="reports-section" aria-labelledby="service-delivery-heading">
    <h2 id="service-delivery-heading">Officer service evidence</h2>
    {!ids ? <p role="status">Choose an agreement to view officer service evidence.</p>
      : current.state === 'loading' ? <p role="status">Loading officer service evidence…</p>
        : current.state === 'error' ? <div role="alert">
          <p>Officer service evidence is unavailable. Missing counts are not zero. The reporting projection may need to be installed.</p>
          <button type="button" className="btn btn-secondary" onClick={() => setRetry((value) => value + 1)}>Retry service evidence</button>
        </div> : <>
          <p>Agreement-attributed records, not additional patrol visits. Provenance overlaps are shown separately; do not add these figures to the activity totals.</p>
          <div className="reports-table-wrapper" role="region" aria-label="Officer service counts" tabIndex={0}>
            <table className="reports-table">
              <thead><tr><th scope="col">Evidence</th><th scope="col">Recorded</th><th scope="col">Already in activity</th><th scope="col">Additional records</th></tr></thead>
              <tbody>{current.overview.counts.map((row) => <tr key={row.kind}>
                <th scope="row">{SERVICE_DELIVERY_LABELS[row.kind]}</th>
                <td>{row.recorded}</td><td>{row.alreadyInActivity}</td><td>{row.additional}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <p>{current.overview.awaitingReview} officer incident reports awaiting review. Use Field reports in Evidence &amp; Reports to review them.</p>
          <p>{current.overview.handoversReceived} shift handovers received (internal count only). Private handover, briefing and outcome text is not copied into client reports.</p>
          <p>Generate fresh monthly report drafts to include the safe service-count summary. Existing and issued packs are not changed.</p>
        </>}
  </section>;
}
