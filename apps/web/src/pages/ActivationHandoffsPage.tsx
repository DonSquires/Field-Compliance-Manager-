import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight, ClipboardCheck, ExternalLink, RefreshCw, ShieldAlert, TimerReset, UsersRound } from 'lucide-react';
import { supabase } from '../lib/supabase';
import './ActivationHandoffsPage.css';

interface HandoffTask { task_id: string; task_key: string; title: string; destination: string; status: 'pending' | 'completed'; completion_note: string | null; completed_at: string | null; completed_by_name: string | null }
interface HandoffSite { site_id: string; name: string; address: string | null; risk_level: string | null; access_instructions: string | null; hs_notes: string | null }
interface HandoffWorkUnit { work_unit_id: string; name: string; service_type: string; active: boolean }
interface HandoffRow { handoff_id: string; account_organization_id: string; account_name: string; agreement_id: string; agreement_name: string; owner_user_id: string | null; owner_name: string | null; handoff_status: 'open' | 'completed'; version: number; activated_at: string; completed_at: string | null; tasks: HandoffTask[]; sites: HandoffSite[]; work_units: HandoffWorkUnit[]; first_roster_at: string | null }

export default function ActivationHandoffsPage({ onNavigate }: { onNavigate: (destination: string) => void }) {
  const [rows, setRows] = useState<HandoffRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const selected = rows.find((row) => row.handoff_id === selectedId) ?? null;

  const loadHandoffs = useCallback(async (preferred?: string) => {
    setLoading(true); setError(null);
    const { data, error: loadError } = await supabase.rpc('get_crm_activation_handoffs');
    if (loadError) { setRows([]); setSelectedId(null); setError(loadError.message); }
    else {
      const next = (data as HandoffRow[]) ?? [];
      setRows(next); setSelectedId(preferred && next.some((row) => row.handoff_id === preferred) ? preferred : next[0]?.handoff_id ?? null);
      setNotes(Object.fromEntries(next.flatMap((row) => row.tasks.map((task) => [task.task_id, task.completion_note ?? '']))));
    }
    setLoading(false);
  }, []);

  useEffect(() => { void loadHandoffs(); }, [loadHandoffs]);

  const updateTask = async (task: HandoffTask, complete: boolean) => {
    if (!selected) return;
    setSaving(true); setError(null); setNotice(null);
    const { error: actionError } = await supabase.rpc('manage_crm_activation_handoff_task', {
      p_handoff_id: selected.handoff_id,
      p_task_id: task.task_id,
      p_expected_version: selected.version,
      p_complete: complete,
      p_note: notes[task.task_id]?.trim() ?? '',
    });
    if (actionError) setError(actionError.message);
    else { setNotice(`${task.title} ${complete ? 'completed' : 'reopened'}.`); await loadHandoffs(selected.handoff_id); }
    setSaving(false);
  };

  const openCount = rows.filter((row) => row.handoff_status === 'open').length;
  const pendingTasks = rows.flatMap((row) => row.tasks).filter((task) => task.status === 'pending').length;
  return <div className="handoff-page">
    <header><div><span>Mobilisation control</span><h1>Activation handoffs</h1><p>Turn activated agreements into visible site briefings, roster actions, and reporting delivery.</p></div><button type="button" onClick={() => void loadHandoffs()} disabled={loading}><RefreshCw size={16} className={loading ? 'is-spinning' : ''} />Refresh</button></header>
    {error && <div className="handoff-message is-error" role="alert"><AlertTriangle size={16} />{error}</div>}
    {notice && <div className="handoff-message is-success" role="status"><CheckCircle2 size={16} />{notice}</div>}
    <section className="handoff-summary"><div><TimerReset size={18} /><span>Open handoffs</span><strong>{openCount}</strong></div><div><ClipboardCheck size={18} /><span>Pending actions</span><strong>{pendingTasks}</strong></div><div><CheckCircle2 size={18} /><span>Completed</span><strong>{rows.length - openCount}</strong></div></section>
    <div className="handoff-workspace"><aside><header><strong>Activated accounts</strong><span>Most recent first</span></header>{loading && !rows.length ? <div className="handoff-empty">Loading handoffs</div> : rows.length ? rows.map((row) => <button type="button" key={row.handoff_id} className={selectedId === row.handoff_id ? 'is-selected' : ''} onClick={() => setSelectedId(row.handoff_id)}><span className={`is-${row.handoff_status}`}>{row.handoff_status === 'completed' ? <CheckCircle2 size={15} /> : <TimerReset size={15} />}</span><div><strong>{row.account_name}</strong><small>{row.agreement_name}</small><small>{row.owner_name ?? 'Owner unavailable'}</small></div><ChevronRight size={15} /></button>) : <div className="handoff-empty">No activated account handoffs.</div>}</aside>
      <main>{selected ? <><header><div><span>{selected.handoff_status} mobilisation</span><h2>{selected.account_name}</h2><p>{selected.agreement_name} · activated {new Date(selected.activated_at).toLocaleDateString('en-NZ')}</p></div><strong>{selected.tasks.filter((task) => task.status === 'completed').length}/{selected.tasks.length} complete</strong></header>
        <section className="handoff-evidence"><article><header><ShieldAlert size={17} /><div><strong>Site briefing evidence</strong><span>{selected.sites.length} covered {selected.sites.length === 1 ? 'site' : 'sites'}</span></div></header>{selected.sites.length ? selected.sites.map((site) => <div key={site.site_id}><strong>{site.name}</strong><small>{site.address ?? 'Address not recorded'} · risk {site.risk_level ?? 'not classified'}</small><p><b>Access:</b> {site.access_instructions ?? 'No access instructions recorded'}</p><p><b>Safety:</b> {site.hs_notes ?? 'No health and safety notes recorded'}</p></div>) : <p>No covered client sites are linked.</p>}<button type="button" onClick={() => onNavigate('site-360')}>Open sites <ExternalLink size={13} /></button></article>
          <article><header><UsersRound size={17} /><div><strong>Operational launch evidence</strong><span>{selected.work_units.length} active work {selected.work_units.length === 1 ? 'unit' : 'units'}</span></div></header>{selected.work_units.length ? selected.work_units.map((unit) => <div key={unit.work_unit_id}><strong>{unit.name}</strong><small>{unit.service_type.replaceAll('_', ' ')}</small></div>) : <p>No agreement work units are recorded.</p>}<p><b>First roster action:</b> {selected.first_roster_at ? new Date(selected.first_roster_at).toLocaleString('en-NZ') : 'Not published'}</p><button type="button" onClick={() => onNavigate('roster')}>Open roster <ExternalLink size={13} /></button></article></section>
        <section className="handoff-tasks"><header><div><h3>Mobilisation actions</h3><p>Completion notes are audit evidence. Roster completion requires a real post-activation slot.</p></div></header>{selected.tasks.map((task) => <article key={task.task_id} className={`is-${task.status}`}><span>{task.status === 'completed' ? <CheckCircle2 size={17} /> : <ClipboardCheck size={17} />}</span><div><strong>{task.title}</strong><small>{task.status === 'completed' ? `Completed by ${task.completed_by_name ?? 'administrator'}` : 'Action required'}</small><textarea aria-label={`Completion note for ${task.title}`} rows={2} maxLength={1000} value={notes[task.task_id] ?? ''} onChange={(event) => setNotes({ ...notes, [task.task_id]: event.target.value })} placeholder="Record what was confirmed and by whom" /></div><div><button type="button" onClick={() => onNavigate(task.destination)}>Open owner</button><button type="button" className="is-primary" disabled={saving || (notes[task.task_id]?.trim().length ?? 0) < 3} onClick={() => void updateTask(task, task.status !== 'completed')}>{task.status === 'completed' ? 'Reopen' : 'Complete'}</button></div></article>)}</section>
      </> : <div className="handoff-empty">Select an activated account handoff.</div>}</main>
    </div>
  </div>;
}