import { useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, BadgeCheck, BriefcaseBusiness, Car, CheckCircle2, KeyRound, Mail, ShieldCheck, UserRoundCog, X } from 'lucide-react';
import type { AppRole, OperatingOrganization } from '../context/AuthContext';
import { getAssignableRoles, IDENTITY_ROLE_LABEL } from '../lib/identityRoles';
import { supabase } from '../lib/supabase';
import { edgeFunctionErrorMessage } from '../lib/edgeFunctionError';
import { StaffBranchAccessPanel } from './StaffBranchAccessPanel';
import './UserIdentityWorkspace.css';

export interface ManagedUserIdentity {
  id: string;
  display_name: string | null;
  role: AppRole;
  email: string | null;
  phone: string | null;
  updated_at: string;
  deactivated_at: string | null;
}

export interface UserAccessPreset { id: string; key: string; name: string; role: string | null; }
export interface UserPresetAssignment { id: string; user_id: string; preset_id: string; status: string; }
export interface UserSpineReadiness { user_id: string; identity_status: string; employment_status: string; access_status: string; credential_status: string; work_status: string; blockers: string[]; next_action: string; }

export function UserIdentityWorkspace({ user, callerRole, presets, assignment, readiness, branches, signInState, onClose, onChanged }: { user: ManagedUserIdentity; callerRole: AppRole; presets: UserAccessPreset[]; assignment: UserPresetAssignment | null; readiness: UserSpineReadiness | null; branches: OperatingOrganization[]; signInState?: 'no_login' | 'invited' | 'signed_in'; onClose: () => void; onChanged: () => Promise<void> }) {
  const [form, setForm] = useState({ displayName: user.display_name ?? '', phone: user.phone ?? '', role: user.role });
  const [presetId, setPresetId] = useState(assignment?.preset_id ?? '');
  const [identityReason, setIdentityReason] = useState('');
  const [accessReason, setAccessReason] = useState('');
  const [email, setEmail] = useState(user.email ?? '');
  const [emailReason, setEmailReason] = useState('');
  const [provisionExistingStaff, setProvisionExistingStaff] = useState(signInState === 'no_login' && user.role === 'officer');
  const [saving, setSaving] = useState<'identity' | 'access' | 'email' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState(user.updated_at);
  const [activeAssignment, setActiveAssignment] = useState(assignment);
  const assignableRoles = getAssignableRoles(callerRole);
  const adminTier = ['grand_master', 'master', 'admin', 'admin_officer'].includes(form.role);

  const saveIdentity = async (event: FormEvent) => {
    event.preventDefault(); setSaving('identity'); setError(null); setNotice(null);
    const { data, error: saveError } = await supabase.rpc('manage_user_identity_access', { p_user_id: user.id, p_expected_updated_at: expectedUpdatedAt, p_action: 'update_identity', p_display_name: form.displayName.trim(), p_phone: form.phone.trim() || null, p_role: form.role, p_preset_id: null, p_assignment_id: null, p_grant_id: null, p_reason: identityReason.trim() });
    if (saveError) setError(saveError.message); else { const receipt = data as { updated_at?: string } | null; if (receipt?.updated_at) setExpectedUpdatedAt(receipt.updated_at); setNotice('Identity and role updated with audit history.'); setIdentityReason(''); await onChanged(); }
    setSaving(null);
  };

  /** The sign-in identity lives in auth.users, so this goes through the governed edge function, not the table. */
  const saveEmail = async (event: FormEvent) => {
    event.preventDefault(); setSaving('email'); setError(null); setNotice(null);
    const { data, error: saveError } = await supabase.functions.invoke('update-user-email', { body: { user_id: user.id, email: email.trim(), reason: emailReason.trim(), provision_existing_staff: provisionExistingStaff } });
    const receipt = data as { error?: string; email?: string; pending_email?: string; requires_confirmation?: boolean; invitation_resent?: boolean; existing_staff_preserved?: boolean } | null;
    if (saveError || receipt?.error) setError(receipt?.error ?? (saveError ? await edgeFunctionErrorMessage(saveError, 'The email address could not be changed.') : 'The email address could not be changed.'));
    else if (receipt?.existing_staff_preserved) { setNotice(`Invitation sent to ${receipt.email}. The existing staff record, credentials, skills and history were preserved. Work readiness still needs confirmation in HR.`); setEmailReason(''); setProvisionExistingStaff(false); await onChanged(); }
    else if (receipt?.requires_confirmation) { setNotice(`${user.display_name ?? 'This person'} has signed in before, so ${receipt.pending_email} has to be confirmed before it becomes their sign-in address. Until then they keep signing in with ${receipt.email}. Their profile, role and history are unchanged.`); setEmailReason(''); await onChanged(); }
    else { setNotice(receipt?.invitation_resent ? `Email corrected to ${receipt.email}. Their unclaimed invitation was re-sent to the new address.` : `Email corrected to ${receipt?.email ?? email.trim()}. They sign in with it from now on.`); setEmailReason(''); await onChanged(); }
    setSaving(null);
  };

  const saveAccess = async (event: FormEvent) => {
    event.preventDefault(); setSaving('access'); setError(null); setNotice(null);
    const action = presetId ? 'set_preset' : 'clear_preset';
    const { data, error: saveError } = await supabase.rpc('manage_user_identity_access', { p_user_id: user.id, p_expected_updated_at: expectedUpdatedAt, p_action: action, p_display_name: form.displayName.trim(), p_phone: form.phone.trim() || null, p_role: form.role, p_preset_id: presetId || null, p_assignment_id: activeAssignment?.id ?? null, p_grant_id: null, p_reason: accessReason.trim() });
    if (saveError) setError(saveError.message); else { const receipt = data as { updated_at?: string; assignment_id?: string | null } | null; if (receipt?.updated_at) setExpectedUpdatedAt(receipt.updated_at); setActiveAssignment(receipt?.assignment_id ? { id: receipt.assignment_id, user_id: user.id, preset_id: presetId, status: 'active' } : null); setNotice(presetId ? 'Access preset assigned.' : 'Access preset ended.'); setAccessReason(''); await onChanged(); }
    setSaving(null);
  };

  return <div className="user-spine-backdrop"><section className="user-spine-dialog" role="dialog" aria-modal="true" aria-labelledby="user-spine-title">
    <header><div><span>User spine</span><h2 id="user-spine-title">{user.display_name ?? user.email ?? 'User account'}</h2><p>{user.email ?? 'No email recorded'} · {user.deactivated_at ? 'Deactivated' : 'Active'}</p></div><button type="button" onClick={onClose} aria-label="Close user workspace"><X size={18} /></button></header>
    {error && <div className="user-spine-message is-error" role="alert"><AlertTriangle size={16} />{error}</div>}
    {notice && <div className="user-spine-message is-success" role="status"><CheckCircle2 size={16} />{notice}</div>}
    <section className="user-spine-readiness"><div><strong>{readiness?.next_action ?? 'Review user setup'}</strong><span>{readiness?.blockers.length ? `${readiness.blockers.length} setup steps remain` : 'No current blockers'}</span></div><dl><div><dt>Identity</dt><dd>{readiness?.identity_status ?? 'unknown'}</dd></div><div><dt>Employment</dt><dd>{readiness?.employment_status ?? 'unknown'}</dd></div><div><dt>Access</dt><dd>{readiness?.access_status ?? 'unknown'}</dd></div><div><dt>Credential</dt><dd>{readiness?.credential_status ?? 'unknown'}</dd></div><div><dt>Work</dt><dd>{readiness?.work_status ?? 'unknown'}</dd></div></dl>{readiness?.blockers.length ? <ul>{readiness.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul> : null}</section>
    <div className="user-spine-columns">
      <form onSubmit={saveIdentity}><div className="user-spine-section-title"><UserRoundCog size={18} /><div><strong>Identity and role</strong><span>Canonical name, contact, and application authority.</span></div></div><label><span>Display name</span><input required value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} /></label><label><span>Phone</span><input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label><label><span>Role</span><select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as AppRole })}>{assignableRoles.map((role) => <option value={role} key={role}>{IDENTITY_ROLE_LABEL[role]}</option>)}</select></label><label><span>Reason for change</span><textarea required rows={3} value={identityReason} onChange={(event) => setIdentityReason(event.target.value)} placeholder="Why is this identity or role changing?" /></label><button type="submit" disabled={saving !== null || !form.displayName.trim() || !identityReason.trim()}>{saving === 'identity' ? 'Saving' : 'Save identity'}</button></form>
      <form onSubmit={saveAccess}><div className="user-spine-section-title"><KeyRound size={18} /><div><strong>Access preset</strong><span>One named administration access bundle at this organization.</span></div></div>{adminTier ? <><label><span>Preset</span><select value={presetId} onChange={(event) => setPresetId(event.target.value)}><option value="">No active preset</option>{presets.map((preset) => <option value={preset.id} key={preset.id}>{preset.name}</option>)}</select></label><label><span>Reason for access change</span><textarea required rows={3} value={accessReason} onChange={(event) => setAccessReason(event.target.value)} placeholder="Role responsibilities or approval reference" /></label><button type="submit" disabled={saving !== null || !accessReason.trim() || (!presetId && !assignment)}>{saving === 'access' ? 'Saving' : presetId ? 'Assign preset' : 'End preset'}</button></> : <div className="user-spine-not-applicable"><ShieldCheck size={22} /><strong>Role-scoped access</strong><span>Field and client roles use their role, branch authorization, and module scope rather than an administration preset.</span></div>}
      </form>
    </div>
    <form className="user-spine-email" onSubmit={saveEmail}>
      <div className="user-spine-section-title"><Mail size={18} /><div><strong>Email and sign-in</strong><span>The address this person signs in with, and where their invitation is sent.</span></div></div>
      <div className="user-spine-email-grid"><label><span>Email address</span><input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label><label><span>Reason for change</span><input required value={emailReason} onChange={(event) => setEmailReason(event.target.value)} placeholder="Corrected typo, name change, new work address" /></label></div>
      {user.role === 'officer' && <label className="user-spine-checkbox"><input type="checkbox" checked={provisionExistingStaff} onChange={(event) => setProvisionExistingStaff(event.target.checked)} /><span>Provision or retry an unclaimed login invitation using this existing staff record. Preserve its credentials, skills and history; do not create a new staff record. Already claimed logins are refused.</span></label>}
      <button type="submit" disabled={saving !== null || !email.trim() || !emailReason.trim() || (!provisionExistingStaff && email.trim().toLowerCase() === (user.email ?? '').toLowerCase())}>{saving === 'email' ? 'Saving' : provisionExistingStaff ? 'Send staff invitation' : 'Change email'}</button>
      <small>If they have never signed in, the address is corrected and their invitation re-sent to it. If they have signed in before, the new address must be confirmed before it replaces the old one — their profile, role and history stay as they are.</small>
    </form>
    <RestrictedAccessSection key={`person-${user.id}`} userId={user.id} kind="person" />
    <RestrictedAccessSection key={`vehicle-${user.id}`} userId={user.id} kind="vehicle" />
    <StaffBranchAccessPanel userId={user.id} branches={branches} onChanged={onChanged} />
    <footer><span><BriefcaseBusiness size={14} />Employment, credentials, and work readiness remain governed in People &amp; HR.</span><span><BadgeCheck size={14} />Every change requires a reason and is retained in the identity audit trail.</span></footer>
  </section></div>;
}

