import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ArrowRightLeft, CheckCircle2, RefreshCw, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './OperationalContinuityPage.css';

type Severity = 'low' | 'standard' | 'high' | 'critical';

interface ContinuityItem {
  id: string;
  sourceOrganizationId: string;
  recipientOrganizationId: string;
  sourceLocationEventId: string;
  clientSiteId: string | null;
  zoneId: string | null;
  moduleKey: string;
  operationalStatus: string;
  severity: Severity;
  safeSummary: string;
  hazardFlags: string[];
  actionRequired: string | null;
  sourceOccurredAt: string;
  expiresAt: string;
  agreementName: string;
  placeName: string;
}

interface ContinuityReceipt {
  continuity_item_id: string;
  acknowledged_at: string;
  acknowledgement_notes: string | null;
  continuation_location_event_id: string | null;
}

interface LocationEvent {
  id: string;
  eventType: string;
  moduleKey: string;
  occurredAt: string;
  status: string | null;
  clientSiteId: string | null;
  zoneId: string | null;
  placeName: string;
}

function relationName(value: unknown, fallback: string): string {
  const row = Array.isArray(value) ? value[0] : value;
  if (row && typeof row === 'object' && 'name' in row && typeof row.name === 'string') return row.name;
  return fallback;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString('en-NZ', { dateStyle: 'medium', timeStyle: 'short' });
}

