import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, CheckCircle2, CircleAlert, RefreshCw } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './FinanceReconciliationWorkspace.css';

type ReconciliationStatus = 'pending' | 'unmatched' | 'review' | 'matched' | 'disputed' | 'excluded';
type MovementKind = 'external' | 'statement';

type ExternalTransaction = {
  id: string;
  transaction_date: string | null;
  description: string | null;
  amount: number | null;
  direction: 'credit' | 'debit' | 'unknown';
  external_transaction_id: string;
  reconciliation_status: ReconciliationStatus;
};

type StatementLine = {
  id: string;
  transaction_date: string;
  description: string;
  reference: string | null;
  amount: number;
  transaction_type: 'credit' | 'debit';
  reconciliation_status: ReconciliationStatus;
};

type PaymentReceipt = {
  id: string;
  invoice_id: string;
  payment_date: string;
  payment_amount: number;
  payment_method: string;
  transaction_reference: string | null;
  reconciliation_status: ReconciliationStatus;
};

type SelectedMovement = {
  id: string;
  kind: MovementKind;
  date: string | null;
  description: string;
  reference: string | null;
  amount: number;
};

const financeRoles = new Set(['grand_master', 'master', 'admin', 'admin_officer']);
const money = (value: number) => new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD' }).format(value);
const date = (value: string | null) => value ? new Intl.DateTimeFormat('en-NZ', { dateStyle: 'medium' }).format(new Date(`${value}T00:00:00`)) : 'Date unavailable';

