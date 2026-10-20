import React, { useEffect, useRef, useState } from 'react';
import {
  ALIAS_KINDS, ALIAS_KIND_LABEL, addPersonAlias, describeMatchBasis, findPersonMatches, getIdentityDocumentKinds,
  getPersonFaceMatches, getPersonIdentitySummary, mergePersonRecords, retirePersonAlias, reviewStateLabel,
  submitPersonIdentityEvidence,
  type DocumentKindOption, type FaceMatch, type NewPersonFields, type PersonIdentitySummary, type PersonMatch,
} from '../lib/personIdentity';
import './PersonIdentity.css';

const errorText = (error: unknown) => (error instanceof Error ? error.message : (error as { message?: string })?.message) ?? 'Something went wrong';

export const PersonStateBadge: React.FC<{ state: string }> = ({ state }) => (
  <span className={`badge ${state === 'verified' ? 'badge-success' : state === 'rejected' ? 'badge-error' : 'badge-warning'}`}>{reviewStateLabel(state)}</span>
);

/**
 * Shows people already on record who look like the person being entered (same
 * name or alias, similar name, same licence, phone, email or date of birth) so
 * the user picks the existing record instead of creating a duplicate. A strong
 * match must be explicitly overridden with "This is a different person".
 */
export const PersonMatchSuggestions: React.FC<{
  organizationId: string | null | undefined;
  fields: Partial<NewPersonFields>;
  excludePersonRecordId?: string | null;
  onPick: (match: PersonMatch) => void;
  confirmNew: boolean;
  onConfirmNewChange: (value: boolean) => void;
}> = ({ organizationId, fields, excludePersonRecordId, onPick, confirmNew, onConfirmNewChange }) => {
  const [matches, setMatches] = useState<PersonMatch[]>([]);
  const key = JSON.stringify([fields.display_name, fields.date_of_birth, fields.phone, fields.email, fields.licence_number]);

  useEffect(() => {
    const hasCriteria = (fields.display_name?.trim().length ?? 0) >= 3 || fields.phone?.trim() || fields.email?.trim() || fields.licence_number?.trim();
    if (!organizationId || !hasCriteria) { setMatches([]); return; }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void findPersonMatches(organizationId, fields, excludePersonRecordId)
        .then((rows) => { if (!cancelled) setMatches(rows); })
        .catch(() => { if (!cancelled) setMatches([]); });
    }, 350);
    return () => { cancelled = true; window.clearTimeout(handle); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, key, excludePersonRecordId]);

  if (!matches.length) return null;
  const hasStrong = matches.some((match) => match.score >= 0.85);
  return (
    <div className="person-matches" role="region" aria-label="Possible existing records">
      <strong>{hasStrong ? 'This person may already be on record' : 'Is this one of these people?'}</strong>
      <ul>
        {matches.map((match) => (
          <li key={match.person_record_id}>
            <div>
              <span className="person-matches__name">{match.display_name || 'Unnamed person'}</span>{' '}
              <PersonStateBadge state={match.review_state} />{' '}
              <span className={`person-matches__strength is-${match.strength}`}>{match.strength}</span>
              <div className="person-matches__meta">
                {describeMatchBasis(match.match_basis)}
                {match.matched_name && match.matched_name !== match.display_name ? ` (“${match.matched_name}”)` : ''}
                {match.aliases?.length ? ` · also known as ${match.aliases.join(', ')}` : ''}
                {match.locality ? ` · ${match.locality}` : ''}
                {match.sighting_count ? ` · ${match.sighting_count} sighting${match.sighting_count === 1 ? '' : 's'}` : ''}
              </div>
            </div>
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => onPick(match)}>Use this person</button>
          </li>
        ))}
      </ul>
      {hasStrong && (
        <label className="person-matches__confirm">
          <input type="checkbox" checked={confirmNew} onChange={(event) => onConfirmNewChange(event.target.checked)} />
          This is a different person — create a new record
        </label>
      )}
    </div>
  );
};

