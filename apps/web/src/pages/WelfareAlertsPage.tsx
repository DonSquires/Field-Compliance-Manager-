import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, Crosshair, MapPin, Phone, RefreshCw, ShieldAlert, ShieldCheck, Siren, UserCheck, X } from 'lucide-react';
import { schemaWelfareAlertStatus, type WelfareAlertStatus } from '../lib/welfareAlertStatus';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './WelfareAlertsPage.css';

type AlertType = 'overdue' | 'man_down' | 'sos' | 'armed_danger' | 'inactivity' | 'gps_lost' | 'missed' | 'manual' | 'investigation_overdue' | 'check_in';
type AlertFilter = 'active' | WelfareAlertStatus | 'all';
type AlertAction = 'acknowledge' | 'resolve';

interface WelfareAlert {
  id: string;
  officer_user_id: string;
  status: WelfareAlertStatus;
  alert_type: AlertType;
  escalation_level: number;
  escalated_at: string | null;
  acknowledged_at: string | null;
  acknowledgement_notes: string | null;
  resolved_at: string | null;
  resolution_notes: string | null;
  triggered_at: string;
  gps_lat: number | null;
  gps_lng: number | null;
  gps_accuracy: number | null;
  officer_phone: string | null;
  notes: string | null;
  officer: { id: string; display_name: string | null; phone: string | null } | null;
}

const ALERT_LABEL: Record<AlertType, string> = {
  overdue: 'Overdue check-in',
  man_down: 'Man-down',
  sos: 'SOS',
  armed_danger: 'Armed danger',
  inactivity: 'Inactivity',
  gps_lost: 'GPS lost',
  missed: 'Missed check-in',
  manual: 'Manual alert',
  investigation_overdue: 'Investigation overdue',
  check_in: 'Check-in alert',
};

const FILTERS: Array<{ id: AlertFilter; label: string }> = [
  { id: 'active', label: 'Active' },
  { id: 'pending', label: 'Pending' },
  { id: 'acknowledged', label: 'Acknowledged' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'all', label: 'All' },
];

