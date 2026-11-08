import React, { useId, useState } from 'react';
import { Plus } from 'lucide-react';
import { createServiceCode, serviceLabel, type ServiceCode } from '../lib/payCatalog';
import './PayCodeSelect.css';

interface ServiceCodeSelectProps {
  label?: string;
  codes: ServiceCode[];
  value: string;
  onChange: (code: string) => void;
  onCreated?: (code: ServiceCode) => void;
  canCreate: boolean;
  organizationId?: string | null;
  required?: boolean;
  disabled?: boolean;
  emptyLabel?: string;
  allowEmpty?: boolean;
}

const NEW_TASK = '__new_task_code__';

export const ServiceCodeSelect: React.FC<ServiceCodeSelectProps> = ({
  label = 'Task', codes, value, onChange, onCreated, canCreate, organizationId, required, disabled,
  emptyLabel = 'All tasks', allowEmpty = true,
}) => {
  const id = useId();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const known = codes.some((code) => code.code === value);

  const add = async () => {
    setSaving(true);
    setError(null);
    try {
      const created = await createServiceCode(name, organizationId);
      onCreated?.(created);
      onChange(created.code);
      setName('');
      setAdding(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The task could not be added.');
    } finally {
      setSaving(false);
    }
  };

  return <div className="pay-code-select">
    <label htmlFor={id}>{label}</label>
    <select id={id} value={adding ? NEW_TASK : value} required={required && !adding} disabled={disabled} onChange={(event) => {
      if (event.target.value === NEW_TASK) { setAdding(true); return; }
      setAdding(false);
      onChange(event.target.value);
    }}>
      {(allowEmpty || !value) && <option value="">{emptyLabel}</option>}
      {value && !known && <option value={value}>{serviceLabel(value)} · not a task code</option>}
      {codes.map((code) => <option key={code.code} value={code.code}>{code.name}</option>)}
      {canCreate && <option value={NEW_TASK}>+ New task…</option>}
    </select>
    {adding && <div className="pay-code-new pay-code-new--single" role="group" aria-label="New task">
      <input aria-label="New task name" placeholder="Task name, e.g. Camera review" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
      <button type="button" className="btn btn-sm btn-primary" disabled={saving || !name.trim()} onClick={() => void add()}><Plus size={14} /> {saving ? 'Adding…' : 'Add'}</button>
      <button type="button" className="btn btn-sm btn-secondary" onClick={() => { setAdding(false); setError(null); }}>Cancel</button>
      {error && <p className="pay-code-error" role="alert">{error}</p>}
    </div>}
  </div>;
};

export default ServiceCodeSelect;