export function FinanceReconciliationWorkspace() {
  const { profile } = useAuth();
  const [externalTransactions, setExternalTransactions] = useState<ExternalTransaction[]>([]);
  const [statementLines, setStatementLines] = useState<StatementLine[]>([]);
  const [receipts, setReceipts] = useState<PaymentReceipt[]>([]);
  const [selected, setSelected] = useState<SelectedMovement | null>(null);
  const [selectedReceiptId, setSelectedReceiptId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const canManage = Boolean(profile?.organizationId && financeRoles.has(profile.role));

  const load = useCallback(async () => {
    if (!profile?.organizationId || !canManage) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const [externalResponse, statementResponse, receiptResponse] = await Promise.all([
      supabase.from('finance_external_bank_transactions')
        .select('id,transaction_date,description,amount,direction,external_transaction_id,reconciliation_status')
        .eq('organization_id', profile.organizationId)
        .in('reconciliation_status', ['unmatched', 'review'])
        .order('transaction_date', { ascending: false })
        .limit(100),
      supabase.from('finance_bank_statement_lines')
        .select('id,transaction_date,description,reference,amount,transaction_type,reconciliation_status')
        .eq('organization_id', profile.organizationId)
        .in('reconciliation_status', ['unmatched', 'review'])
        .order('transaction_date', { ascending: false })
        .limit(100),
      supabase.from('payment_receipts')
        .select('id,invoice_id,payment_date,payment_amount,payment_method,transaction_reference,reconciliation_status')
        .eq('organization_id', profile.organizationId)
        .in('reconciliation_status', ['pending', 'unmatched'])
        .order('payment_date', { ascending: false })
        .limit(100),
    ]);
    const firstError = externalResponse.error ?? statementResponse.error ?? receiptResponse.error;
    if (firstError) setError(firstError.message);
    else {
      setExternalTransactions((externalResponse.data as ExternalTransaction[]) ?? []);
      setStatementLines((statementResponse.data as StatementLine[]) ?? []);
      setReceipts((receiptResponse.data as PaymentReceipt[]) ?? []);
      setSelected((current) => current && (
        externalResponse.data?.some((row) => current.kind === 'external' && row.id === current.id)
        || statementResponse.data?.some((row) => current.kind === 'statement' && row.id === current.id)
      ) ? current : null);
    }
    setLoading(false);
  }, [canManage, profile?.organizationId]);

  useEffect(() => { void load(); }, [load]);

  const movements = useMemo<SelectedMovement[]>(() => [
    ...externalTransactions
      .filter((transaction) => transaction.direction === 'credit' && Number(transaction.amount ?? 0) > 0)
      .map((transaction) => ({
        id: transaction.id,
        kind: 'external' as const,
        date: transaction.transaction_date,
        description: transaction.description ?? 'Imported bank credit',
        reference: transaction.external_transaction_id,
        amount: Number(transaction.amount ?? 0),
      })),
    ...statementLines
      .filter((line) => line.transaction_type === 'credit')
      .map((line) => ({
        id: line.id,
        kind: 'statement' as const,
        date: line.transaction_date,
        description: line.description,
        reference: line.reference,
        amount: Math.abs(Number(line.amount)),
      })),
  ].sort((left, right) => (right.date ?? '').localeCompare(left.date ?? '')), [externalTransactions, statementLines]);

  const candidateReceipts = useMemo(() => {
    if (!selected) return [];
    return receipts.filter((receipt) => Math.abs(Number(receipt.payment_amount) - selected.amount) <= 0.01);
  }, [receipts, selected]);

  const chooseMovement = (movement: SelectedMovement) => {
    setSelected(movement);
    setSelectedReceiptId('');
    setError(null);
    setNotice(null);
  };

  const confirmMatch = async () => {
    if (!selected || !selectedReceiptId) {
      setError('Choose both the bank credit and its payment receipt.');
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    const result = selected.kind === 'external'
      ? await supabase.rpc('match_finance_external_bank_transaction', {
        p_transaction_id: selected.id,
        p_payment_receipt_id: selectedReceiptId,
      })
      : await supabase.rpc('match_finance_bank_statement_line', {
        p_statement_line_id: selected.id,
        p_payment_receipt_id: selectedReceiptId,
      });
    if (result.error) setError(result.error.message);
    else {
      setNotice(`${money(selected.amount)} was matched. The bank movement and payment receipt now share an audited reconciliation record.`);
      setSelected(null);
      setSelectedReceiptId('');
      await load();
    }
    setSaving(false);
  };

  if (!canManage) return <section className="finance-reconciliation is-permission"><CircleAlert size={18} /><div><strong>Payment matching is restricted</strong><p>A finance administrator must review and confirm bank matches.</p></div></section>;

  return <section className="finance-reconciliation" aria-labelledby="finance-reconciliation-heading">
    <header>
      <div><p>Payment reconciliation</p><h2 id="finance-reconciliation-heading">Match incoming bank money to customer receipts</h2><span>Only exact-amount credits are offered. Outgoing or disputed activity stays outside this action.</span></div>
      <button type="button" className="btn btn-secondary" onClick={() => void load()} disabled={loading || saving}><RefreshCw size={15} className={loading ? 'is-spinning' : ''} />Refresh</button>
    </header>
    {error && <div className="finance-reconciliation-message is-error" role="alert"><CircleAlert size={15} />{error}</div>}
    {notice && <div className="finance-reconciliation-message is-success" role="status"><CheckCircle2 size={15} />{notice}</div>}
    {loading ? <div className="finance-reconciliation-empty">Loading bank movements and receipts...</div> : (
      <div className="finance-reconciliation-grid">
        <div>
          <h3>1. Choose an incoming bank credit <span>{movements.length}</span></h3>
          {movements.length === 0 ? <div className="finance-reconciliation-empty">No unmatched incoming bank credits are waiting.</div> : (
            <div className="finance-reconciliation-list">
              {movements.map((movement) => <button type="button" key={`${movement.kind}:${movement.id}`} className={selected?.id === movement.id && selected.kind === movement.kind ? 'is-selected' : ''} onClick={() => chooseMovement(movement)}>
                <span><strong>{movement.description}</strong><small>{date(movement.date)} · {movement.kind === 'external' ? 'connected bank feed' : 'statement import'}</small></span>
                <b>{money(movement.amount)}</b>
              </button>)}
            </div>
          )}
        </div>
        <div>
          <h3>2. Choose the customer receipt <span>{candidateReceipts.length}</span></h3>
          {!selected ? <div className="finance-reconciliation-empty">Choose a bank credit to see exact-amount receipt candidates.</div> : candidateReceipts.length === 0 ? <div className="finance-reconciliation-empty">No unmatched receipt has the exact amount {money(selected.amount)}. Check the invoice receipt before continuing.</div> : (
            <div className="finance-reconciliation-list">
              {candidateReceipts.map((receipt) => <label key={receipt.id} className={selectedReceiptId === receipt.id ? 'is-selected' : ''}>
                <input type="radio" name="payment-receipt" value={receipt.id} checked={selectedReceiptId === receipt.id} onChange={() => setSelectedReceiptId(receipt.id)} />
                <span><strong>{receipt.transaction_reference || `Receipt ${receipt.id.slice(0, 8)}`}</strong><small>{date(receipt.payment_date)} · {receipt.payment_method.replaceAll('_', ' ')}</small></span>
                <b>{money(Number(receipt.payment_amount))}</b>
              </label>)}
            </div>
          )}
        </div>
      </div>
    )}
    <footer>
      <div><ArrowRightLeft size={16} /><span>Matching is one-to-one, retry-safe, tenant-scoped, and recorded in the audit log.</span></div>
      <button type="button" className="btn btn-primary" onClick={() => void confirmMatch()} disabled={!selected || !selectedReceiptId || saving}>{saving ? 'Matching...' : 'Confirm payment match'}</button>
    </footer>
  </section>;
}
