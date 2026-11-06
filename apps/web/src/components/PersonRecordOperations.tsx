import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { sha256Hex } from '../lib/importPreview';
import { SAFETY_ALERT_LEVELS, type SafetyAlertLevel } from '../lib/safetyWarnings';
import './PersonRecordOperations.css';

type Housing = { status: string; notes: string | null; verified_at: string | null; version: string };
type PersonFlag = { id: string; alert_level: string; reason: string | null };
type PersonDocument = {
  id: string; document_type: string; file_name: string; storage_path: string;
  notice_id: string | null; created_at: string; client_request_id: string;
};
type Operations = {
  verified: boolean;
  housing: Housing;
  housing_states: Array<{ code: string; label: string; requires_verified_identity: boolean }>;
  document_types: Array<{ code: string; label: string; notice_type: string | null }>;
  flags: PersonFlag[];
  documents: PersonDocument[];
  document_total: number;
  clients: Array<{ id: string; name: string }>;
};

export function PersonRecordOperations({ organizationId, personId, onChanged }: {
  organizationId: string; personId: string; onChanged?: () => void;
}) {
  const [context, setContext] = useState<Operations | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [level, setLevel] = useState<SafetyAlertLevel>('medium');
  const [housingStatus, setHousingStatus] = useState('');
  const [housingNotes, setHousingNotes] = useState('');
  const [housingVersion, setHousingVersion] = useState('');
  const [documentType, setDocumentType] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [clientId, setClientId] = useState('');
  const [issuedDate, setIssuedDate] = useState('');
  const [expiresDate, setExpiresDate] = useState('');
  const [area, setArea] = useState('');
  const [number, setNumber] = useState('');
  const [author, setAuthor] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [sourceLink, setSourceLink] = useState<{ id: string; url: string } | null>(null);
  const requests = useRef(new Map<string, { signature: string; id: string }>());
  const loadVersion = useRef(0);
  const requestId = (action: string, value: unknown) => {
    const signature = JSON.stringify(value);
    const previous = requests.current.get(action);
    if (previous?.signature === signature) return previous.id;
    const id = crypto.randomUUID();
    requests.current.set(action, { signature, id });
    return id;
  };
  const load = useCallback(async (resetHousing = true) => {
    const version = ++loadVersion.current;
    setLoading(true);
    try {
      const { data, error: rpcError } = await supabase.rpc('get_person_record_operations', {
        p_organization_id: organizationId, p_person_id: personId,
      });
      if (rpcError) throw new Error(rpcError.message);
      if (!data || typeof data.verified !== 'boolean' || typeof data.housing?.version !== 'string'
        || typeof data.housing?.status !== 'string' || !Array.isArray(data.housing_states)
        || !Array.isArray(data.document_types) || !Array.isArray(data.documents)
        || !Array.isArray(data.flags) || !Array.isArray(data.clients)) {
        throw new Error('The person record returned an incomplete response. Reload before making changes.');
      }
      if (version !== loadVersion.current) return;
      const next = data as Operations;
      setContext(next);
      if (resetHousing) {
        setHousingStatus(next.housing.status);
        setHousingNotes(next.housing.notes ?? '');
        setHousingVersion(next.housing.version);
      }
      setDocumentType(current => next.document_types.some(type => type.code === current)
        ? current : next.document_types.find(type => type.notice_type === null)?.code ?? next.document_types[0]?.code ?? '');
    } catch (failure) {
      if (version === loadVersion.current) {
        setError(failure instanceof Error ? failure.message : 'Person operations could not be loaded.');
        setContext(null);
      }
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }, [organizationId, personId]);
  useEffect(() => {
    void load();
    return () => { loadVersion.current += 1; };
  }, [load]);
  const perform = async (action: string, task: () => Promise<string>) => {
    setBusy(action);
    setError(null);
    setReceipt(null);
    try {
      setReceipt(await task());
      requests.current.delete(action);
      await load(action === 'housing');
      onChanged?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The change could not be confirmed. Retry without changing the inputs.');
    } finally {
      setBusy(null);
    }
  };
  const validReason = reason.trim().length >= 5 && reason.trim().length <= 1000;
  const raiseFlag = (event: FormEvent) => {
    event.preventDefault();
    if (!context?.verified || !validReason || context.flags.length) return;
    void perform('flag', async () => {
      const { data, error: rpcError } = await supabase.rpc('raise_scoped_person_interest_flag', {
        p_organization_id: organizationId, p_client_request_id: requestId('flag', [level, reason.trim()]),
        p_canonical_person_id: personId, p_alert_level: level, p_reason: reason.trim(),
      });
      if (rpcError) throw new Error(rpcError.message);
      if (!data?.id || data.active !== true || data.alert_level !== level) {
        throw new Error('No active flag receipt returned. Retry unchanged to check the result.');
      }
      return 'Person-of-interest flag saved to this organisation, with audit history.';
    });
  };
  const resolveFlag = (flag: PersonFlag) => {
    if (!validReason) return;
    void perform('resolve', async () => {
      const { data, error: rpcError } = await supabase.rpc('resolve_entity_flag', { p_flag_id: flag.id, p_note: reason.trim() });
      if (rpcError) throw new Error(rpcError.message);
      if (data?.id !== flag.id || data.active !== false) {
        throw new Error('No resolved flag receipt returned. Retry unchanged to check the result.');
      }
      return 'Person-of-interest flag resolved with your reason retained.';
    });
  };
  const saveHousing = (event: FormEvent) => {
    event.preventDefault();
    if (!context || !validReason) return;
    const args = {
      p_organization_id: organizationId, p_person_id: personId, p_expected_version: housingVersion,
      p_status: housingStatus, p_notes: housingNotes.trim() || null, p_reason: reason.trim(),
    };
    void perform('housing', async () => {
      const { data, error: rpcError } = await supabase.rpc('update_person_housing_status', {
        ...args, p_client_request_id: requestId('housing', args),
      });
      if (rpcError) throw new Error(rpcError.message);
      if (typeof data?.version !== 'string' || data.status !== housingStatus) {
        throw new Error('No housing update receipt returned. Retry unchanged to check the result.');
      }
      return 'Person homelessness record updated. Linked vehicle records were not changed.';
    });
  };
  const selectedType = context?.document_types.find(type => type.code === documentType);
  const needsNotice = Boolean(selectedType?.notice_type);
  const saveDocument = (event: FormEvent) => {
    event.preventDefault();
    if (!file || !selectedType || !validReason) return;
    void perform('document', async () => {
      if (file.size < 1 || file.size > 10 * 1024 * 1024
        || !['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        throw new Error('Choose a non-empty PDF, JPEG, PNG or WebP file, up to 10 MB.');
      }
      if (needsNotice && (!confirmed || !clientId || !issuedDate || !area.trim())) {
        throw new Error('Review the notice, select its client, and enter its issue date and affected place.');
      }
      const hash = await sha256Hex(await file.arrayBuffer());
      const notice = needsNotice ? {
        client_organization_id: clientId, issued_date: issuedDate, expires_date: expiresDate || null,
        area: area.trim(), notice_number: number.trim() || null, source_author: author.trim() || null, confirmed,
      } : null;
      const values = [hash, file.name, documentType, reason.trim(), notice];
      const id = requestId('document', values);
      const path = `${organizationId}/person/${personId}/${id}/source`;
      const upload = await supabase.storage.from('person-documents').upload(path, file, {
        contentType: file.type, upsert: false, metadata: { sha256: hash },
      });
      const duplicate = upload.error && 'statusCode' in upload.error && String(upload.error.statusCode) === '409';
      if (upload.error && !duplicate) throw new Error(upload.error.message);
      const { data, error: rpcError } = await supabase.rpc('record_person_document', {
        p_organization_id: organizationId, p_person_id: personId, p_client_request_id: id,
        p_document_type: documentType, p_file_name: file.name, p_storage_path: path,
        p_sha256: hash, p_reason: reason.trim(), p_notice: notice,
      });
      if (rpcError) throw new Error(`${rpcError.message} The uploaded source stays private; retry unchanged to recover the result.`);
      if (!data?.id || data.client_request_id !== id || (needsNotice && !data.notice_id)) {
        throw new Error('The document receipt is incomplete. Keep the inputs unchanged and retry to verify the result.');
      }
      setFile(null);
      setFileKey(current => current + 1);
      setConfirmed(false);
      return needsNotice
        ? 'Original document saved and existing issued notice linked to the client and person. No new notice was served.'
        : 'Supporting document saved privately to this person.';
    });
  };
  const openDocument = (document: PersonDocument) => {
    void (async () => {
      setBusy('open');
      setError(null);
      try {
        const { data, error: storageError } = await supabase.storage.from('person-documents')
          .createSignedUrl(document.storage_path, 60, { download: document.file_name });
        if (storageError) throw new Error(storageError.message);
        if (!data?.signedUrl) throw new Error('The source link could not be created.');
        setSourceLink({ id: document.id, url: data.signedUrl });
        setReceipt('Private source link ready below; it expires in 60 seconds.');
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'The private source link could not be created.');
      } finally {
        setBusy(null);
      }
    })();
  };

  return (
    <section className="person-record-operations" aria-label="Person record actions">
      <h3>Flags, documents and welfare</h3>
      {receipt && <p role="status">{receipt}</p>}
      {error && <div role="alert"><p>{error}</p><button type="button" disabled={busy !== null} onClick={() => { setError(null); void load(); }}>Reload person actions</button></div>}
      {loading && <p role="status">Loading person actions...</p>}
      {context && (
        <fieldset disabled={busy !== null || loading}>
          <label>Reason and supporting basis
            <textarea value={reason} onChange={event => setReason(event.target.value)} minLength={5} maxLength={1000} rows={2} />
          </label>
          <p>Changes are administrator-only and audited. State the source and reason; avoid unnecessary private details.</p>
          <section aria-label="Person of interest">
            <h4>Person of interest</h4>
            <p>This organisation&apos;s flag does not establish wrongdoing. Safety hazards remain in Safety warnings.</p>
            {context.flags.map(flag => (
              <div key={flag.id} className="person-record-operations__flag">
                <strong>Active · {flag.alert_level}</strong><span>{flag.reason}</span>
                <button type="button" disabled={!validReason} onClick={() => resolveFlag(flag)}>Resolve person-of-interest flag</button>
              </div>
            ))}
            {!context.flags.length && (context.verified ? (
              <form onSubmit={raiseFlag}>
                <label>Flag priority<select value={level} onChange={event => setLevel(event.target.value as SafetyAlertLevel)}>
                  {SAFETY_ALERT_LEVELS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select></label>
                <button type="submit" disabled={!validReason}>Flag as person of interest</button>
              </form>
            ) : <p>Verify the person record and canonical identity before raising a person-of-interest flag.</p>)}
          </section>
          <form onSubmit={saveHousing} aria-label="Homelessness record">
            <h4>Homelessness and welfare</h4>
            <p>Record the person&apos;s circumstances independently of vehicles. This does not grant an exemption or establish a safety hazard.</p>
            <p>This updates the shared person record. Authorised administrators linked to this person can read these welfare notes; include only necessary information.</p>
            <label>Housing status<select value={housingStatus} onChange={event => setHousingStatus(event.target.value)}>
              {context.housing_states.map(state => <option key={state.code} value={state.code}
                disabled={state.requires_verified_identity && !context.verified}>{state.label}</option>)}
            </select></label>
            <label>Welfare notes<textarea rows={3} maxLength={2000} value={housingNotes} onChange={event => setHousingNotes(event.target.value)} /></label>
            {context.housing.verified_at && <p>Last confirmed: {new Date(context.housing.verified_at).toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland' })}</p>}
            <button type="submit" disabled={!validReason || (housingStatus === context.housing.status && housingNotes.trim() === (context.housing.notes ?? ''))}>Save homelessness record</button>
          </form>
          <form onSubmit={saveDocument} aria-label="Attach person document">
            <h4>Documents and existing notices</h4>
            <p>Private PDF or image, up to 10 MB. No OCR, facial recognition or external model is invoked.</p>
            <label>Document type<select value={documentType} onChange={event => { setDocumentType(event.target.value); setConfirmed(false); }}>
              {context.document_types.map(type => <option key={type.code} value={type.code}>{type.label}</option>)}
            </select></label>
            <label>Original document<input key={fileKey} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" required
              onChange={event => { setFile(event.target.files?.[0] ?? null); setConfirmed(false); }} /></label>
            {needsNotice && (
              <div className="person-record-operations__notice">
                <p>Record an already-issued human-authored notice, not a draft. Uploading does not serve a new notice or verify an identity.</p>
                <label>Client organisation<select required value={clientId} onChange={event => { setClientId(event.target.value); setConfirmed(false); }}>
                  <option value="">Select the client named on the notice</option>
                  {context.clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}
                </select></label>
                {!context.clients.length && <p>No client with a current operational agreement is available. Operations must check the agreement before recording a notice.</p>}
                <label>Issued on (New Zealand date)<input type="date" required value={issuedDate} onChange={event => { setIssuedDate(event.target.value); setConfirmed(false); }} /></label>
                <label>Expiry on source (optional)<input type="date" min={issuedDate} value={expiresDate} onChange={event => { setExpiresDate(event.target.value); setConfirmed(false); }} /></label>
                <small>Leave expiry blank only when absent from the source; the existing notice rule defaults trespass and warning expiry to two years.</small>
                <label>Affected place or area on source<input required maxLength={500} value={area} onChange={event => { setArea(event.target.value); setConfirmed(false); }} /></label>
                <label>Notice number (optional)<input maxLength={100} value={number} onChange={event => { setNumber(event.target.value); setConfirmed(false); }} /></label>
                <label>Source author (optional)<input maxLength={200} value={author} onChange={event => { setAuthor(event.target.value); setConfirmed(false); }} /></label>
                <label className="person-record-operations__confirmation"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
                  I compared this source with the selected person and client, and confirm it is an already-issued notice with these dates and affected place.</label>
              </div>
            )}
            <button type="submit" disabled={!validReason || !file || !selectedType || (needsNotice && (!confirmed || !clientId))}>
              {busy === 'document' ? 'Saving document...' : needsNotice ? 'Save source and record existing notice' : 'Save supporting document'}
            </button>
          </form>
          <section aria-label="Saved person documents">
            <h4>Saved documents ({context.document_total})</h4>
            {context.document_total > 100 && <p>Showing the most recent 100 documents.</p>}
            {!context.documents.length && <p>No documents attached through this profile yet. Existing notice history remains in Notices and letters.</p>}
            <ul>{context.documents.map(document => (
              <li key={document.id}><strong>{document.file_name}</strong>
                <span>{context.document_types.find(type => type.code === document.document_type)?.label ?? document.document_type}{document.notice_id ? ' · linked to notice register' : ''}</span>
                <button type="button" onClick={() => openDocument(document)}>Get private source link</button>
                {sourceLink?.id === document.id && <a href={sourceLink.url} target="_blank" rel="noopener noreferrer">Open original document (60-second link)</a>}
              </li>
            ))}</ul>
          </section>
        </fieldset>
      )}
    </section>
  );
}

export function PersonInterestSummary({ personId }: { personId: string }) {
  const [flags, setFlags] = useState<Array<{ alert_level: string; organization_name: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: rpcError } = await supabase.rpc('get_person_interest_summary', { p_person_id: personId });
      if (rpcError) throw new Error(rpcError.message);
      if (!Array.isArray(data)) throw new Error('The person flag summary returned an incomplete response.');
      setFlags(data);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Person flags could not be checked.');
    } finally {
      setLoading(false);
    }
  }, [personId]);
  useEffect(() => { void load(); }, [load]);
  if (error) return <div role="alert">Person-of-interest flags could not be checked. {error} <button type="button" disabled={loading} onClick={() => void load()}>Retry flag check</button></div>;
  if (flags === null) return <p role="status">Checking person-of-interest flags...</p>;
  if (!flags.length) return null;
  return <aside aria-label="Person-of-interest flags">
    <strong>Person of interest</strong>
    <ul>{flags.map((flag, index) => <li key={`${flag.organization_name}:${index}`}>{flag.alert_level} · {flag.organization_name}</li>)}</ul>
    <p>A flag is a recorded concern, not proof of wrongdoing. Contact the recording organisation for context.</p>
  </aside>;
}