/** Looks up existing people by name or alias, for "existing person" pickers. */
export const PersonSearchPicker: React.FC<{
  organizationId: string | null | undefined;
  value: PersonMatch | null;
  onChange: (match: PersonMatch | null) => void;
}> = ({ organizationId, value, onChange }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PersonMatch[]>([]);
  useEffect(() => {
    if (!organizationId || query.trim().length < 2) { setResults([]); return; }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void findPersonMatches(organizationId, { display_name: query }, null, 10)
        .then((rows) => { if (!cancelled) setResults(rows); })
        .catch(() => { if (!cancelled) setResults([]); });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(handle); };
  }, [organizationId, query]);

  if (value) {
    return (
      <div className="person-picker__chosen">
        <span>{value.display_name || 'Unnamed person'}</span> <PersonStateBadge state={value.review_state} />
        <button type="button" className="btn btn-sm btn-secondary" onClick={() => onChange(null)}>Change</button>
      </div>
    );
  }
  return (
    <div className="person-picker">
      <label>Find person (name or alias)
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Type at least 2 letters" />
      </label>
      {query.trim().length >= 2 && (results.length === 0
        ? <small className="person-matches__meta">No matching person on record.</small>
        : <ul className="person-picker__results">
          {results.map((match) => (
            <li key={match.person_record_id}>
              <button type="button" onClick={() => { onChange(match); setQuery(''); }}>
                <span className="person-matches__name">{match.display_name || 'Unnamed person'}</span>
                <span className="person-matches__meta">
                  {reviewStateLabel(match.review_state)}
                  {match.matched_name && match.matched_name !== match.display_name ? ` · matched “${match.matched_name}”` : ''}
                  {match.locality ? ` · ${match.locality}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>)}
    </div>
  );
};

type MergeCandidate = { person_record_id: string; display_name: string | null; review_state: string; why: string };

/**
 * One person's identity: verification state, also-known-as names, ID evidence
 * submission (anyone in the organisation), and — for administrators — likely
 * duplicates and face matches that can be merged into a single record.
 */
export const PersonIdentityPanel: React.FC<{
  personRecordId: string;
  onClose: () => void;
  onChanged?: (keptPersonRecordId: string) => void;
}> = ({ personRecordId, onClose, onChanged }) => {
  const [currentId, setCurrentId] = useState(personRecordId);
  const [summary, setSummary] = useState<PersonIdentitySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [aliasText, setAliasText] = useState('');
  const [aliasKind, setAliasKind] = useState('aka');
  const [documentKinds, setDocumentKinds] = useState<DocumentKindOption[]>([]);
  const [documentKind, setDocumentKind] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [candidates, setCandidates] = useState<MergeCandidate[]>([]);
  const [faces, setFaces] = useState<FaceMatch[]>([]);
  const [merging, setMerging] = useState<MergeCandidate | null>(null);
  const [keep, setKeep] = useState<'this' | 'other'>('this');
  const [keptName, setKeptName] = useState('');
  const [mergeReason, setMergeReason] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);

  const load = async (id = currentId) => {
    setLoading(true);
    setError(null);
    try {
      const next = await getPersonIdentitySummary(id);
      setSummary(next);
      if (next?.can_merge) {
        const [nameMatches, faceMatches] = await Promise.all([
          findPersonMatches(next.organization_id, { display_name: next.display_name ?? '' }, id, 8).catch(() => [] as PersonMatch[]),
          getPersonFaceMatches(id).catch(() => [] as FaceMatch[]),
        ]);
        setFaces(faceMatches);
        setCandidates(nameMatches.map((match) => ({
          person_record_id: match.person_record_id,
          display_name: match.display_name,
          review_state: match.review_state,
          why: describeMatchBasis(match.match_basis),
        })));
      } else { setCandidates([]); setFaces([]); }
    } catch (loadError) { setError(errorText(loadError)); }
    setLoading(false);
  };

  useEffect(() => { void load(personRecordId); setCurrentId(personRecordId); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [personRecordId]);
  useEffect(() => {
    void getIdentityDocumentKinds().then((kinds) => { setDocumentKinds(kinds); setDocumentKind((current) => current || kinds[0]?.document_kind || ''); }).catch(() => undefined);
  }, []);
  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null);
    try { await action(); } catch (actionError) { setError(errorText(actionError)); }
    setBusy(false);
  };

  const saveAlias = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await addPersonAlias(currentId, aliasText, aliasKind);
      setAliasText('');
      await load();
    });
  };

  const removeAlias = (aliasId: string, alias: string) => {
    const reason = window.prompt(`Why remove “${alias}”?`);
    if (!reason?.trim()) return;
    void run(async () => { await retirePersonAlias(aliasId, reason); await load(); });
  };

  const submitEvidence = (event: React.FormEvent) => {
    event.preventDefault();
    if (!file || !summary || !documentKind) return;
    void run(async () => {
      const result = await submitPersonIdentityEvidence({ organizationId: summary.organization_id, personRecordId: currentId, documentKind, file });
      setFile(null); setFileKey((value) => value + 1);
      setNotice(result.extracted
        ? `ID evidence submitted${result.faceCount === 1 ? ' with a face photo' : ''}. An administrator will review and approve it in Users → Identity records.`
        : `ID evidence saved, but automatic reading did not finish (${result.message}). An administrator can still review it.`);
      await load();
    });
  };

  const startMerge = (candidate: MergeCandidate) => {
    setMerging(candidate);
    const otherVerified = candidate.review_state === 'verified' && summary?.review_state !== 'verified';
    setKeep(otherVerified ? 'other' : 'this');
    setKeptName(otherVerified ? candidate.display_name ?? '' : summary?.display_name ?? '');
    setMergeReason('');
  };

  const confirmMerge = (event: React.FormEvent) => {
    event.preventDefault();
    if (!merging || !summary) return;
    const targetId = keep === 'this' ? currentId : merging.person_record_id;
    const sourceId = keep === 'this' ? merging.person_record_id : currentId;
    void run(async () => {
      const result = await mergePersonRecords(summary.organization_id, sourceId, targetId, mergeReason, keptName);
      const moved = Object.entries(result?.moved ?? {}).filter(([, count]) => count > 0).map(([what, count]) => `${count} ${what.replace(/_/g, ' ')}`);
      setMerging(null);
      setCurrentId(targetId);
      await load(targetId);
      setNotice(`Records merged.${moved.length ? ` Moved ${moved.join(', ')}.` : ''} The other name is kept as an alias.`);
      onChanged?.(targetId);
    });
  };

  const mergeTargets: MergeCandidate[] = [
    ...faces.map((face) => ({
      person_record_id: face.person_record_id,
      display_name: face.display_name,
      review_state: face.review_state,
      why: `face match ${Math.round(face.score * 100)}%${face.sighting_count ? ` · ${face.sighting_count} sightings` : ''}`,
    })),
    ...candidates.filter((candidate) => !faces.some((face) => face.person_record_id === candidate.person_record_id)),
  ];

  return (
    <div className="person-identity-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="person-identity" role="dialog" aria-modal="true" aria-labelledby="person-identity-title" tabIndex={-1} ref={dialogRef}>
        <header>
          <div>
            <span>Person identity</span>
            <h2 id="person-identity-title">{summary?.display_name || 'Person'}</h2>
          </div>
          <button type="button" aria-label="Close" onClick={onClose}>✕</button>
        </header>
        {loading && !summary ? <p role="status">Loading…</p> : !summary ? (
          <div className="alert alert-error" role="alert">{error ?? 'This person is not visible to you.'}</div>
        ) : (
          <>
            {error && <div className="alert alert-error" role="alert">{error}</div>}
            {notice && <div className="alert alert-success" role="status">{notice}</div>}
            {summary.merged_into_person_record_id && (
              <div className="vehicle-owner__notice" role="note">
                This record was merged into another person.{' '}
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => { const id = summary.merged_into_person_record_id!; setCurrentId(id); void load(id); }}>Open the kept record</button>
              </div>
            )}
            <section className="person-identity__section" aria-label="Verification">
              <div className="person-identity__state">
                <PersonStateBadge state={summary.review_state} />
                <span>
                  {summary.verified
                    ? `Identity verified${summary.verified_at ? ` ${new Date(summary.verified_at).toLocaleDateString('en-NZ')}` : ''} from an approved ID document.`
                    : 'Not yet verified. Submit ID evidence below; an administrator approves it.'}
                </span>
              </div>
              <div className="person-matches__meta">
                {summary.approved_documents} approved · {summary.pending_documents} awaiting review · {summary.sighting_count} sighting{summary.sighting_count === 1 ? '' : 's'}
                {summary.has_face_reference ? ' · face reference on file' : ''}
                {summary.origin === 'cctv_inference_profile' ? ' · created from CCTV face recognition' : ''}
              </div>
            </section>

            <section className="person-identity__section" aria-label="Also known as">
              <h3>Names this person goes by</h3>
              {summary.aliases.length === 0 ? <p className="person-matches__meta">No other names recorded.</p> : (
                <ul className="person-identity__aliases">
                  {summary.aliases.map((alias) => (
                    <li key={alias.id}>
                      <span>{alias.alias}</span> <small>{ALIAS_KIND_LABEL[alias.alias_kind] ?? alias.alias_kind}</small>
                      {alias.can_remove && <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => removeAlias(alias.id, alias.alias)}>Remove</button>}
                    </li>
                  ))}
                </ul>
              )}
              <form className="person-identity__inline" onSubmit={saveAlias}>
                <label>Other name<input value={aliasText} maxLength={200} onChange={(event) => setAliasText(event.target.value)} placeholder="e.g. Don Squires" /></label>
                <label>Kind
                  <select value={aliasKind} onChange={(event) => setAliasKind(event.target.value)}>
                    {ALIAS_KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
                <button type="submit" className="btn btn-sm btn-secondary" disabled={busy || aliasText.trim().length < 2}>Add name</button>
              </form>
            </section>

            <section className="person-identity__section" aria-label="Submit ID evidence">
              <h3>Submit ID evidence</h3>
              <p className="person-matches__meta">A photo or scan of a driver licence, passport or other ID. It is stored privately, read automatically, and only an administrator can approve it. An ID with a face photo helps link unknown CCTV profiles to this person.</p>
              <form className="person-identity__inline" onSubmit={submitEvidence}>
                <label>Document
                  <select value={documentKind} onChange={(event) => setDocumentKind(event.target.value)}>
                    {documentKinds.map((kind) => <option key={kind.document_kind} value={kind.document_kind}>{kind.display_name}</option>)}
                  </select>
                </label>
                <label>File<input key={fileKey} type="file" accept="image/jpeg,image/png,image/webp,image/bmp,image/tiff,application/pdf" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
                <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !file || !documentKind}>{busy ? 'Working…' : 'Submit'}</button>
              </form>
            </section>

            {summary.can_merge && !summary.merged_into_person_record_id && (
              <section className="person-identity__section" aria-label="Possible duplicates">
                <h3>Possible duplicates</h3>
                {mergeTargets.length === 0 ? <p className="person-matches__meta">No likely duplicates or face matches found.</p> : (
                  <ul className="person-identity__candidates">
                    {mergeTargets.map((candidate) => (
                      <li key={candidate.person_record_id}>
                        {faces.find((face) => face.person_record_id === candidate.person_record_id)?.thumbnail && (
                          <img src={faces.find((face) => face.person_record_id === candidate.person_record_id)!.thumbnail!} alt="" />
                        )}
                        <div>
                          <span className="person-matches__name">{candidate.display_name || 'Unnamed person'}</span> <PersonStateBadge state={candidate.review_state} />
                          <div className="person-matches__meta">{candidate.why}</div>
                        </div>
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => startMerge(candidate)}>Same person…</button>
                      </li>
                    ))}
                  </ul>
                )}
                {merging && (
                  <form className="person-identity__merge" onSubmit={confirmMerge}>
                    <fieldset disabled={busy}>
                      <legend>Merge “{summary.display_name}” and “{merging.display_name}”</legend>
                      <div role="radiogroup" aria-label="Record to keep" className="vehicle-owner__mode">
                        <label><input type="radio" checked={keep === 'this'} onChange={() => { setKeep('this'); setKeptName(summary.display_name ?? ''); }} /> Keep {summary.display_name} ({reviewStateLabel(summary.review_state)})</label>
                        <label><input type="radio" checked={keep === 'other'} onChange={() => { setKeep('other'); setKeptName(merging.display_name ?? ''); }} /> Keep {merging.display_name} ({reviewStateLabel(merging.review_state)})</label>
                      </div>
                      <label>Name on the kept record<input required value={keptName} maxLength={200} onChange={(event) => setKeptName(event.target.value)} /></label>
                      <label>Why are these the same person?<textarea required value={mergeReason} maxLength={1000} onChange={(event) => setMergeReason(event.target.value)} placeholder="e.g. Same face on licence and CCTV; confirmed by officer" /></label>
                      <p className="person-matches__meta">Sightings, ID documents, vehicle links, flags and CCTV detections move to the kept record. The other name is kept as an alias. This is audit-logged and cannot be undone automatically.</p>
                      <div className="person-identity__inline">
                        <button type="submit" className="btn btn-sm btn-primary" disabled={!mergeReason.trim() || !keptName.trim()}>Merge records</button>
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => setMerging(null)}>Cancel</button>
                      </div>
                    </fieldset>
                  </form>
                )}
              </section>
            )}
            {!summary.can_review && <p className="person-matches__meta">Administrators approve ID evidence and merge duplicate records in Users → Identity records.</p>}
          </>
        )}
      </div>
    </div>
  );
};

export default PersonIdentityPanel;
