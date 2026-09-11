import { useEffect, useState, type FormEvent } from 'react';
import { BriefcaseBusiness, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import type { OperatingOrganization } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './StaffBranchAccessPanel.css';

interface BranchAuthorisation {
  id: string;
  branch_organization_id: string;
  branch_name: string;
  role_at_branch: 'officer' | 'supervisor' | 'branch_manager';
  module_access: string[];
  can_be_rostered: boolean;
  status: 'active' | 'suspended' | 'ended';
  starts_on: string | null;
  ends_on: string | null;
  updated_at: string;
}

interface ModuleCatalogEntry { module_key: string; display_name?: string | null; }
type Action = 'grant' | 'update' | 'suspend' | 'end';

export function StaffBranchAccessPanel({ userId, branches, onChanged }: { userId: string; branches: OperatingOrganization[]; onChanged: () => Promise<void> }) {
  const [authorisations, setAuthorisations] = useState<BranchAuthorisation[]>([]);
  const [moduleCatalog, setModuleCatalog] = useState<ModuleCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [selected, setSelected] = useState<BranchAuthorisation | null>(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ branchOrganizationId: '', roleAtBranch: 'officer' as BranchAuthorisation['role_at_branch'], moduleAccess: [] as string[], canBeRostered: true, startsOn: '', endsOn: '' });

  const load = async () => {
    setLoading(true); setError(null);
    const [{ data, error: loadError }, { data: moduleData, error: moduleError }] = await Promise.all([
      supabase.rpc('get_staff_branch_authorisations', { p_user_id: userId }),
      supabase.from('module_catalog').select('module_key').eq('active', true).order('module_key'),
    ]);
    if (loadError) setError(loadError.message); else setAuthorisations((data as BranchAuthorisation[]) ?? []);
    if (moduleError) setError(moduleError.message); else setModuleCatalog((moduleData as ModuleCatalogEntry[]) ?? []);
    setLoading(false);
  };

  useEffect(() => { void load(); }, [userId]);

  const openAction = (nextAction: Action, current?: BranchAuthorisation) => {
    setAction(nextAction); setSelected(current ?? null); setReason('');
    setForm(current ? { branchOrganizationId: current.branch_organization_id, roleAtBranch: current.role_at_branch, moduleAccess: current.module_access, canBeRostered: current.can_be_rostered, startsOn: current.starts_on ?? '', endsOn: current.ends_on ?? '' } : { branchOrganizationId: branches[0]?.organizationId ?? '', roleAtBranch: 'officer', moduleAccess: [], canBeRostered: true, startsOn: '', endsOn: '' });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!action || !form.branchOrganizationId || !reason.trim()) return;
    setSaving(true); setError(null);
    const { error: saveError } = await supabase.rpc('manage_staff_branch_authorisation', {
      p_action: action, p_user_id: userId, p_branch_organization_id: form.branchOrganizationId,
      p_expected_updated_at: selected?.updated_at ?? null, p_role_at_branch: form.roleAtBranch,
      p_module_access: form.moduleAccess, p_can_be_rostered: form.canBeRostered,
      p_starts_on: form.startsOn || null, p_ends_on: form.endsOn || null, p_reason: reason.trim(),
    });
    if (saveError) setError(saveError.message);
    else { setAction(null); setSelected(null); await load(); await onChanged(); }
    setSaving(false);
  };

  return <section className="staff-branch-access"><header><div><BriefcaseBusiness size={18} /><div><strong>Branch authorisations</strong><span>Employment remains corporate; these assignments control delivery access.</span></div></div><button type="button" onClick={() => void load()} title="Refresh branch authorisations" disabled={loading}><RefreshCw size={15} className={loading ? 'is-spinning' : ''} /></button></header>{error && <p role="alert" className="staff-branch-access-error">{error}</p>}<div className="staff-branch-access-list">{loading ? <span>Loading branch authorisations...</span> : authorisations.length === 0 ? <span>No branch authorisations.</span> : authorisations.map((authorisation) => <article key={authorisation.id}><div><strong>{authorisation.branch_name}</strong><span>{authorisation.role_at_branch.replaceAll('_', ' ')} · {authorisation.can_be_rostered ? 'Roster eligible' : 'Not roster eligible'}</span><small>{authorisation.module_access.length ? authorisation.module_access.join(', ').replaceAll('_', ' ') : 'No direct modules'} · {authorisation.status}</small></div><div className="staff-branch-access-actions"><button type="button" onClick={() => openAction('update', authorisation)}>Edit</button>{authorisation.status === 'active' && <button type="button" onClick={() => openAction('suspend', authorisation)}>Suspend</button>}{authorisation.status !== 'ended' && <button type="button" onClick={() => openAction('end', authorisation)}>End</button>}</div></article>)}</div><button type="button" className="staff-branch-access-add" onClick={() => openAction('grant')} disabled={branches.length === 0}><Plus size={15} /> Grant branch access</button>{action && <form className="staff-branch-access-form" onSubmit={submit}><h3>{action === 'grant' ? 'Grant branch access' : action === 'update' ? `Edit ${selected?.branch_name}` : `${action === 'end' ? 'End' : 'Suspend'} ${selected?.branch_name}`}</h3>{['grant', 'update'].includes(action) && <><label><span>Delivery branch</span><select required value={form.branchOrganizationId} disabled={action === 'update'} onChange={(event) => setForm({ ...form, branchOrganizationId: event.target.value })}>{branches.map((branch) => <option key={branch.organizationId} value={branch.organizationId}>{branch.organizationName}</option>)}</select></label><div className="staff-branch-access-grid"><label><span>Role at branch</span><select value={form.roleAtBranch} onChange={(event) => setForm({ ...form, roleAtBranch: event.target.value as BranchAuthorisation['role_at_branch'] })}><option value="officer">Officer</option><option value="supervisor">Supervisor</option><option value="branch_manager">Branch manager</option></select></label><label><span>Starts on</span><input type="date" value={form.startsOn} onChange={(event) => setForm({ ...form, startsOn: event.target.value })} /></label><label><span>Ends on</span><input type="date" min={form.startsOn || undefined} value={form.endsOn} onChange={(event) => setForm({ ...form, endsOn: event.target.value })} /></label></div><fieldset><legend>Modules at this branch</legend><div className="staff-branch-access-modules">{moduleCatalog.map((module) => <label key={module.module_key}><input type="checkbox" checked={form.moduleAccess.includes(module.module_key)} onChange={(event) => setForm({ ...form, moduleAccess: event.target.checked ? [...form.moduleAccess, module.module_key] : form.moduleAccess.filter((key) => key !== module.module_key) })} /><span>{module.display_name ?? module.module_key.replaceAll('_', ' ')}</span></label>)}</div></fieldset><label className="staff-branch-access-roster"><input type="checkbox" checked={form.canBeRostered} onChange={(event) => setForm({ ...form, canBeRostered: event.target.checked })} /><span>Can be rostered at this branch</span></label></>}<label><span>Reason for change</span><textarea required rows={3} value={reason} onChange={(event) => setReason(event.target.value)} /></label><footer><button type="button" onClick={() => setAction(null)}>Cancel</button><button type="submit" disabled={saving || !reason.trim()}>{saving ? 'Saving' : action === 'grant' ? 'Grant access' : action === 'update' ? 'Save access' : action === 'suspend' ? 'Suspend access' : 'End access'}</button></footer></form>}</section>;
}
