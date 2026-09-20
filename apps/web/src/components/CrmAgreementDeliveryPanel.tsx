import { useEffect, useState } from 'react';
import { AlertTriangle, Building2, MapPin, RefreshCw, ShieldCheck, Siren } from 'lucide-react';
import { asDeliverySummary, deliveryHasGaps, deliveryPeriodBounds, deliveryWords, hoursOnPost, responseWords, type DeliveryPeriod, type DeliverySummary } from '../lib/serviceDelivery';
import { supabase } from '../lib/supabase';
import './CrmAgreementDeliveryPanel.css';

/** The provider's own view of what it delivered at this agreement's places — the same numbers the client sees. */
export function CrmAgreementDeliveryPanel({ agreementId, providerName }: { agreementId: string; providerName?: string | null }) {
  const [period, setPeriod] = useState<DeliveryPeriod>('this_month');
  const [summary, setSummary] = useState<DeliverySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const bounds = deliveryPeriodBounds(period);
    setLoading(true); setError(null);
    // ATLAS READS: get_agreement_service_delivery (provider admins / branch managers; same read the client portal uses)
    supabase.rpc('get_agreement_service_delivery', { p_agreement_id: agreementId, p_period_start: bounds.start, p_period_end: bounds.end }).then(({ data, error: readError }) => {
      if (cancelled) return;
      const parsed = asDeliverySummary(data);
      if (readError || !parsed) { setError(readError?.message ?? 'Delivered work could not be loaded.'); setSummary(null); }
      else setSummary(parsed);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [agreementId, period]);

  return (
    <section className="crm-agreement-delivery" aria-label="Delivered at this agreement's places">
      <header>
        <div><span>Delivered</span><strong>What {providerName ?? 'we'} actually did at the client's places</strong><p>The client sees these same numbers on its portal. Counted from shifts started and ended in the app, and arrivals and departures recorded at each place.</p></div>
        <div className="crm-agreement-delivery-period" role="group" aria-label="Period">
          <button type="button" className={period === 'this_month' ? 'is-active' : ''} onClick={() => setPeriod('this_month')}>This month</button>
          <button type="button" className={period === 'last_month' ? 'is-active' : ''} onClick={() => setPeriod('last_month')}>Last month</button>
        </div>
      </header>
      {error && <p className="crm-agreement-delivery-error" role="alert"><AlertTriangle size={14} aria-hidden="true" /> {error}</p>}
      {loading || !summary ? <p className="crm-agreement-delivery-note"><RefreshCw size={14} className="is-spinning" aria-hidden="true" /> Checking delivered work</p> : (
        <>
          <div className={`crm-agreement-delivery-totals ${deliveryHasGaps(summary) ? 'has-gaps' : ''}`}>
            <div><strong>{summary.totals.patrol_completed}/{summary.totals.patrol_expected}</strong><span>visits done</span></div>
            <div><strong>{summary.totals.patrol_missed}</strong><span>missed</span></div>
            <div><strong>{summary.totals.patrol_late}</strong><span>late</span></div>
            <div><strong>{summary.totals.post_attended}/{summary.totals.post_expected}</strong><span>posts attended</span></div>
            <div><strong>{hoursOnPost(summary.totals.post_minutes)}</strong><span>on post</span></div>
          </div>
          {summary.places.length === 0 ? <p className="crm-agreement-delivery-note">No places are attached to this agreement yet, so nothing can be delivered against it.</p> : (
            <ul className="crm-agreement-delivery-places">
              {summary.places.map((place) => { const words = deliveryWords(place); return (
                <li key={place.location_id} className={place.patrol_missed || place.post_attended < place.post_expected ? 'has-gaps' : ''}>
                  {place.place_kind === 'zone' ? <MapPin size={14} aria-hidden="true" /> : <Building2 size={14} aria-hidden="true" />}
                  <div><strong>{place.place_name ?? 'Contracted place'}</strong><span>{[words.patrol, words.post].filter(Boolean).join(' · ') || 'Nothing was due here in this period.'}</span></div>
                  <small>{words.presence}</small>
                </li>
              ); })}
            </ul>
          )}
          {(() => { const response = responseWords(summary); return response && <p className={`crm-agreement-delivery-note crm-agreement-delivery-responses is-${response.tone}`}><Siren size={14} aria-hidden="true" /> <span><b>Responses</b> {response.text}</span></p>; })()}
          {deliveryHasGaps(summary) && <p className="crm-agreement-delivery-note is-gap"><ShieldCheck size={14} aria-hidden="true" /> The client can see these gaps too. Check the roster and the officers' shift records before the monthly report goes out.</p>}
        </>
      )}
    </section>
  );
}
