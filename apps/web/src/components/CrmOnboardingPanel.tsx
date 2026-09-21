import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarClock, CheckCircle2, ChevronRight, Clock3, MailPlus, RefreshCw, Rocket, UserRound, X } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface ReadinessDimension {
  key: string;
  label: string;
  status: 'ready' | 'blocked';
  detail: string;
  owner: string;
}

interface OnboardingRow {
  ledger_id: string;
  account_organization_id: string;
  account_name: string;
  organization_status: string;
  organization_updated_at: string;
  current_stage: 'qualify' | 'configure' | 'review';
  ledger_status: string;
  version: number;
  target_live_at: string;
  days_open: number;
  overdue: boolean;
  has_primary_contact: boolean;
  agreement_id: string | null;
  agreement_name: string | null;
  invitation_status?: 'not_invited' | 'invited' | 'accepted' | 'declined' | 'expired' | null;
  readiness: { ready: boolean; dimensions: ReadinessDimension[] } | null;
  assigned_to: string | null;
  assigned_name: string | null;
  stage_note: string | null;
  /** Active users at the client organisation; the first is seated by the invitation itself. */
  client_user_count?: number | null;
}

interface Assignee {
  user_id: string;
  display_name: string;
  role: string;
}

const stages = ['qualify', 'configure', 'review'] as const;