const WelfareAlertsPage: React.FC = () => {
  const { profile } = useAuth();
  const [alerts, setAlerts] = useState<WelfareAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<AlertFilter>('active');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [action, setAction] = useState<AlertAction | null>(null);
  const [actionNotes, setActionNotes] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadAlerts = useCallback(async () => {
    if (!profile?.organizationId) return;
    setLoading(true);
    setError(null);
    try {
      const { data, error: queryError } = await supabase
        .from('welfare_alerts')
        .select('id, officer_user_id, status, alert_type, escalation_level, escalated_at, acknowledged_at, acknowledgement_notes, resolved_at, resolution_notes, triggered_at, gps_lat, gps_lng, gps_accuracy, officer_phone, notes, officer:officer_user_id(id, display_name, phone)')
        .eq('organization_id', profile.organizationId)
        .order('escalation_level', { ascending: false })
        .order('triggered_at', { ascending: false })
        .limit(150);
      if (queryError) throw queryError;
      const normalized = ((data as any[]) ?? []).map((row) => ({ ...row, status: schemaWelfareAlertStatus(row.status ?? 'pending') })) as WelfareAlert[];
      setAlerts(normalized);
      setSelectedId((current) => current && normalized.some((alert) => alert.id === current) ? current : normalized.find((alert) => alert.status !== 'resolved')?.id ?? normalized[0]?.id ?? null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Welfare alerts could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [profile?.organizationId]);

  useEffect(() => { void loadAlerts(); }, [loadAlerts]);

  useEffect(() => {
    if (!profile?.organizationId) return;
    const channel = supabase
      .channel(`welfare_supervisor_${profile.organizationId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'welfare_alerts', filter: `organization_id=eq.${profile.organizationId}` }, () => void loadAlerts())
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [loadAlerts, profile?.organizationId]);

  const visibleAlerts = useMemo(() => alerts.filter((alert) => {
    if (filter === 'all') return true;
    if (filter === 'active') return alert.status === 'pending' || alert.status === 'acknowledged';
    return alert.status === filter;
  }), [alerts, filter]);

  const selected = alerts.find((alert) => alert.id === selectedId) ?? null;
  const pendingCount = alerts.filter((alert) => alert.status === 'pending').length;
  const acknowledgedCount = alerts.filter((alert) => alert.status === 'acknowledged').length;
  const criticalCount = alerts.filter((alert) => alert.status !== 'resolved' && (alert.alert_type === 'sos' || alert.alert_type === 'armed_danger' || alert.escalation_level >= 3)).length;
  const resolvedCount = alerts.filter((alert) => alert.status === 'resolved').length;

  const openAction = (nextAction: AlertAction) => {
    setAction(nextAction);
    setActionNotes('');
    setError(null);
  };

  const submitAction = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !action || !actionNotes.trim()) return;
    setBusyId(selected.id);
    setError(null);
    setNotice(null);
    try {
      const { data, error: updateError } = await supabase.rpc('manage_welfare_alert', { p_alert_id: selected.id, p_expected_status: selected.status, p_action: action, p_notes: actionNotes.trim() });
      if (updateError) throw updateError;
      if (!data) throw new Error('This alert changed before your action was saved. Refresh and review its current state.');
      setNotice(action === 'acknowledge' ? 'Alert acknowledged. Automatic escalation is paused while response is underway.' : 'Alert resolved with the recorded safety outcome.');
      setAction(null);
      setActionNotes('');
      await loadAlerts();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'The welfare action could not be confirmed.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="welfare-page">
      <header className="welfare-heading">
        <div><span>Safety operations</span><h1>Welfare response</h1><p>Live officer alerts, escalation state, and human response records.</p></div>
        <button type="button" onClick={() => void loadAlerts()} disabled={loading}><RefreshCw size={17} className={loading ? 'is-spinning' : ''} /> Refresh</button>
      </header>

      <section className="welfare-summary" aria-label="Welfare alert summary">
        <div className="is-critical"><Siren size={18} /><span>Critical active</span><strong>{criticalCount}</strong></div>
        <div><Clock3 size={18} /><span>Pending</span><strong>{pendingCount}</strong></div>
        <div><UserCheck size={18} /><span>Acknowledged</span><strong>{acknowledgedCount}</strong></div>
        <div><ShieldCheck size={18} /><span>Resolved in view</span><strong>{resolvedCount}</strong></div>
      </section>

      {error && <div className="welfare-message is-error" role="alert"><AlertTriangle size={17} /><span>{error}</span><button type="button" onClick={() => setError(null)}><X size={16} /><span className="sr-only">Dismiss</span></button></div>}
      {notice && <div className="welfare-message is-success" role="status"><CheckCircle2 size={17} /><span>{notice}</span><button type="button" onClick={() => setNotice(null)}><X size={16} /><span className="sr-only">Dismiss</span></button></div>}

      <div className="welfare-filters" role="tablist" aria-label="Welfare status">{FILTERS.map((item) => <button type="button" role="tab" aria-selected={filter === item.id} className={filter === item.id ? 'is-active' : ''} onClick={() => setFilter(item.id)} key={item.id}>{item.label}</button>)}</div>

      <div className="welfare-layout">
        <section className="welfare-queue">
          <div className="welfare-panel-heading"><div><span>Response queue</span><h2>{filter === 'active' ? 'Active alerts' : `${filter} alerts`}</h2></div><ShieldAlert size={19} /></div>
          {loading ? <div className="welfare-empty"><RefreshCw size={20} className="is-spinning" /> Loading safety alerts</div> : visibleAlerts.length === 0 ? <div className="welfare-empty"><ShieldCheck size={21} /> No alerts in this view</div> : (
            <div className="welfare-list">{visibleAlerts.map((alert) => <AlertRow alert={alert} selected={selectedId === alert.id} onSelect={() => setSelectedId(alert.id)} key={alert.id} />)}</div>
          )}
        </section>

        <aside className="welfare-detail">
          {!selected ? <div className="welfare-empty"><ShieldAlert size={22} /> Select an alert to review</div> : (
            <>
              <div className="welfare-panel-heading"><div><span>Officer response</span><h2>{selected.officer?.display_name ?? 'Officer'}</h2></div><span className={`welfare-status status-${selected.status}`}>{selected.status}</span></div>
              <div className={`welfare-alert-banner type-${selected.alert_type}`}><AlertTypeIcon type={selected.alert_type} /><div><strong>{ALERT_LABEL[selected.alert_type]}</strong><span>Escalation level {selected.escalation_level} · triggered {formatAge(selected.triggered_at)}</span></div></div>

              <dl className="welfare-facts">
                <div><dt>Triggered</dt><dd>{new Date(selected.triggered_at).toLocaleString('en-NZ')}</dd></div>
                <div><dt>Last escalation</dt><dd>{selected.escalated_at ? new Date(selected.escalated_at).toLocaleString('en-NZ') : 'Not escalated'}</dd></div>
                <div><dt>Phone</dt><dd>{selected.officer_phone ?? selected.officer?.phone ?? 'Not available'}</dd></div>
                <div><dt>GPS accuracy</dt><dd>{selected.gps_accuracy != null ? `±${Math.round(selected.gps_accuracy)} m` : 'Not recorded'}</dd></div>
              </dl>

              {selected.notes && <section className="welfare-notes"><span>Alert evidence</span><p>{selected.notes}</p></section>}
              {selected.acknowledgement_notes && <section className="welfare-history-note"><UserCheck size={16} /><div><strong>Acknowledgement</strong><span>{selected.acknowledgement_notes}</span><small>{selected.acknowledged_at ? new Date(selected.acknowledged_at).toLocaleString('en-NZ') : ''}</small></div></section>}
              {selected.resolution_notes && <section className="welfare-history-note is-resolved"><CheckCircle2 size={16} /><div><strong>Resolution</strong><span>{selected.resolution_notes}</span><small>{selected.resolved_at ? new Date(selected.resolved_at).toLocaleString('en-NZ') : ''}</small></div></section>}

              <div className="welfare-contact-actions">
                {(selected.officer_phone ?? selected.officer?.phone) ? <a href={`tel:${selected.officer_phone ?? selected.officer?.phone}`}><Phone size={16} /> Call officer</a> : <button type="button" disabled><Phone size={16} /> Phone unavailable</button>}
                {selected.gps_lat != null && selected.gps_lng != null ? <a href={`https://www.google.com/maps?q=${selected.gps_lat},${selected.gps_lng}`} target="_blank" rel="noreferrer"><MapPin size={16} /> Open location</a> : <button type="button" disabled><Crosshair size={16} /> Location unavailable</button>}
              </div>

              {selected.status !== 'resolved' && <div className="welfare-actions">{selected.status === 'pending' && <button type="button" className="is-acknowledge" onClick={() => openAction('acknowledge')}><UserCheck size={17} /> Acknowledge</button>}<button type="button" className="is-resolve" onClick={() => openAction('resolve')}><CheckCircle2 size={17} /> Resolve</button></div>}
            </>
          )}
        </aside>
      </div>

      {action && selected && (
        <div className="welfare-dialog-backdrop">
          <form className="welfare-dialog" onSubmit={submitAction} role="dialog" aria-modal="true" aria-labelledby="welfare-action-title">
            <div className="welfare-panel-heading"><div><span>Safety lifecycle</span><h2 id="welfare-action-title">{action === 'acknowledge' ? 'Acknowledge alert' : 'Resolve alert'}</h2></div><button type="button" onClick={() => setAction(null)}><X size={18} /><span className="sr-only">Close</span></button></div>
            <div className="welfare-dialog-alert"><strong>{selected.officer?.display_name ?? 'Officer'} · {ALERT_LABEL[selected.alert_type]}</strong><span>Escalation level {selected.escalation_level}</span></div>
            <p>{action === 'acknowledge' ? 'Acknowledgement records that a responder has taken ownership and pauses automatic escalation. It does not declare the officer safe.' : 'Resolution closes the alert. Record the positive safety outcome or verified reason for closure.'}</p>
            <label><span>{action === 'acknowledge' ? 'Response plan' : 'Verified safety outcome'}</span><textarea required rows={4} value={actionNotes} onChange={(event) => setActionNotes(event.target.value)} placeholder={action === 'acknowledge' ? 'Who is responding and what action is underway?' : 'How was the officer confirmed safe, and by whom?'} /></label>
            <div className="welfare-dialog-actions"><button type="button" onClick={() => setAction(null)}>Cancel</button><button type="submit" className={action === 'acknowledge' ? 'is-acknowledge' : 'is-resolve'} disabled={busyId === selected.id || !actionNotes.trim()}>{busyId === selected.id ? 'Saving' : action === 'acknowledge' ? 'Confirm acknowledgement' : 'Confirm resolution'}</button></div>
          </form>
        </div>
      )}
    </div>
  );
};

function AlertRow({ alert, selected, onSelect }: { alert: WelfareAlert; selected: boolean; onSelect: () => void }) {
  return <button type="button" className={`${selected ? 'is-selected' : ''} status-${alert.status} type-${alert.alert_type}`} onClick={onSelect}><span className="welfare-row-icon"><AlertTypeIcon type={alert.alert_type} /></span><div><strong>{alert.officer?.display_name ?? 'Officer'}</strong><small>{ALERT_LABEL[alert.alert_type]} · level {alert.escalation_level}</small></div><div><span>{alert.status}</span><time dateTime={alert.triggered_at}>{formatAge(alert.triggered_at)}</time></div></button>;
}

function AlertTypeIcon({ type }: { type: AlertType }) {
  if (type === 'sos' || type === 'armed_danger') return <Siren size={19} />;
  if (type === 'gps_lost') return <Crosshair size={19} />;
  if (type === 'check_in') return <UserCheck size={19} />;
  return <ShieldAlert size={19} />;
}

function formatAge(value: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default WelfareAlertsPage;