import { useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, CheckCircle2, MapPin, Search, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import './CrmOrganizationDialog.css';

interface SiteCandidate {
  id: string;
  name: string;
  address: string | null;
  site_type: string | null;
  active: boolean;
  boundary_status: string;
  boundary_verification: string;
  match_reason: string;
}

interface SiteReceipt {
  id: string;
  name: string;
  boundary_status: string;
  boundary_verification: string;
}

export function CrmSiteDialog({ account, onClose, onCreated }: { account: { id: string; name: string }; onClose: () => void; onCreated: (site: SiteReceipt) => void }) {
  const [stage, setStage] = useState<'search' | 'create'>('search');
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [siteType, setSiteType] = useState('commercial_premises');
  const [candidates, setCandidates] = useState<SiteCandidate[]>([]);
  const [searched, setSearched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID());

  const searchSites = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true); setError(null); setSearched(false);
    const { data, error: searchError } = await supabase.rpc('find_crm_site_candidates', {
      p_account_organization_id: account.id,
      p_query: name.trim() || null,
      p_address: address.trim() || null,
    });
    if (searchError) setError(searchError.message);
    else { setCandidates((data as SiteCandidate[]) ?? []); setSearched(true); }
    setSaving(false);
  };

  const createSite = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true); setError(null);
    const { data, error: createError } = await supabase.rpc('create_crm_site', {
      p_client_request_id: requestId.current,
      p_account_organization_id: account.id,
      p_name: name.trim(),
      p_address: address.trim(),
      p_site_type: siteType,
    });
    const receipt = Array.isArray(data) ? data[0] : data;
    if (createError || !receipt) setError(createError?.message ?? 'Site creation receipt was not confirmed. Your entries remain available.');
    else { requestId.current = crypto.randomUUID(); onCreated(receipt as SiteReceipt); }
    setSaving(false);
  };

  return <div className="crm-org-backdrop"><section className="crm-org-dialog" role="dialog" aria-modal="true" aria-labelledby="crm-site-title">
    <header><div><span>Covered place spine</span><h2 id="crm-site-title">{stage === 'search' ? `Find a site for ${account.name}` : `Create site for ${account.name}`}</h2></div><button type="button" onClick={onClose} aria-label="Close site dialog"><X size={18} /></button></header>
    {error && <div className="crm-org-message" role="alert"><AlertTriangle size={16} />{error}</div>}
    {stage === 'search' ? <form className="crm-org-search" onSubmit={searchSites}>
      <p>Search the account before creating a covered place. Address matches preserve existing boundaries, safety history, and contract links.</p>
      <label><span>Site name</span><div><Search size={16} /><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Venue or operational place" /></div></label>
      <label><span>Street address</span><input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Full physical address" /></label>
      <button type="submit" disabled={saving || (name.trim().length < 2 && address.trim().length < 4)}>{saving ? 'Searching' : 'Search sites'}</button>
      {searched && <section className="crm-org-results"><header><strong>{candidates.length ? 'Possible site matches' : 'No matching sites found'}</strong><span>{candidates.length ? 'Review existing places before creating another.' : 'This account has no matching place record.'}</span></header>{candidates.map((candidate) => <article key={candidate.id}><MapPin size={19} /><div><strong>{candidate.name}</strong><span>{candidate.address ?? 'No address'} · {candidate.match_reason}</span></div><span className={candidate.boundary_verification === 'verified' ? 'is-managed' : ''}>{candidate.boundary_verification === 'verified' ? 'Boundary verified' : 'Boundary review needed'}</span></article>)}<button type="button" onClick={() => setStage('create')}>{candidates.length ? 'None of these - create site' : 'Create new site'}</button></section>}
    </form> : <form className="crm-org-form" onSubmit={createSite}>
      <p>The site will start with a provisional, unverified boundary. Operations must review its geofence before activation.</p>
      <label><span>Site name</span><input required maxLength={200} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label><span>Street address</span><input required maxLength={500} value={address} onChange={(event) => setAddress(event.target.value)} /></label>
      <label><span>Site type</span><select value={siteType} onChange={(event) => setSiteType(event.target.value)}><option value="commercial_premises">Commercial premises</option><option value="government_facility">Government facility</option><option value="education_facility">Education facility</option><option value="hospital">Hospital</option><option value="industrial_site">Industrial site</option><option value="residential_complex">Residential complex</option><option value="parking_area">Parking area</option><option value="public_space">Public space</option><option value="other">Other</option></select></label>
      <footer><button type="button" onClick={() => setStage('search')}>Back to matches</button><button type="submit" disabled={saving || !name.trim() || address.trim().length < 4}>{saving ? 'Creating' : 'Create site for boundary review'}</button></footer>
    </form>}
  </section></div>;
}