const OperationalContinuityPage = () => {
  const { profile, operatingOrganizationId } = useAuth();
  const organizationId = operatingOrganizationId ?? profile?.organizationId ?? null;
  const [incoming, setIncoming] = useState<ContinuityItem[]>([]);
  const [outgoing, setOutgoing] = useState<ContinuityItem[]>([]);
  const [receipts, setReceipts] = useState<Record<string, ContinuityReceipt>>({});
  const [events, setEvents] = useState<LocationEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [publishRequestId, setPublishRequestId] = useState(() => crypto.randomUUID());
  const [publishForm, setPublishForm] = useState({
    eventId: '',
    safeSummary: '',
    severity: 'standard' as Severity,
    hazardFlags: '',
    actionRequired: '',
  });
  const [ackForm, setAckForm] = useState({
    itemId: '',
    notes: '',
    continuationEventId: '',
    requestId: crypto.randomUUID(),
  });

  const mapItem = useCallback((row: any): ContinuityItem => ({
    id: row.id,
    sourceOrganizationId: row.source_organization_id,
    recipientOrganizationId: row.recipient_organization_id,
    sourceLocationEventId: row.source_location_event_id,
    clientSiteId: row.client_site_id,
    zoneId: row.zone_id,
    moduleKey: row.module_key,
    operationalStatus: row.operational_status,
    severity: row.severity,
    safeSummary: row.safe_summary,
    hazardFlags: Array.isArray(row.hazard_flags) ? row.hazard_flags.filter((flag: unknown): flag is string => typeof flag === 'string') : [],
    actionRequired: row.action_required,
    sourceOccurredAt: row.source_occurred_at,
    expiresAt: row.expires_at,
    agreementName: relationName(row.agreement, 'Service agreement'),
    placeName: relationName(row.site, relationName(row.zone, 'Agreement place')),
  }), []);

  const load = useCallback(async () => {
    if (!organizationId) {
      setError('Operating organisation access could not be confirmed.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const now = new Date().toISOString();
    const recentSince = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
    const itemSelect = 'id,source_organization_id,recipient_organization_id,source_location_event_id,client_site_id,zone_id,module_key,operational_status,severity,safe_summary,hazard_flags,action_required,source_occurred_at,expires_at,agreement:service_agreement_id(name),site:client_site_id(name),zone:zone_id(name)';
    const [incomingResponse, outgoingResponse, eventResponse] = await Promise.all([
      supabase.from('operational_continuity_items').select(itemSelect).eq('recipient_organization_id', organizationId).eq('operational_status', 'active').gte('expires_at', now).order('source_occurred_at', { ascending: false }).limit(100),
      supabase.from('operational_continuity_items').select(itemSelect).eq('source_organization_id', organizationId).order('created_at', { ascending: false }).limit(50),
      supabase.from('location_events').select('id,event_type,module_key,occurred_at,status,client_site_id,zone_id,site:client_site_id(name),zone:zone_id(name)').eq('organization_id', organizationId).not('module_key', 'is', null).gte('occurred_at', recentSince).order('occurred_at', { ascending: false }).limit(100),
    ]);
    const firstFailure = incomingResponse.error ?? outgoingResponse.error ?? eventResponse.error;
    if (firstFailure) {
      setError(firstFailure.message);
      setLoading(false);
      return;
    }
    const nextIncoming = (incomingResponse.data ?? []).map(mapItem);
    const itemIds = nextIncoming.map((item) => item.id);
    const receiptResponse = itemIds.length
      ? await supabase.from('operational_continuity_receipts').select('continuity_item_id,acknowledged_at,acknowledgement_notes,continuation_location_event_id').eq('recipient_organization_id', organizationId).in('continuity_item_id', itemIds)
      : { data: [] as ContinuityReceipt[], error: null };
    if (receiptResponse.error) {
      setError(receiptResponse.error.message);
      setLoading(false);
      return;
    }
    setIncoming(nextIncoming);
    setOutgoing((outgoingResponse.data ?? []).map(mapItem));
    setReceipts(Object.fromEntries(((receiptResponse.data as ContinuityReceipt[]) ?? []).map((receipt) => [receipt.continuity_item_id, receipt])));
    setEvents((eventResponse.data ?? []).map((row: any) => ({
      id: row.id,
      eventType: row.event_type,
      moduleKey: row.module_key,
      occurredAt: row.occurred_at,
      status: row.status,
      clientSiteId: row.client_site_id,
      zoneId: row.zone_id,
      placeName: relationName(row.site, relationName(row.zone, 'Recorded place')),
    })));
    setPublishForm((current) => ({
      ...current,
      eventId: (eventResponse.data ?? []).some((event: any) => event.id === current.eventId) ? current.eventId : (eventResponse.data?.[0]?.id ?? ''),
    }));
    setLoading(false);
  }, [mapItem, organizationId]);

  useEffect(() => { void load(); }, [load]);

  const selectedItem = incoming.find((item) => item.id === ackForm.itemId) ?? null;
  const continuationEvents = useMemo(() => {
    if (!selectedItem) return [];
    return events.filter((event) =>
      event.moduleKey === selectedItem.moduleKey
      && (
        (selectedItem.clientSiteId !== null && event.clientSiteId === selectedItem.clientSiteId)
        || (selectedItem.zoneId !== null && event.zoneId === selectedItem.zoneId)
      )
      && new Date(event.occurredAt).getTime() >= new Date(selectedItem.sourceOccurredAt).getTime()
    );
  }, [events, selectedItem]);

  const publish = async (event: FormEvent) => {
    event.preventDefault();
    if (!publishForm.eventId || !publishForm.safeSummary.trim()) {
      setError('Choose a location event and write the safe operational summary.');
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    const { error: publishError } = await supabase.rpc('publish_location_event_continuity', {
      p_client_request_id: publishRequestId,
      p_location_event_id: publishForm.eventId,
      p_safe_summary: publishForm.safeSummary.trim(),
      p_severity: publishForm.severity,
      p_hazard_flags: publishForm.hazardFlags.split(',').map((flag) => flag.trim()).filter(Boolean),
      p_action_required: publishForm.actionRequired.trim() || null,
    });
    if (publishError) setError(publishError.message);
    else {
      setNotice('Safe operational handoff published with an audit receipt. The source event remains owned by its authoring organisation.');
      setPublishRequestId(crypto.randomUUID());
      setPublishForm((current) => ({ ...current, safeSummary: '', hazardFlags: '', actionRequired: '' }));
      await load();
    }
    setSaving(false);
  };

  const acknowledge = async (event: FormEvent) => {
    event.preventDefault();
    if (!ackForm.itemId) {
      setError('Choose the continuity item being acknowledged.');
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    const { error: acknowledgementError } = await supabase.rpc('acknowledge_operational_continuity_item', {
      p_client_request_id: ackForm.requestId,
      p_continuity_item_id: ackForm.itemId,
      p_acknowledgement_notes: ackForm.notes.trim() || null,
      p_continuation_location_event_id: ackForm.continuationEventId || null,
    });
    if (acknowledgementError) setError(acknowledgementError.message);
    else {
      setNotice('Handoff acknowledged. The immutable receipt records who accepted it and any linked continuation event.');
      setAckForm({ itemId: '', notes: '', continuationEventId: '', requestId: crypto.randomUUID() });
      await load();
    }
    setSaving(false);
  };

  return (
    <div className="continuity-page">
      <header className="continuity-page-header">
        <div><span>Field operations</span><h1>Operational continuity</h1><p>Exchange the minimum safe handoff between a client and provider without transferring ownership of the source record.</p></div>
        <button type="button" onClick={() => void load()} disabled={loading}><RefreshCw size={16} className={loading ? 'is-spinning' : ''} />Refresh</button>
      </header>

      {error && <div className="continuity-message is-error" role="alert">{error}</div>}
      {notice && <div className="continuity-message is-success" role="status"><CheckCircle2 size={16} />{notice}</div>}

      <section className="continuity-principle" aria-label="Continuity boundary">
        <ShieldCheck size={20} aria-hidden="true" />
        <div><strong>Safe projection, not shared ownership</strong><span>Finance, staff records, unrestricted attachments, and source editing stay outside this handoff. Expired items cannot be acknowledged.</span></div>
      </section>

      <div className="continuity-grid">
        <section className="continuity-panel" aria-labelledby="continuity-incoming">
          <header><div><span>Receive</span><h2 id="continuity-incoming">Handoffs requiring awareness</h2></div><strong>{incoming.length}</strong></header>
          {loading ? <p>Loading active handoffs…</p> : incoming.length === 0 ? <div className="continuity-empty">No active handoffs are waiting for this organisation.</div> : (
            <div className="continuity-list">
              {incoming.map((item) => {
                const receipt = receipts[item.id];
                return <article key={item.id} className={`severity-${item.severity}`}>
                  <div className="continuity-item-meta"><span>{item.severity}</span><time dateTime={item.sourceOccurredAt}>{formatTime(item.sourceOccurredAt)}</time></div>
                  <h3>{item.placeName} · {item.moduleKey.replaceAll('_', ' ')}</h3>
                  <p>{item.safeSummary}</p>
                  {item.hazardFlags.length > 0 && <div className="continuity-flags">{item.hazardFlags.map((flag) => <span key={flag}>{flag}</span>)}</div>}
                  {item.actionRequired && <p className="continuity-action"><strong>Action required</strong>{item.actionRequired}</p>}
                  <small>{item.agreementName} · expires {formatTime(item.expiresAt)}</small>
                  {receipt
                    ? <div className="continuity-receipt"><CheckCircle2 size={15} />Acknowledged {formatTime(receipt.acknowledged_at)}{receipt.acknowledgement_notes ? ` · ${receipt.acknowledgement_notes}` : ''}</div>
                    : <button type="button" className="btn btn-sm btn-primary" onClick={() => { setAckForm({ itemId: item.id, notes: '', continuationEventId: '', requestId: crypto.randomUUID() }); setError(null); setNotice(null); }}>Acknowledge handoff</button>}
                </article>;
              })}
            </div>
          )}
          {selectedItem && (
            <form className="continuity-form" onSubmit={acknowledge}>
              <h3>Acknowledge {selectedItem.placeName}</h3>
              <p>Confirm this organisation has seen the handoff. Linking a continuation event is optional and only offers events from the same module, place, and later time.</p>
              <label><span>Receipt notes</span><textarea rows={3} value={ackForm.notes} onChange={(event) => setAckForm((current) => ({ ...current, notes: event.target.value }))} /></label>
              <label><span>Continuation event</span><select value={ackForm.continuationEventId} onChange={(event) => setAckForm((current) => ({ ...current, continuationEventId: event.target.value }))}><option value="">No linked continuation event</option>{continuationEvents.map((continuation) => <option key={continuation.id} value={continuation.id}>{continuation.eventType.replaceAll('_', ' ')} · {formatTime(continuation.occurredAt)}</option>)}</select></label>
              <footer><button type="button" className="btn btn-sm btn-secondary" onClick={() => setAckForm({ itemId: '', notes: '', continuationEventId: '', requestId: crypto.randomUUID() })}>Cancel</button><button type="submit" className="btn btn-sm btn-primary" disabled={saving}>{saving ? 'Saving receipt…' : 'Confirm acknowledgement'}</button></footer>
            </form>
          )}
        </section>

        <section className="continuity-panel" aria-labelledby="continuity-publish">
          <header><div><span>Publish</span><h2 id="continuity-publish">Create a safe handoff</h2></div><ArrowRightLeft size={22} aria-hidden="true" /></header>
          <form className="continuity-form" onSubmit={publish}>
            <p>Select a real location event from the last seven days. The agreement policy decides whether its place, module, coverage window, and receiving party permit publication.</p>
            <label><span>Source location event</span><select value={publishForm.eventId} onChange={(event) => setPublishForm((current) => ({ ...current, eventId: event.target.value }))}><option value="">Choose an event…</option>{events.map((sourceEvent) => <option key={sourceEvent.id} value={sourceEvent.id}>{sourceEvent.placeName} · {sourceEvent.moduleKey.replaceAll('_', ' ')} · {formatTime(sourceEvent.occurredAt)}</option>)}</select></label>
            <label><span>Safe operational summary</span><textarea required maxLength={2000} rows={5} value={publishForm.safeSummary} onChange={(event) => setPublishForm((current) => ({ ...current, safeSummary: event.target.value }))} placeholder="State only what the receiving organisation needs for the live task." /></label>
            <div className="continuity-form-row">
              <label><span>Severity</span><select value={publishForm.severity} onChange={(event) => setPublishForm((current) => ({ ...current, severity: event.target.value as Severity }))}><option value="low">Low</option><option value="standard">Standard</option><option value="high">High</option><option value="critical">Critical</option></select></label>
              <label><span>Hazard flags</span><input value={publishForm.hazardFlags} onChange={(event) => setPublishForm((current) => ({ ...current, hazardFlags: event.target.value }))} placeholder="aggression, unsafe access" /></label>
            </div>
            <label><span>Action required</span><textarea rows={3} value={publishForm.actionRequired} onChange={(event) => setPublishForm((current) => ({ ...current, actionRequired: event.target.value }))} placeholder="What should the receiving organisation do next?" /></label>
            <footer><span>The client request ID is retained across retries.</span><button type="submit" className="btn btn-sm btn-primary" disabled={saving || !events.length}>{saving ? 'Publishing…' : 'Publish safe handoff'}</button></footer>
          </form>
          <div className="continuity-outgoing">
            <h3>Recent published handoffs</h3>
            {outgoing.length === 0 ? <div className="continuity-empty">No handoffs have been published by this organisation.</div> : outgoing.map((item) => <article key={item.id}><div><strong>{item.placeName}</strong><span>{item.moduleKey.replaceAll('_', ' ')} · {item.operationalStatus}</span></div><time dateTime={item.sourceOccurredAt}>{formatTime(item.sourceOccurredAt)}</time></article>)}
          </div>
        </section>
      </div>
    </div>
  );
};

export default OperationalContinuityPage;
