import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Banknote, CheckCircle2, CircleAlert, Landmark, LockKeyhole, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './FinanceConnectionWizard.css';

type Provider = 'ird' | 'bank';
type BankAccount = { id: string; account_name: string; account_number: string; bank_name: string | null };
type Connection = { provider_type: Provider; connection_mode: string; status: string; bank_account_id: string | null; setup_summary: { next_action?: string } | null };

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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profile?.organizationId) return;
    setLoading(true);
    const [accountResponse, connectionResponse] = await Promise.all([
      supabase.from('bank_accounts').select('id,account_name,account_number,bank_name').eq('organization_id', profile.organizationId).eq('is_active', true).order('account_name'),
      supabase.from('finance_external_connection_requests').select('provider_type,connection_mode,status,bank_account_id,setup_summary').eq('organization_id', profile.organizationId).order('created_at', { ascending: false }),
    ]);
    if (accountResponse.error || connectionResponse.error) setError(accountResponse.error?.message ?? connectionResponse.error?.message ?? 'Connection setup could not be loaded.');
    else { setBankAccounts((accountResponse.data as BankAccount[]) ?? []); setConnections((connectionResponse.data as Connection[]) ?? []); }
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
    const { error: requestError } = await supabase.rpc('request_finance_external_connection', {
      p_provider_type: provider,
      p_connection_mode: method,
      p_requested_scopes: provider === 'ird' ? ['gst_status', 'filing_status', 'submission_receipts'] : ['account_transactions', 'balances', 'payment_matches'],
      p_bank_account_id: provider === 'bank' ? bankAccountId : null,
      p_consent_confirmed: consent,
    });
    if (requestError) setError(requestError.message);
    else { setNotice('Bob prepared the connection request. The next step opens with the approved provider; no password or token was stored here.'); setStep(0); setConsent(false); await load(); }
    setSaving(false);
  };

  const connectedLabel = (connection: Connection) => connection.status === 'connected' ? 'Connected' : connection.status === 'awaiting_authorisation' ? 'Waiting for authorisation' : connection.status;
  if (loading) return <section className="finance-connection-wizard" aria-busy="true"><p>Loading connection setup...</p></section>;

  return <section className="finance-connection-wizard" aria-labelledby="finance-connection-heading">
    <header><div><p className="finance-connection-eyebrow">Bob can prepare this</p><h2 id="finance-connection-heading">Connect IRD or your bank</h2><p>Bob can organise the setup and check what data is needed. You will authorise the provider in its secure window.</p></div><LockKeyhole size={20} /></header>
    <div className="finance-connection-safety"><ShieldCheck size={15} /><span>We never ask for online-banking passwords, IRD passwords, MFA codes, or access tokens in this app.</span></div>
    {error && <p className="finance-connection-error" role="alert"><CircleAlert size={14} />{error}</p>}
    {notice && <p className="finance-connection-notice" role="status"><CheckCircle2 size={14} />{notice}</p>}
    <div className="finance-connection-steps" aria-label="Connection setup progress">{steps.map((label, index) => <span className={index <= step ? 'is-active' : ''} key={label}><b>{index + 1}</b>{label}</span>)}</div>
    {step === 0 && <div className="finance-connection-options"><button type="button" className={provider === 'ird' ? 'is-selected' : ''} onClick={() => changeProvider('ird')}><Landmark size={18} /><strong>IRD</strong><small>GST and filing receipts</small></button><button type="button" className={provider === 'bank' ? 'is-selected' : ''} onClick={() => changeProvider('bank')}><Banknote size={18} /><strong>Bank account</strong><small>Balances and payment matching</small></button></div>}
    {step === 1 && <div className="finance-connection-form"><h3>Safe connection method</h3><p>{provider === 'ird' ? 'IRD access will use an approved authorisation window. Bob will not see or store your login.' : 'Bank access will use an approved banking provider. Bob will not see or store your login.'}</p>{provider === 'bank' && <label><span>Account to connect</span><select value={bankAccountId} onChange={(event) => setBankAccountId(event.target.value)}><option value="">Select an account</option>{bankAccounts.map((account) => <option key={account.id} value={account.id}>{account.account_name} {account.account_number.slice(-4) ? `ending ${account.account_number.slice(-4)}` : ''}</option>)}</select></label>}<button type="button" className="btn btn-primary" disabled={provider === 'bank' && !bankAccountId} onClick={() => setStep(2)}>Continue <ArrowRight size={15} /></button></div>}
    {step === 2 && <div className="finance-connection-form"><h3>Confirm before Bob prepares it</h3><label className="finance-connection-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /><span>I understand this will request access only for the selected finance data, and I will complete authorisation with the provider.</span></label><div className="finance-connection-summary"><strong>{provider === 'ird' ? 'IRD' : 'Bank account'}</strong><span>{method === 'oauth' ? 'Secure authorisation window' : 'Approved provider connection'}</span><span>{provider === 'ird' ? 'GST status, filing status, and submission receipts' : 'Balances, transactions, and payment matching'}</span></div><button type="button" className="btn btn-primary" disabled={!consent || saving} onClick={() => void requestConnection()}>{saving ? 'Preparing...' : 'Prepare secure connection'} <ArrowRight size={15} /></button></div>}
    {connections.length > 0 && <div className="finance-connection-existing"><strong>Existing setup</strong>{connections.slice(0, 4).map((connection, index) => <div key={`${connection.provider_type}-${connection.bank_account_id ?? index}`}><span>{connection.provider_type === 'ird' ? 'IRD' : 'Bank account'}</span><b>{connectedLabel(connection)}</b></div>)}</div>}
  </section>;
}
