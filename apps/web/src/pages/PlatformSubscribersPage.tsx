/**
 * PlatformSubscribersPage.tsx (nav id: platform-subscribers) — the owner console.
 *
 * Iron Eagle manages the R&M platform subscription here: invite or recover
 * the master user, suspend / reinstate / cancel, and watch
 * aggregate activity. It reads platform_list_subscribers() (counts and last
 * sign-in only) and writes only through platform_set_subscriber_status and
 * the invite-org edge function. Provider provisioning is migration-only. It never
 * reads a subscriber's operational or financial records (owner rulings
 * 2026-09-15 and 2026-11-01, docs/canon/ORG_SERVICE_MODEL.md).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Building2, KeyRound, Mail, PauseCircle, PlayCircle, RefreshCw, XCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { PLATFORM_MODULE_MANIFEST } from '../config/platformModuleManifest';
import './PageStyles.css';
import './PlatformSubscribersPage.css';

interface SubscriberRow {
  organization_id: string; name: string; organization_type: string; status: string; active: boolean; created_at: string; updated_at: string;
  contact_email: string | null; agreement_id: string | null; agreement_starts_on: string | null; agreement_ends_on: string | null;
  module_keys: string[]; active_module_count: number; suspended_module_count: number; cancelled_module_count: number;
  user_count: number; active_user_count: number; master_count: number; last_sign_in_at: string | null;
  shifts_30d: number; jobs_30d: number; sites: number; branches: number;
}

function moduleLabel(key: string): string {
  return PLATFORM_MODULE_MANIFEST.find((module) => module.key === key)?.label ?? key.split('_').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}
function relative(iso: string | null): string {
  if (!iso) return 'Never';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : `${days} days ago`;
}

const PlatformSubscribersPage: React.FC = () => {
  const { profile } = useAuth();
  const [rows, setRows] = useState<SubscriberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [inviteFor, setInviteFor] = useState<SubscriberRow | null>(null);
  const [inviteForm, setInviteForm] = useState({ email: '', displayName: '' });
  const [statusFor, setStatusFor] = useState<{ row: SubscriberRow; next: 'suspended' | 'cancelled' } | null>(null);
  const [statusReason, setStatusReason] = useState('');

  const isGrandMaster = profile?.role === 'grand_master';

  // ATLAS READS: platform_list_subscribers (rpc)
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const listRes = await supabase.rpc('platform_list_subscribers');
    if (listRes.error) setError(listRes.error.message);
    else setRows((listRes.data as SubscriberRow[]) ?? []);
    setLoading(false);
  }, []);
  useEffect(() => { if (isGrandMaster) void load(); else setLoading(false); }, [isGrandMaster, load]);

  const live = useMemo(() => rows.filter((row) => row.status !== 'archived'), [rows]);
  const archived = useMemo(() => rows.filter((row) => row.status === 'archived'), [rows]);

  const invite = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!inviteFor || !inviteForm.email.trim()) return;
    setSaving(true); setError(null); setNotice(null);
    const mode = inviteFor.active_user_count === 0 && inviteFor.user_count > 0 ? 'recovery' : 'invite';
    const { data, error: fnError } = await supabase.functions.invoke('invite-org', { body: { target_organization_id: inviteFor.organization_id, email: inviteForm.email.trim(), display_name: inviteForm.displayName.trim() || undefined, mode } });
    const failure = fnError?.message ?? (data && typeof data === 'object' && 'error' in data ? String((data as { error: string }).error) : null);
    if (failure) setError(failure);
    else { setNotice(mode === 'recovery' ? `Recovery invitation sent for ${inviteFor.name}.` : `Invitation sent. ${inviteForm.email.trim()} becomes ${inviteFor.name}'s master when they accept.`); setInviteFor(null); await load(); }
    setSaving(false);
  };

  const setStatus = async (row: SubscriberRow, next: 'active' | 'suspended' | 'cancelled', reason: string | null) => {
    setSaving(true); setError(null); setNotice(null);
    const { data, error: rpcError } = await supabase.rpc('platform_set_subscriber_status', { p_organization_id: row.organization_id, p_status: next, p_reason: reason });
    if (rpcError || !data) setError(rpcError?.message ?? 'The status change was not confirmed.');
    else {
      const receipt = data as { modules: string[] };
      setNotice(next === 'active' ? `${row.name} reinstated — ${receipt.modules.length} modules back on.` : next === 'suspended' ? `${row.name} suspended. Their pages are hidden until reinstated; nothing was deleted.` : `${row.name} cancelled and archived. Records are kept.`);
      setStatusFor(null); setStatusReason('');
      await load();
    }
    setSaving(false);
  };

  if (!isGrandMaster) {
    return <div className="page-container"><header className="page-header"><div><h1>Subscribers</h1></div></header><div className="empty-state"><p>Only the platform owner can manage subscribers.</p></div></div>;
  }
  if (loading) return <div className="page-container"><div className="loading-state"><div className="spinner" /><p>Loading subscribers</p></div></div>;

  return <div className="page-container platform-subscribers">
    <header className="page-header"><div><h1>Service provider</h1><p className="subtitle">R&amp;M is the only service provider. Iron Eagle manages its platform subscription and master login here; client organisations and their operational records remain separate.</p></div><div><button type="button" className="btn btn-secondary" onClick={() => void load()} aria-label="Refresh service provider"><RefreshCw size={16} /></button></div></header>
    {error && <div className="alert alert-error" role="alert"><button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">×</button>{error}</div>}
    {notice && <div className="alert alert-success" role="status">{notice}</div>}

    <section className="reports-section" aria-labelledby="live-subscribers-title">
      <h2 id="live-subscribers-title">Active and suspended ({live.length})</h2>
      {live.length === 0 ? <div className="empty-state"><p>No active service-provider subscription is listed. Provider onboarding is closed.</p></div> : <ul className="platform-subscriber-list" aria-label="Service provider">
        {live.map((row) => <li key={row.organization_id} className={`platform-subscriber ${row.status}`}>
          <div className="platform-subscriber-head"><Building2 size={18} /><div><h3>{row.name}</h3><small>{row.contact_email ?? 'No contact email'} · since {row.agreement_starts_on ?? new Date(row.created_at).toISOString().slice(0, 10)}{row.branches ? ` · ${row.branches} branch${row.branches === 1 ? '' : 'es'}` : ''}</small></div><span className={`status-badge status-${row.status === 'active' ? 'active' : 'suspended'}`}>{row.status}</span></div>
          <dl className="platform-subscriber-stats">
            <div><dt>Modules</dt><dd>{row.active_module_count} on{row.suspended_module_count ? ` · ${row.suspended_module_count} suspended` : ''}</dd></div>
            <div><dt>People</dt><dd>{row.active_user_count} active · {row.master_count} master{row.master_count === 1 ? '' : 's'}</dd></div>
            <div><dt>Last sign-in</dt><dd>{relative(row.last_sign_in_at)}</dd></div>
            <div><dt>Last 30 days</dt><dd>{row.shifts_30d} shifts · {row.jobs_30d} jobs</dd></div>
            <div><dt>Places</dt><dd>{row.sites}</dd></div>
          </dl>
          <p className="platform-subscriber-modules">{row.module_keys.map(moduleLabel).join(' · ') || 'No modules'}</p>
          {row.master_count === 0 && <p className="platform-subscriber-warning">{row.user_count === 0 ? 'No master user yet — send the invitation.' : 'All users are deactivated — send a recovery invitation.'}</p>}
          <div className="platform-subscriber-actions">
            <button type="button" className="btn btn-sm btn-secondary" disabled={saving} onClick={() => { setInviteFor(row); setInviteForm({ email: '', displayName: '' }); }}>{row.active_user_count === 0 && row.user_count > 0 ? <><KeyRound size={14} /> Recover access</> : <><Mail size={14} /> {row.master_count === 0 ? 'Invite master' : 'Invite another master'}</>}</button>
            {row.status === 'active' && <button type="button" className="btn btn-sm btn-secondary" disabled={saving} onClick={() => { setStatusFor({ row, next: 'suspended' }); setStatusReason(''); }}><PauseCircle size={14} /> Suspend</button>}
            {row.status === 'suspended' && <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => void setStatus(row, 'active', null)}><PlayCircle size={14} /> Reinstate</button>}
            <button type="button" className="btn btn-sm btn-secondary platform-danger" disabled={saving} onClick={() => { setStatusFor({ row, next: 'cancelled' }); setStatusReason(''); }}><XCircle size={14} /> Cancel subscription</button>
          </div>
        </li>)}
      </ul>}
    </section>

    {archived.length > 0 && <section className="reports-section" aria-labelledby="archived-subscribers-title">
      <h2 id="archived-subscribers-title">Cancelled ({archived.length})</h2>
      <ul className="platform-subscriber-list is-archived" aria-label="Cancelled subscribers">{archived.map((row) => <li key={row.organization_id} className="platform-subscriber archived"><div className="platform-subscriber-head"><Building2 size={18} /><div><h3>{row.name}</h3><small>{row.cancelled_module_count} modules ended{row.agreement_ends_on ? ` · agreement ended ${row.agreement_ends_on}` : ''}</small></div><span className="status-badge status-inactive">archived</span></div><div className="platform-subscriber-actions"><button type="button" className="btn btn-sm btn-secondary" disabled={saving} onClick={() => void setStatus(row, 'active', null)}><PlayCircle size={14} /> Reinstate</button></div></li>)}</ul>
    </section>}

    {inviteFor && <div className="platform-backdrop"><form className="platform-dialog" role="dialog" aria-modal="true" aria-labelledby="invite-title" onSubmit={invite}>
      <header><div><span>{inviteFor.name}</span><h2 id="invite-title">{inviteFor.active_user_count === 0 && inviteFor.user_count > 0 ? 'Recover access' : 'Invite a master user'}</h2></div><button type="button" onClick={() => setInviteFor(null)} aria-label="Close">×</button></header>
      <p>{inviteFor.active_user_count === 0 && inviteFor.user_count > 0 ? 'Re-sends the invitation to the organisation\u2019s locked-out master. No password is shared or set here.' : 'They receive an email link, set their own password, and become a master of this organisation. You never see their password.'}</p>
      <label><span>Email</span><input type="email" required autoComplete="off" value={inviteForm.email} onChange={(event) => setInviteForm({ ...inviteForm, email: event.target.value })} /></label>
      <label><span>Name (optional)</span><input maxLength={120} value={inviteForm.displayName} onChange={(event) => setInviteForm({ ...inviteForm, displayName: event.target.value })} /></label>
      <footer><button type="button" className="btn btn-secondary" onClick={() => setInviteFor(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving || !inviteForm.email.trim()}>{saving ? 'Sending' : 'Send invitation'}</button></footer>
    </form></div>}

    {statusFor && <div className="platform-backdrop"><form className="platform-dialog" role="dialog" aria-modal="true" aria-labelledby="status-title" onSubmit={(event) => { event.preventDefault(); void setStatus(statusFor.row, statusFor.next, statusReason); }}>
      <header><div><span>{statusFor.row.name}</span><h2 id="status-title">{statusFor.next === 'suspended' ? 'Suspend subscription' : 'Cancel subscription'}</h2></div><button type="button" onClick={() => setStatusFor(null)} aria-label="Close">×</button></header>
      <p>{statusFor.next === 'suspended' ? 'Their module pages disappear until you reinstate. Nothing is deleted and their people stay as they are.' : 'Ends every subscription line today and archives the organisation. Records are kept and it can be reinstated later.'}</p>
      <label><span>Reason (kept in the audit trail)</span><textarea required rows={3} value={statusReason} onChange={(event) => setStatusReason(event.target.value)} /></label>
      <footer><button type="button" className="btn btn-secondary" onClick={() => setStatusFor(null)}>Back</button><button type="submit" className={`btn ${statusFor.next === 'cancelled' ? 'btn-secondary platform-danger' : 'btn-primary'}`} disabled={saving || !statusReason.trim()}>{saving ? 'Saving' : statusFor.next === 'suspended' ? 'Suspend' : 'Cancel subscription'}</button></footer>
    </form></div>}
  </div>;
};

export default PlatformSubscribersPage;
