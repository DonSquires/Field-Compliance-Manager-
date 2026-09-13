import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Banknote, CheckCircle2, CircleAlert, Landmark, LockKeyhole, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './FinanceConnectionWizard.css';
import './FinanceConnectionWizardStates.css';
import './FinanceConnectionPersonalTest.css';

type Provider = 'ird' | 'bank';
type BankAccount = { id: string; account_name: string; account_number: string; bank_name: string | null };
type Connection = { provider_type: Provider; connection_mode: string; status: string; bank_account_id: string | null; setup_summary: { next_action?: string } | null };
type TaxIdentity = { configured?: boolean; ird_last_four?: string; gst_registered?: boolean; gst_basis?: string; gst_filing_frequency?: string; tax_agent_name?: string | null; setup_status?: string };

const steps = ['Choose service', 'Choose safe method', 'Confirm and continue'];

export function FinanceConnectionWizard() {
  const { profile } = useAuth();
  const [step, setStep] = useState(0);
  const [provider, setProvider] = useState<Provider>('ird');
  const [method, setMethod] = useState('oauth');
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [bankAccountId, setBankAccountId] = useState('');
  const [consent, setConsent] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [taxIdentity, setTaxIdentity] = useState<TaxIdentity | null>(null);
  const [irdNumber, setIrdNumber] = useState('');
  const [gstRegistered, setGstRegistered] = useState(false);
  const [gstBasis, setGstBasis] = useState('payments');
  const [gstFrequency, setGstFrequency] = useState('two_monthly');
  const [taxAgentName, setTaxAgentName] = useState('');
  const [personalCheck, setPersonalCheck] = useState<{ account_count?: number; verified?: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profile?.organizationId) {
      setError('Organisation access could not be confirmed. Finance connection setup is unavailable.');
      setLoading(false);
      return;
    }
    setLoading(true);
    const [accountResponse, connectionResponse, taxResponse] = await Promise.all([
      supabase.from('bank_accounts').select('id,account_name,account_number,bank_name').eq('organization_id', profile.organizationId).eq('is_active', true).ilike('bank_name', '%ANZ%').order('account_name'),
      supabase.from('finance_external_connection_requests').select('provider_type,connection_mode,status,bank_account_id,setup_summary').eq('organization_id', profile.organizationId).order('created_at', { ascending: false }),
      supabase.rpc('get_finance_tax_identity_summary'),
    ]);
    if (accountResponse.error || connectionResponse.error || taxResponse.error) setError(accountResponse.error?.message ?? connectionResponse.error?.message ?? taxResponse.error?.message ?? 'Connection setup could not be loaded.');
    else { setBankAccounts((accountResponse.data as BankAccount[]) ?? []); setConnections((connectionResponse.data as Connection[]) ?? []); setTaxIdentity((taxResponse.data as TaxIdentity | null) ?? null); }
    setLoading(false);
  }, [profile?.organizationId]);

  useEffect(() => { void load(); }, [load]);

  const changeProvider = (next: Provider) => {
    setProvider(next);
    setMethod(next === 'ird' ? 'oauth' : 'approved_provider');
    setStep(1);
    setNotice(null);
    setError(null);
  };

  const requestConnection = async () => {
    setSaving(true); setNotice(null); setError(null);
    if (provider === 'ird') {
      const { data, error: taxError } = await supabase.rpc('save_finance_tax_identity', { p_ird_number: irdNumber, p_gst_registered: gstRegistered, p_gst_basis: gstBasis, p_gst_filing_frequency: gstFrequency, p_tax_agent_name: taxAgentName || null, p_tax_agent_contact: null });
      if (taxError) setError(taxError.message);
      else { setTaxIdentity(data as TaxIdentity); setNotice('IRD details saved. Accountant or provider review is still required; no IRD submission was made.'); setStep(0); await load(); }
      setSaving(false);
      return;
    }
    const { data: requestData, error: requestError } = provider === 'bank'
      ? await supabase.rpc('request_anz_bank_connection', { p_bank_account_id: bankAccountId, p_connection_mode: method, p_requested_scopes: ['account_transactions', 'balances', 'payment_matches'], p_consent_confirmed: consent })
      : await supabase.rpc('request_finance_external_connection', { p_provider_type: provider, p_connection_mode: method, p_requested_scopes: ['gst_status', 'filing_status', 'submission_receipts'], p_bank_account_id: null, p_consent_confirmed: consent });
    if (requestError) setError(requestError.message);
    else if (provider === 'bank' && requestData?.id) {
      const { data: authData, error: authError } = await supabase.functions.invoke('finance-akahu-start', { body: { request_id: requestData.id } });
      if (authError || !authData?.authorization_url) setError(authError?.message ?? authData?.error ?? 'ANZ authorisation is not configured yet.');
      else window.location.assign(authData.authorization_url);
    } else { setNotice('Bob prepared the connection request. The next step opens with the approved provider; no password or token was stored here.'); setStep(0); setConsent(false); await load(); }
    setSaving(false);
  };

  const runPersonalAkahuCheck = async () => {
    setSaving(true); setError(null); setNotice(null);
    const { data, error: checkError } = await supabase.functions.invoke('finance-akahu-personal-check', { body: {} });
    if (checkError) setError(checkError.message);
    else if (data?.error) setError(data.error);
    else { setPersonalCheck(data); setNotice(`Personal Akahu test verified ${data.account_count ?? 0} account(s). No transactions were imported.`); }
    setSaving(false);
  };

  const connectedLabel = (connection: Connection) => connection.provider_type === 'ird' && connection.status === 'awaiting_authorisation' ? 'Provider setup required' : connection.status === 'connected' ? 'Connected' : connection.status === 'awaiting_authorisation' ? 'Waiting for authorisation' : connection.status;
  if (loading) return <section className="finance-connection-wizard" aria-busy="true"><p>Loading connection setup...</p></section>;

  return <section className="finance-connection-wizard" aria-labelledby="finance-connection-heading">
    <header><div><p className="finance-connection-eyebrow">Bob can prepare this</p><h2 id="finance-connection-heading">Connect IRD or your bank</h2><p>Bob can organise the setup and check what data is needed. You will authorise the provider in its secure window.</p></div><LockKeyhole size={20} /></header>
    <div className="finance-connection-safety"><ShieldCheck size={15} /><span>We never ask for online-banking passwords, IRD passwords, MFA codes, or access tokens in this app.</span></div>
    {error && <p className="finance-connection-error" role="alert"><CircleAlert size={14} />{error}</p>}
    {notice && <p className="finance-connection-notice" role="status"><CheckCircle2 size={14} />{notice}</p>}
    <div className="finance-connection-steps" aria-label="Connection setup progress">{steps.map((label, index) => <span className={index <= step ? 'is-active' : ''} key={label}><b>{index + 1}</b>{label}</span>)}</div>
    {step === 0 && <div className="finance-connection-options"><button type="button" className={provider === 'ird' ? 'is-selected' : ''} onClick={() => changeProvider('ird')}><Landmark size={18} /><strong>IRD</strong><small>GST and filing receipts</small></button><button type="button" className={provider === 'bank' ? 'is-selected' : ''} onClick={() => changeProvider('bank')}><Banknote size={18} /><strong>ANZ bank account</strong><small>Balances and payment matching</small></button></div>}
    {step === 1 && <div className="finance-connection-form"><h3>{provider === 'ird' ? 'Set up organisation IRD details' : 'Safe connection method'}</h3>{provider === 'ird' ? <><p>Your IRD number is restricted organisation tax information. It does not sign in to myIR or submit anything.</p><label><span>Organisation IRD number</span><input inputMode="numeric" autoComplete="off" value={irdNumber} onChange={(event) => setIrdNumber(event.target.value)} placeholder="8 or 9 digits" /></label><label className="finance-connection-consent"><input type="checkbox" checked={gstRegistered} onChange={(event) => setGstRegistered(event.target.checked)} /><span>Organisation is GST registered</span></label>{gstRegistered && <><label><span>GST accounting basis</span><select value={gstBasis} onChange={(event) => setGstBasis(event.target.value)}><option value="payments">Payments basis</option><option value="invoice">Invoice basis</option><option value="hybrid">Hybrid basis</option></select></label><label><span>GST filing frequency</span><select value={gstFrequency} onChange={(event) => setGstFrequency(event.target.value)}><option value="monthly">Monthly</option><option value="two_monthly">Two-monthly</option><option value="six_monthly">Six-monthly</option></select></label></>}<label><span>Accountant or tax agent (optional)</span><input value={taxAgentName} onChange={(event) => setTaxAgentName(event.target.value)} placeholder="Name or firm" /></label><button type="button" className="btn btn-primary" disabled={!irdNumber.replace(/\D/g, '').length} onClick={() => setStep(2)}>Review details <ArrowRight size={15} /></button></> : <><p>ANZ access will use an approved ANZ/Open Banking provider. Bob will not see or store your login.</p><label><span>ANZ account to connect</span><select value={bankAccountId} onChange={(event) => setBankAccountId(event.target.value)}><option value="">Select an ANZ account</option>{bankAccounts.map((account) => <option key={account.id} value={account.id}>{account.account_name} {account.account_number.slice(-4) ? `ending ${account.account_number.slice(-4)}` : ''}</option>)}</select></label><button type="button" className="btn btn-primary" disabled={!bankAccountId} onClick={() => setStep(2)}>Continue <ArrowRight size={15} /></button></>}</div>}
    {step === 2 && provider === 'ird' && <div className="finance-connection-form"><h3>Review before saving IRD details</h3><div className="finance-connection-summary"><strong>IRD number ending {irdNumber.replace(/\D/g, '').slice(-4)}</strong><span>{gstRegistered ? `GST registered · ${gstFrequency.replace('_', ' ')}` : 'GST not marked as registered'}</span><span>{taxAgentName ? `Review with ${taxAgentName}` : 'Accountant/provider review still required'}</span></div><button type="button" className="btn btn-primary" disabled={saving} onClick={() => void requestConnection()}>{saving ? 'Saving...' : 'Save IRD details'} <ArrowRight size={15} /></button></div>}
    {step === 2 && provider === 'bank' && <div className="finance-connection-form"><h3>Confirm before Bob prepares it</h3><label className="finance-connection-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /><span>I understand this will request access only for the selected finance data, and I will complete authorisation with the provider.</span></label><div className="finance-connection-summary"><strong>ANZ bank account</strong><span>Secure provider authorisation window</span><span>Balances, transactions, and payment matching</span></div><button type="button" className="btn btn-primary" disabled={!consent || saving} onClick={() => void requestConnection()}>{saving ? 'Preparing...' : 'Prepare secure connection'} <ArrowRight size={15} /></button></div>}
    {connections.length > 0 && <div className="finance-connection-existing"><strong>Existing setup</strong>{connections.slice(0, 4).map((connection, index) => <div key={`${connection.provider_type}-${connection.bank_account_id ?? index}`}><span>{connection.provider_type === 'ird' ? 'IRD' : 'Bank account'}</span><b>{connectedLabel(connection)}</b></div>)}</div>}
    {profile?.role === 'grand_master' && <div className="finance-connection-personal-test"><div><strong>Grandmaster personal test</strong><small>Tests the Personal App only. It does not connect customer accounts or import transactions.</small></div><button type="button" className="btn btn-secondary" disabled={saving} onClick={() => void runPersonalAkahuCheck()}>{saving ? 'Checking...' : 'Test personal Akahu'}</button>{personalCheck?.verified && <span>Verified {personalCheck.account_count ?? 0} account(s)</span>}</div>}
  </section>;
}