export function CrmOnboardingPanel({
  accountId,
  accountStatus,
  onChanged,
}: {
  accountId: string;
  accountStatus?: string;
  onChanged?: () => void | Promise<void>;
}) {
  const [row, setRow] = useState<OnboardingRow | null>(null);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [assignedTo, setAssignedTo] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [stageNote, setStageNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmingInvite, setConfirmingInvite] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [resending, setResending] = useState(false);
  const [activated, setActivated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const [workspaceResult, assigneeResult] = await Promise.all([
      supabase.rpc('get_crm_onboarding_workspace'),
      supabase.rpc('get_crm_onboarding_assignees'),
    ]);
    if (workspaceResult.error || assigneeResult.error) {
      setError(workspaceResult.error?.message ?? assigneeResult.error?.message ?? 'Onboarding evidence could not be loaded.');
      setRow(null);
    } else {
      const nextRow = ((workspaceResult.data as OnboardingRow[]) ?? []).find((item) => item.account_organization_id === accountId) ?? null;
      const nextAssignees = (assigneeResult.data as Assignee[]) ?? [];
      setRow(nextRow);
      setAssignees(nextAssignees);
      setAssignedTo(nextRow?.assigned_to ?? nextAssignees[0]?.user_id ?? '');
      setTargetDate(nextRow?.target_live_at?.slice(0, 10) ?? new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
      setStageNote(nextRow?.stage_note ?? 'Reviewed identity, contacts, agreement, geography, commercial evidence, and roster readiness in the client portfolio.');
    }
    setLoading(false);
  }, [accountId]);

  useEffect(() => { void load(); }, [load]);

  const nextStage = useMemo(() => {
    if (!row) return null;
    const index = stages.indexOf(row.current_stage);
    return index >= 0 && index < stages.length - 1 ? stages[index + 1] : null;
  }, [row]);

  const saveWorkflow = async (advance: boolean) => {
    if (!row) return;
    const stage = advance && nextStage ? nextStage : row.current_stage;
    setSaving(true); setError(null); setNotice(null);
    const { error: actionError } = await supabase.rpc('manage_crm_onboarding_workflow', {
      p_account_organization_id: row.account_organization_id,
      p_expected_version: row.version,
      p_stage: stage,
      p_target_live_at: `${targetDate}T23:59:59Z`,
      p_assigned_to: assignedTo,
      p_note: stageNote,
    });
    if (actionError) setError(actionError.message);
    else {
      setNotice(advance && nextStage ? `Onboarding advanced to ${nextStage}.` : 'Onboarding ownership saved.');
      await load();
      await onChanged?.();
    }
    setSaving(false);
  };

  const activate = async () => {
    if (!row?.agreement_id) return;
    setSaving(true); setError(null); setNotice(null);
    const { error: actionError } = await supabase.rpc('activate_crm_account', {
      p_account_organization_id: row.account_organization_id,
      p_agreement_id: row.agreement_id,
      p_expected_organization_updated_at: row.organization_updated_at,
      p_expected_ledger_version: row.version,
    });
    if (actionError) setError(actionError.message);
    else {
      setActivated(true);
      setConfirming(false);
      setNotice('Account activated. The roster handoff can continue from this portfolio.');
      await load();
      await onChanged?.();
    }
    setSaving(false);
  };

  const inviteClient = async () => {
    if (!row) return;
    setInviting(true); setError(null); setNotice(null);
    const { data: prepared, error: prepareError } = await supabase.rpc('prepare_crm_client_invitation', { p_account_organization_id: row.account_organization_id });
    if (prepareError || !prepared) {
      setError(prepareError?.message ?? 'The client invitation could not be prepared.');
      setInviting(false);
      return;
    }
    const invitation = prepared as { email: string; display_name?: string };
    const { error: inviteError } = await supabase.functions.invoke('invite-org', { body: { target_organization_id: row.account_organization_id, email: invitation.email, display_name: invitation.display_name?.trim() || row.account_name } });
    if (inviteError) setError(inviteError.message);
    else { setConfirmingInvite(false); setNotice(`Client login sent to ${invitation.email}. They will be the client's administrator in the client portal; when they set their password, 'Client logged in' ticks here. Service can start either way.`); await load(); await onChanged?.(); }
    setInviting(false);
  };

  const resendInvitation = async () => {
    if (!row) return;
    setResending(true); setError(null); setNotice(null);
    // resend-invite finds the one person at the client who has never signed in
    const { data, error: resendError } = await supabase.functions.invoke('resend-invite', { body: { organization_id: row.account_organization_id } });
    if (resendError) setError(resendError.message);
    else setNotice(`Invitation sent again to ${(data as { email?: string } | null)?.email ?? 'the client contact'}.`);
    setResending(false);
  };

  if (loading) return <section className="crm-onboarding-panel"><p className="crm-workspace-subtle"><Clock3 size={14} /> Loading activation evidence…</p></section>;

  if (!row) return <section className="crm-onboarding-panel is-ready"><div><CheckCircle2 size={17} /><div><strong>{activated || accountStatus === 'active' ? 'Account active' : 'No onboarding ledger open'}</strong><span>{activated || accountStatus === 'active' ? 'Activation is complete and this portfolio is operational.' : 'A prospect ledger will appear here when onboarding is required.'}</span></div></div>{notice && <p role="status">{notice}</p>}</section>;

  const blocked = row.readiness?.dimensions.filter((dimension) => dimension.status === 'blocked') ?? [];
  const invitationStatus = row.invitation_status ?? 'not_invited';
  const clientUserCount = row.client_user_count ?? 0;
  // invite-org seats the client's administrator when the invitation is sent; accept_quote also writes 'accepted' with nobody seated
  const seated = clientUserCount > 0;
  const clientAccepted = seated && invitationStatus === 'accepted';
  const canInvite = !seated && (row.readiness ? row.readiness.ready : row.has_primary_contact);
  const handoffStages = [
    { label: 'Our setup', complete: Boolean(row.readiness?.ready) },
    { label: 'Client login sent (optional)', complete: seated },
    { label: 'Client logged in (optional)', complete: clientAccepted },
    { label: 'Service started', complete: activated || accountStatus === 'active' },
  ];
  const seatWords = !seated
    ? (row.agreement_id ? 'No one at the client can log in yet. Optional — service can start without it.' : 'No service agreement yet — inviting the client creates one and gives their contact a login.')
    : clientAccepted
      ? `${clientUserCount} client user${clientUserCount === 1 ? '' : 's'} · the client has set their password and can see their places, visits and reports.`
      : 'Login sent · waiting for the client to set their password.';

  return <section className="crm-onboarding-panel" aria-label="Client activation">
    <header>
      <div><span>Activation</span><strong>{row.account_name}</strong><p>{row.current_stage} · {row.ledger_status} · {row.days_open} day{row.days_open === 1 ? '' : 's'} open{row.overdue ? ' · overdue' : ''}</p></div>
      <em>{row.readiness?.ready ? 'Ready' : `${blocked.length} blocker${blocked.length === 1 ? '' : 's'}`}</em>
    </header>
    {error && <p className="is-error" role="alert"><AlertTriangle size={14} />{error}</p>}
    {notice && <p className="is-success" role="status"><CheckCircle2 size={14} />{notice}</p>}
    <div className="crm-onboarding-stage-row">{stages.map((stage) => <span key={stage} className={stage === row.current_stage ? 'is-current' : stages.indexOf(stage) < stages.indexOf(row.current_stage) ? 'is-complete' : ''}>{stage}</span>)}</div>
    <div className="crm-handoff-timeline" aria-label="Client access lifecycle">{handoffStages.map((stage) => <div className={stage.complete ? 'is-complete' : ''} key={stage.label}><span>{stage.complete ? <CheckCircle2 size={13} /> : <Clock3 size={13} />}</span><small>{stage.label}</small></div>)}</div>
    {row.readiness && <div className="crm-onboarding-readiness">{row.readiness.dimensions.map((dimension) => <article key={dimension.key} className={dimension.status === 'ready' ? 'is-ready' : 'is-blocked'}><strong>{dimension.label}</strong><span>{dimension.detail}</span><small>{dimension.owner}</small></article>)}</div>}
    <div className="crm-onboarding-controls">
      <label><span><UserRound size={12} /> Workflow owner</span><select value={assignedTo} onChange={(event) => setAssignedTo(event.target.value)}>{assignees.map((assignee) => <option key={assignee.user_id} value={assignee.user_id}>{assignee.display_name} · {assignee.role.replace('_', ' ')}</option>)}</select></label>
      <label><span><CalendarClock size={12} /> Target live date</span><input type="date" value={targetDate} onChange={(event) => setTargetDate(event.target.value)} /></label>
      <label className="is-wide"><span>Stage note</span><textarea rows={2} value={stageNote} onChange={(event) => setStageNote(event.target.value)} /></label>
    </div>
    <footer>
      <span>{row.agreement_name ? `Agreement: ${row.agreement_name} · ${row.invitation_status?.replace('_', ' ') ?? 'not invited'}` : 'No operational agreement linked yet'}<br /><small>{seatWords}</small></span>
      <div>
        <button type="button" className="btn btn-sm btn-secondary" disabled={saving || !assignedTo || stageNote.trim().length < 3} onClick={() => void saveWorkflow(false)}>Save ownership</button>
        {nextStage && <button type="button" className="btn btn-sm btn-primary" disabled={saving || !assignedTo || stageNote.trim().length < 3} onClick={() => void saveWorkflow(true)}>Advance to {nextStage}<ChevronRight size={14} /></button>}
        {row.current_stage === 'review' && row.readiness?.ready && row.agreement_id && !confirming && <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => setConfirming(true)}><Rocket size={14} />Activate account</button>}
        {canInvite && !confirmingInvite && <button type="button" className="btn btn-sm btn-secondary" disabled={saving || inviting} onClick={() => setConfirmingInvite(true)}><MailPlus size={14} />Invite client</button>}
        {seated && !clientAccepted && <span className="crm-invitation-next-state">Waiting for the client to set their password</span>}
        {seated && !clientAccepted && <button type="button" className="btn btn-sm btn-secondary" disabled={resending} onClick={() => void resendInvitation()}><RefreshCw size={14} />{resending ? 'Sending' : 'Resend invitation'}</button>}
        {clientAccepted && !confirming && <span className="crm-invitation-next-state is-accepted">{row.readiness?.ready ? 'Client logged in · ready to start service' : 'Client logged in · finish our setup to start service'}</span>}
        {confirming && <><button type="button" className="btn btn-sm btn-secondary" disabled={saving} onClick={() => setConfirming(false)}>Cancel</button><button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => void activate()}>{saving ? 'Activating' : 'Confirm activation'}</button></>}
        {confirmingInvite && <><button type="button" className="btn btn-sm btn-secondary" disabled={inviting} onClick={() => setConfirmingInvite(false)}><X size={14} />Cancel</button><button type="button" className="btn btn-sm btn-primary" disabled={inviting} onClick={() => void inviteClient()}>{inviting ? 'Preparing invitation' : 'Confirm and invite'}</button></>}
      </div>
    </footer>
  </section>;
}
