import React, { useId, useState } from 'react';
import { Plus } from 'lucide-react';
import { createPayCode, type PayCode } from '../lib/payCatalog';
import './PayCodeSelect.css';

interface PayCodeSelectProps {
  label?: string;
  codes: PayCode[];
  value: string;
  onChange: (code: string) => void;
  onCreated?: (code: PayCode) => void;
  canCreate: boolean;
  required?: boolean;
  disabled?: boolean;
  emptyLabel?: string;
}

const NEW_CODE = '__new_pay_code__';

export const PayCodeSelect: React.FC<PayCodeSelectProps> = ({ label = 'Pay code', codes, value, onChange, onCreated, canCreate, required, disabled, emptyLabel = 'Choose a pay code' }) => {
  const id = useId();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ code: '', name: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const known = codes.some((code) => code.code === value);

  const add = async () => {
    setSaving(true);
    setError(null);
    try {
      const created = await createPayCode(draft.code, draft.name);
      onCreated?.(created);
      onChange(created.code);
      setDraft({ code: '', name: '' });
      setAdding(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The pay code could not be created.');
    } finally {
      setSaving(false);
    }
  };

  return <div className="pay-code-select">
    <label htmlFor={id}>{label}</label>
    <select id={id} value={adding ? NEW_CODE : value} required={required && !adding} disabled={disabled} onChange={(event) => {
      if (event.target.value === NEW_CODE) { setAdding(true); return; }
      setAdding(false);
      onChange(event.target.value);
    }}>
      <option value="">{emptyLabel}</option>
      {value && !known && <option value={value}>{value} · not an active code</option>}
      {codes.map((code) => <option key={code.id} value={code.code}>{code.code} · {code.name}</option>)}
      {canCreate && <option value={NEW_CODE}>+ New pay code…</option>}
    </select>
    {adding && <div className="pay-code-new" role="group" aria-label="New pay code">
      <input aria-label="New pay code" placeholder="CODE" value={draft.code} maxLength={32} onChange={(event) => setDraft({ ...draft, code: event.target.value.toUpperCase() })} />
      <input aria-label="New pay code name" placeholder="Name shown to payroll" value={draft.name} maxLength={120} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
      <button type="button" className="btn btn-sm btn-primary" disabled={saving || !draft.code.trim() || !draft.name.trim()} onClick={() => void add()}><Plus size={14} /> {saving ? 'Adding…' : 'Add'}</button>
      <button type="button" className="btn btn-sm btn-secondary" onClick={() => { setAdding(false); setError(null); }}>Cancel</button>
      {error && <p className="pay-code-error" role="alert">{error}</p>}
    </div>}
  </div>;
};

export default PayCodeSelect;