interface RestrictedAccess {
  direct: boolean; via_preset: boolean; via_role: boolean; via_grant?: boolean; active?: boolean;
  /** NZTA s241 readiness, returned for vehicle-owner access only. */
  training_current?: boolean; training_expires_on?: string | null;
  confidentiality_current?: boolean; confidentiality_expires_on?: string | null;
}

const formatNzDate = (value: string) => new Date(`${value}T00:00:00`).toLocaleDateString('en-NZ');

const readinessText = (current: boolean | undefined, expires: string | null | undefined) =>
  current && expires ? `Current until ${formatNzDate(expires)}` : expires ? `Expired ${formatNzDate(expires)}` : 'Not recorded';

export function RestrictedAccessSection({ userId, kind }: { userId: string; kind: 'person' | 'vehicle' }) {
  const [access, setAccess] = useState<RestrictedAccess | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const person = kind === 'person';
  const readRpc = person ? 'get_person_search_access' : 'get_vehicle_owner_access';
  const writeRpc = person ? 'set_person_search_access' : 'set_vehicle_owner_access';

  // ATLAS CALLS: get_vehicle_owner_access, get_person_search_access
  useEffect(() => {
    let cancelled = false;
    setAccess(null); setError(null); setNotice(null); setReason('');
    const load = async () => {
      try {
        const { data, error: loadError } = await supabase.rpc(readRpc, { p_user_id: userId });
        if (loadError) throw new Error(loadError.message);
        if (!data || typeof data.direct !== 'boolean') throw new Error('Invalid access response');
        if (cancelled) return;
        const row = data as RestrictedAccess;
        setAccess(row); setEnabled(row.direct);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Could not load access. Retry or contact your administrator.');
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [userId, readRpc, attempt]);

  const save = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(null); setNotice(null);
    try {
      // ATLAS CALLS: set_vehicle_owner_access, set_person_search_access
      const { data, error: saveError } = await supabase.rpc(writeRpc, { p_user_id: userId, p_enabled: enabled, p_reason: reason.trim() });
      if (saveError) throw new Error(saveError.message);
      if (!data || typeof data.direct !== 'boolean') throw new Error('Invalid access response; refresh to confirm the saved state');
      const row = data as RestrictedAccess;
      setAccess(row); setEnabled(row.direct); setReason('');
      setNotice(row.direct ? 'Direct authorization enabled.' : row.via_role || row.via_preset || row.via_grant
        ? 'Direct authorization removed. Access remains through their role, preset or inherited grant.'
        : 'Authorization removed.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save access. Check your authorization and retry.');
    } finally { setSaving(false); }
  };

  const nztaReady = person || (access?.training_current === true && access?.confidentiality_current === true);
  const blockedGrant = !person && enabled && access !== null && !access.direct && !nztaReady;
  const inherited = access?.via_role ? 'Included with their operations role.' : access?.via_preset ? 'Also granted through their access preset.' : access?.via_grant ? 'Also granted through an inherited organization grant.' : null;
  return <form className="user-spine-email" onSubmit={(event) => void save(event)} aria-label={person ? 'Person search authorization' : 'Restricted information access'}>
    <div className="user-spine-section-title">{person ? <UserRoundCog size={18} /> : <Car size={18} />}<div><strong>{person ? 'Person search authorization' : 'Restricted information'}</strong><span>{person ? 'Read-only checks for operational duties. Separate from NZTA authorization.' : 'Vehicle owner identity beyond their role.'}</span></div></div>
    {error && <div className="user-spine-message is-error" role="alert"><AlertTriangle size={16} />{error}</div>}
    {notice && <div className="user-spine-message is-success" role="status"><CheckCircle2 size={16} />{notice}</div>}
    {access === null ? error ? <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry access check</button> : <small role="status">Loading access…</small> : <>
      <label className="user-spine-checkbox"><input type="checkbox" checked={enabled} disabled={saving || (access.active === false && !enabled)} onChange={(event) => setEnabled(event.target.checked)} /> <span>{person ? 'Person search — view names, trespass and warning notices, permits and operational links' : 'Vehicle owner details — view and record vehicle owners, including NZTA-restricted register details'}</span></label>
      {access.active === false && <small>This account is inactive. Person search is unavailable.</small>}
      {inherited && <small>{inherited}</small>}
      {!person && <dl className="user-spine-readiness" aria-label="NZTA register readiness">
        <div><dt>NZTA register training</dt><dd className={access.training_current ? 'is-current' : 'is-missing'}>{readinessText(access.training_current, access.training_expires_on)}</dd></div>
        <div><dt>Confidentiality acceptance</dt><dd className={access.confidentiality_current ? 'is-current' : 'is-missing'}>{readinessText(access.confidentiality_current, access.confidentiality_expires_on)}</dd></div>
      </dl>}
      {blockedGrant && <div className="user-spine-message is-error" role="alert"><AlertTriangle size={16} />Record current NZTA register training and a confidentiality acceptance under Investigations &amp; Evidence → NZTA register (s241) → People &amp; training → “Staff without access” before granting this access.</div>}
      {!person && !nztaReady && (access.direct || access.via_role || access.via_preset || access.via_grant) && <small>This person already has access but is not NZTA-ready. Their reveals are still logged, flagged in the access log, and counted in the annual report.</small>}
      <label><span>Reason for change</span><input required value={reason} onChange={(event) => setReason(event.target.value)} placeholder="For example: investigations officer, approved by operations manager" /></label>
      <button type="submit" disabled={saving || !reason.trim() || enabled === access.direct || blockedGrant}>{saving ? 'Saving' : person ? 'Save person search access' : 'Save restricted access'}</button>
      <small>{person ? 'Field officers do not receive personal addresses or contact details. Only existing authorized organisations can be searched. Removing this checkbox does not remove inherited access.' : 'NZTA register information may only be used for the lawful purpose it was obtained for. Personal addresses and contact details remain with Admin, Admin officer and Master roles.'} Every change is audit-logged.</small>
    </>}
  </form>;
}
