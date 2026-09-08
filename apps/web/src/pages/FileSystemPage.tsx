import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock3, Download, FileArchive, FileText, FolderOpen, Image, RefreshCw, Search, ShieldCheck, Video, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ImportSchemaPreview, parseCsvPreview, parseXlsxPreview, sha256Hex } from '../lib/importPreview';
import { supabase } from '../lib/supabase';
import './PageStyles.css';
import './FileSystemPage.css';

interface DocumentRow {
  id: string;
  attachment_id: string | null;
  storage_bucket: string;
  storage_object_ref: string | null;
  original_filename: string;
  mime_type: string;
  sha256: string | null;
  uploaded_by: string | null;
  source_channel: string;
  organization_id: string | null;
  current_scope: 'conversation_only' | 'tenant_reference' | 'tenant' | 'global_reference' | 'quarantined';
  created_at: string;
  updated_at: string;
}

interface DocumentVersion {
  id: string;
  version_label: string;
  effective_from: string | null;
  effective_to: string | null;
  extracted_text: string | null;
  extraction_confidence: number | null;
  ocr_required: boolean;
  metadata_json: Record<string, unknown>;
  created_at: string;
  document_classifications?: DocumentClassification[];
}

interface DocumentClassification {
  id: string;
  privacy_class: string;
  contains_pii: boolean;
  contains_operational_security: boolean;
  contains_financial_data: boolean;
  contains_legal_privilege: boolean;
  classifier_source: string;
  confidence: number | null;
  rationale: string | null;
  reviewed_at: string | null;
}

interface IntakeAttachment {
  id: string;
  file_name: string;
  file_type: string;
  file_size_bytes: number;
  processing_state: string;
  created_at: string;
}

interface ManifestPreview {
  batch_name: string;
  file_count: number;
  total_bytes: number;
  structured_data: number;
  quarantine: number;
  document: number;
  media: number;
  unresolved: number;
}

interface FileImportBatch {
  id: string;
  batch_name: string;
  source_file: string;
  parser: string;
  source_sha256: string | null;
  duplicate_of_batch_id: string | null;
  status: 'preview' | 'needs_review' | 'approved' | 'rejected' | 'applied' | 'failed';
  row_count: number;
  duplicate_count: number;
  unresolved_count: number;
  review_reason: string | null;
  reviewed_at: string | null;
  manifest_json: Record<string, unknown>;
  schema_json: { mappings?: Array<{ source: string; target: string; confidence: string }>; warnings?: string[]; headers?: string[]; sample_rows?: string[][] };
  created_at: string;
}

type FileFilter = 'all' | 'quarantined' | 'tenant_reference' | 'tenant' | 'global_reference';

const FILE_SPACES = [
  { key: 'all', label: 'All files' },
  { key: 'organisation', label: 'Organisation' },
  { key: 'contracts', label: 'Contracts' },
  { key: 'operations', label: 'Sites & operations' },
  { key: 'hr', label: 'HR & people' },
  { key: 'finance', label: 'Finance' },
  { key: 'evidence', label: 'Evidence' },
  { key: 'bob', label: 'Bob intake' },
] as const;

const SAMPLE_MANIFEST_PREVIEW: ManifestPreview = {
  batch_name: 'sample-data-2026-09-08',
  file_count: 5648,
  total_bytes: 8930000000,
  structured_data: 1842,
  quarantine: 632,
  document: 1490,
  media: 713,
  unresolved: 171,
};

const SAMPLE_IMPORT_PREVIEWS: ImportSchemaPreview[] = [
  {
    source_file: 'Vehicle Log (1).csv',
    parser: 'CSV / vehicle observations',
    row_count: 4396,
    duplicate_count: 12,
    date_range: '02 Jan 2026 - 31 Jan 2026',
    mappings: [
      { source: 'REGO', target: 'vehicle.registration', confidence: '99%' },
      { source: 'RecordedDate', target: 'observation.observed_at', confidence: '98%' },
      { source: 'Title', target: 'observation.site_name', confidence: '94%' },
    ],
    warnings: ['17 vehicle registrations need organisation matching', 'No canonical vehicle records will be written during preview'],
  },
  {
    source_file: 'Site Report By Vehicle.csv',
    parser: 'CSV / patrol movement events',
    row_count: 107,
    duplicate_count: 3,
    date_range: '22 Dec 2025 - 27 Dec 2025',
    mappings: [
      { source: 'Registration', target: 'vehicle.registration', confidence: '99%' },
      { source: 'EnteredTime / ExitTime', target: 'movement.event_time', confidence: '96%' },
      { source: 'Site', target: 'site.name', confidence: '91%' },
    ],
    warnings: ['6 site names need canonical location matching', 'Driver values remain unresolved until staff matching is approved'],
  },
];

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function fileIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return Image;
  if (mimeType.startsWith('video/')) return Video;
  if (mimeType.includes('pdf') || mimeType.includes('word') || mimeType.includes('sheet')) return FileText;
  return FileArchive;
}

function spaceFor(document: DocumentRow): string {
  const name = document.original_filename.toLowerCase();
  if (document.current_scope === 'quarantined') return 'bob';
  if (/agreement|contract|terms|proforma|supply/.test(name)) return 'contracts';
  if (/hr|discip|affidavit|coa|emergency|employment/.test(name)) return 'hr';
  if (/cost|invoice|expense|reimbursement|pay/.test(name)) return 'finance';
  if (/incident|linz|evidence|certificate|cctv|video/.test(name)) return 'evidence';
  if (/attendance|assignment|handout|patrol|site/.test(name)) return 'operations';
  return 'organisation';
}

function scopeLabel(scope: DocumentRow['current_scope']): string {
  return scope.replaceAll('_', ' ');
}

function intakeDisposition(attachment: IntakeAttachment): { allowed: boolean; reason?: string } {
  const fileName = attachment.file_name.toLowerCase();
  const extension = fileName.includes('.') ? `.${fileName.split('.').pop()}` : '';
  const blockedExtensions = new Set(['.apk', '.bin', '.crdownload', '.db', '.download', '.exe', '.iqy', '.lnk', '.mdb', '.url']);
  if (fileName.startsWith('~$')) return { allowed: false, reason: 'Office lock file' };
  if (blockedExtensions.has(extension)) return { allowed: false, reason: 'Unsupported or unsafe artifact' };
  if (!attachment.file_type || attachment.file_type === 'application/octet-stream') return { allowed: false, reason: 'Unknown file type' };
  return { allowed: true };
}

const FileSystemPage: React.FC = () => {
  const { profile, operatingOrganizationId } = useAuth();
  const navigate = useNavigate();
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [intakeAttachments, setIntakeAttachments] = useState<IntakeAttachment[]>([]);
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [space, setSpace] = useState<(typeof FILE_SPACES)[number]['key']>('all');
  const [scope, setScope] = useState<FileFilter>('all');
  const [loading, setLoading] = useState(true);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [uploadedImportPreview, setUploadedImportPreview] = useState<ImportSchemaPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [creatingBatch, setCreatingBatch] = useState(false);
  const [importPreviewIndex, setImportPreviewIndex] = useState(0);
  const [importBatches, setImportBatches] = useState<FileImportBatch[]>([]);
  const [batchStatus, setBatchStatus] = useState<'all' | FileImportBatch['status']>('all');
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [reviewReason, setReviewReason] = useState('');
  const [reviewingBatch, setReviewingBatch] = useState(false);

  const loadDocuments = useCallback(async () => {
    const organizationId = operatingOrganizationId ?? profile?.organizationId;
    if (!organizationId) return;
    setLoading(true);
    setError(null);
    const [{ data, error: loadError }, { data: intakeData, error: intakeError }, { data: batchData, error: batchError }] = await Promise.all([supabase
      .from('documents')
      .select('id,attachment_id,storage_bucket,storage_object_ref,original_filename,mime_type,sha256,uploaded_by,source_channel,organization_id,current_scope,created_at,updated_at')
      .or(`organization_id.eq.${organizationId},organization_id.is.null`)
      .order('updated_at', { ascending: false })
      .limit(250), supabase.from('bob_attachments').select('id,file_name,file_type,file_size_bytes,processing_state,created_at').eq('processing_state', 'pending').order('created_at', { ascending: false }).limit(50), supabase.from('file_import_batches').select('id,batch_name,source_file,parser,status,source_sha256,duplicate_of_batch_id,row_count,duplicate_count,unresolved_count,manifest_json,schema_json,created_at').order('created_at', { ascending: false }).limit(50)]);
    if (loadError || intakeError) setError(loadError?.message ?? intakeError?.message ?? 'Files could not be loaded.');
    else {
      const rows = (data as DocumentRow[]) ?? [];
      setDocuments(rows);
      setSelectedId((current) => current && rows.some((row) => row.id === current) ? current : rows[0]?.id ?? null);
      setIntakeAttachments((intakeData as IntakeAttachment[]) ?? []);
      const batches = (batchData as FileImportBatch[]) ?? [];
      setImportBatches(batches);
      setSelectedBatchId((current) => current && batches.some((batch) => batch.id === current) ? current : batches[0]?.id ?? null);
      if (batchError) setNotice('Review batch history is unavailable until the file import migration is deployed.');
    }
    setLoading(false);
  }, [operatingOrganizationId, profile?.organizationId]);

  const registerAttachment = async (attachment: IntakeAttachment) => {
    setNotice(null); setError(null);
    const { error: registerError } = await supabase.functions.invoke('bob-document-register', { body: { attachment_id: attachment.id } });
    if (registerError) setError(registerError.message);
    else { setNotice(`${attachment.file_name} registered into the Files workspace.`); await loadDocuments(); }
  };

  useEffect(() => { void loadDocuments(); }, [loadDocuments]);

  const visibleDocuments = useMemo(() => {
    const term = search.trim().toLowerCase();
    return documents.filter((document) => {
      const matchesSearch = !term || [document.original_filename, document.mime_type, document.source_channel, document.sha256].some((value) => value?.toLowerCase().includes(term));
      const matchesScope = scope === 'all' || document.current_scope === scope;
      const matchesSpace = space === 'all' || spaceFor(document) === space;
      return matchesSearch && matchesScope && matchesSpace;
    });
  }, [documents, scope, search, space]);

  const visibleBatches = useMemo(() => batchStatus === 'all' ? importBatches : importBatches.filter((batch) => batch.status === batchStatus), [batchStatus, importBatches]);
  const selectedBatch = importBatches.find((batch) => batch.id === selectedBatchId) ?? null;

  const selected = documents.find((document) => document.id === selectedId) ?? null;

  useEffect(() => {
    let active = true;
    const loadVersions = async () => {
      if (!selected) { setVersions([]); return; }
      setVersionsLoading(true);
      const { data, error: versionError } = await supabase
        .from('document_versions')
        .select('id,version_label,effective_from,effective_to,extracted_text,extraction_confidence,ocr_required,metadata_json,created_at,document_classifications(id,privacy_class,contains_pii,contains_operational_security,contains_financial_data,contains_legal_privilege,classifier_source,confidence,rationale,reviewed_at)')
        .eq('document_id', selected.id)
        .order('created_at', { ascending: false });
      if (!active) return;
      if (versionError) setError(versionError.message);
      else setVersions((data as DocumentVersion[]) ?? []);
      setVersionsLoading(false);
    };
    void loadVersions();
    return () => { active = false; };
  }, [selected]);

  const openFile = async () => {
    if (!selected?.storage_object_ref) {
      setNotice('This file has no storage object reference yet. Review the source record before opening it.');
      return;
    }
    setOpening(true);
    setNotice(null);
    const { data, error: signedError } = await supabase.storage.from(selected.storage_bucket).createSignedUrl(selected.storage_object_ref, 900);
    if (signedError || !data?.signedUrl) setError(signedError?.message ?? 'A signed file link could not be created.');
    else window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
    setOpening(false);
  };

  const previewImportFile = async (file: File) => {
    setPreviewError(null);
    const lowerName = file.name.toLowerCase();
    if (!lowerName.endsWith('.csv') && !lowerName.endsWith('.xlsx')) {
      setPreviewError('Preview supports CSV and XLSX files. Other formats remain staged for their dedicated parser.');
      return;
    }
    try {
      const bytes = await file.arrayBuffer();
      const preview = lowerName.endsWith('.xlsx') ? await parseXlsxPreview(bytes, file.name) : parseCsvPreview(new TextDecoder().decode(bytes), file.name);
      setUploadedImportPreview({ ...preview, source_sha256: await sha256Hex(bytes) });
    } catch {
      setPreviewError('The CSV could not be parsed safely for preview.');
    }
  };

  const activeImportPreview = uploadedImportPreview ?? SAMPLE_IMPORT_PREVIEWS[importPreviewIndex];

  const createReviewBatch = async () => {
    const organizationId = operatingOrganizationId ?? profile?.organizationId;
    if (!organizationId) {
      setPreviewError('An operating organisation is required before a review batch can be created.');
      return;
    }
    setCreatingBatch(true);
    setPreviewError(null);
    const { data, error: batchError } = await supabase.rpc('create_file_import_batch', {
      p_batch_name: `preview-${activeImportPreview.source_file}`,
      p_source_file: activeImportPreview.source_file,
      p_source_sha256: activeImportPreview.source_sha256 ?? null,
      p_parser: activeImportPreview.parser,
      p_manifest_json: { staged: true, source_file: activeImportPreview.source_file, date_range: activeImportPreview.date_range },
      p_schema_json: { mappings: activeImportPreview.mappings, warnings: activeImportPreview.warnings, headers: activeImportPreview.headers, sample_rows: activeImportPreview.sample_rows },
      p_row_count: activeImportPreview.row_count,
      p_duplicate_count: activeImportPreview.duplicate_count,
      p_unresolved_count: activeImportPreview.warnings.length,
      p_organization_id: organizationId,
    });
    if (batchError) setPreviewError(batchError.message);
    else setNotice(`Review batch ${data?.id ? `${data.id.slice(0, 8)} ` : ''}created. No canonical records were changed.`);
    setCreatingBatch(false);
  };

  const reviewBatch = async (decision: 'approved' | 'rejected') => {
    if (!selectedBatch || !reviewReason.trim()) {
      setPreviewError('A review reason is required before approving or rejecting a batch.');
      return;
    }
    setReviewingBatch(true);
    setPreviewError(null);
    const { data, error: reviewError } = await supabase.rpc('review_file_import_batch', { p_batch_id: selectedBatch.id, p_decision: decision, p_reason: reviewReason.trim() });
    if (reviewError) setPreviewError(reviewError.message);
    else {
      setImportBatches((current) => current.map((batch) => batch.id === selectedBatch.id ? data as FileImportBatch : batch));
      setReviewReason('');
      setNotice(`Batch ${decision}. No canonical records were changed.`);
    }
    setReviewingBatch(false);
  };

  return <div className="file-system-page">
    <header className="file-system-header"><div><span>Organisation workspace / Files</span><h1>File system</h1><p>Find source documents, inspect provenance, and review extracted versions before anything becomes an authoritative record.</p></div><div className="file-system-header-actions"><button type="button" onClick={() => navigate('/admin/approvals')}><ShieldCheck size={17} />Review promotions</button><button type="button" onClick={() => void loadDocuments()} disabled={loading}><RefreshCw size={17} className={loading ? 'is-spinning' : ''} />Refresh</button></div></header>
    {error && <div className="file-system-message is-error" role="alert"><span>{error}</span><button type="button" title="Dismiss" onClick={() => setError(null)}><X size={16} /></button></div>}
    {notice && <div className="file-system-message is-success" role="status"><ShieldCheck size={16} /><span>{notice}</span><button type="button" title="Dismiss" onClick={() => setNotice(null)}><X size={16} /></button></div>}
    <section className="file-system-intake" aria-label="Manifest-based import preview">
      <div>
        <span>Import preview</span>
        <h2>Batch manifest: {SAMPLE_MANIFEST_PREVIEW.batch_name}</h2>
        <p>Staged sample data is previewed before any promotion. The manifest separates structured_data, quarantine, media, and unresolved references so review remains explicit.</p>
      </div>
      <div className="file-system-manifest-grid">
        <article>
          <strong>{SAMPLE_MANIFEST_PREVIEW.file_count.toLocaleString()}</strong>
          <small>Files in batch</small>
        </article>
        <article>
          <strong>{formatBytes(SAMPLE_MANIFEST_PREVIEW.total_bytes)}</strong>
          <small>Total bytes</small>
        </article>
        <article>
          <strong>{SAMPLE_MANIFEST_PREVIEW.structured_data.toLocaleString()}</strong>
          <small>structured_data</small>
        </article>
        <article>
          <strong>{SAMPLE_MANIFEST_PREVIEW.quarantine.toLocaleString()}</strong>
          <small>quarantine</small>
        </article>
        <article>
          <strong>{SAMPLE_MANIFEST_PREVIEW.document.toLocaleString()}</strong>
          <small>document</small>
        </article>
        <article>
          <strong>{SAMPLE_MANIFEST_PREVIEW.media.toLocaleString()}</strong>
          <small>media</small>
        </article>
        <article>
          <strong>{SAMPLE_MANIFEST_PREVIEW.unresolved.toLocaleString()}</strong>
          <small>unresolved</small>
        </article>
      </div>
      <div className="file-system-import-switcher" role="tablist" aria-label="Import batch previews">
        {SAMPLE_IMPORT_PREVIEWS.map((preview, index) => <button type="button" role="tab" aria-selected={!uploadedImportPreview && importPreviewIndex === index} className={!uploadedImportPreview && importPreviewIndex === index ? 'is-active' : ''} key={preview.source_file} onClick={() => { setUploadedImportPreview(null); setImportPreviewIndex(index); }}>{preview.source_file}</button>)}
        <label className="file-system-import-upload">Preview CSV/XLSX<input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { const file = event.target.files?.[0]; if (file) void previewImportFile(file); event.currentTarget.value = ''; }} /></label>
      </div>
      <div className="file-system-import-detail">
        <strong className="file-system-import-source">{activeImportPreview.source_file}</strong>
        <small className="file-system-import-hash">SHA-256: {activeImportPreview.source_sha256 ?? 'Generated when a local source is selected'}</small>
        {previewError && <p className="file-system-import-warning" role="alert">{previewError}</p>}
        <button type="button" className="file-system-import-create" onClick={() => void createReviewBatch()} disabled={creatingBatch}>{creatingBatch ? 'Creating review batch' : 'Create review batch'}</button>
        <div className="file-system-import-facts"><div><small>Parser</small><strong>{activeImportPreview.parser}</strong></div><div><small>Rows</small><strong>{activeImportPreview.row_count.toLocaleString()}</strong></div><div><small>duplicate rows</small><strong>{activeImportPreview.duplicate_count}</strong></div><div><small>Date range</small><strong>{activeImportPreview.date_range}</strong></div></div>
        {activeImportPreview.headers && activeImportPreview.sample_rows && <div className="file-system-import-sample"><span>Sample rows, first 5 only</span><div className="file-system-import-table-wrap"><table><thead><tr>{activeImportPreview.headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{activeImportPreview.sample_rows.map((row, rowIndex) => <tr key={`sample-${rowIndex}`}>{activeImportPreview.headers?.map((header, columnIndex) => <td key={`${header}-${rowIndex}`}>{row[columnIndex] || '-'}</td>)}</tr>)}</tbody></table></div></div>}
        <div className="file-system-import-columns"><div><span>Column mapping</span>{activeImportPreview.mappings.map((mapping) => <div className="file-system-import-mapping" key={`${mapping.source}-${mapping.target}`}><strong>{mapping.source}</strong><span>to {mapping.target}</span><small>{mapping.confidence}</small></div>)}</div><div><span>Review warnings</span>{activeImportPreview.warnings.map((warning) => <p key={warning}>{warning}</p>)}<p className="file-system-import-warning">{activeImportPreview.warnings.length} unresolved references</p></div></div>
      </div>
    </section>
    <section className="file-system-batches" aria-label="Import batch history">
      <div className="file-system-batches-heading"><div><span>Review history</span><h2>Import batches</h2></div><select aria-label="Import batch status" value={batchStatus} onChange={(event) => setBatchStatus(event.target.value as typeof batchStatus)}><option value="all">All statuses</option><option value="preview">Preview</option><option value="needs_review">Needs review</option><option value="approved">Approved</option><option value="applied">Applied</option><option value="rejected">Rejected</option><option value="failed">Failed</option></select></div>
      {visibleBatches.length === 0 ? <p className="file-system-muted">No persisted review batches match this status.</p> : <div className="file-system-batch-grid">{visibleBatches.map((batch) => <button type="button" key={batch.id} className={selectedBatchId === batch.id ? 'is-selected' : ''} onClick={() => setSelectedBatchId(batch.id)}><strong>{batch.source_file}</strong><span>{batch.status.replaceAll('_', ' ')} · {batch.row_count.toLocaleString()} rows</span><small>{batch.duplicate_of_batch_id ? 'Duplicate source linked' : 'Original source'} · {batch.duplicate_count} row duplicates · {batch.unresolved_count} unresolved</small></button>)}</div>}
      {selectedBatch && <article className="file-system-batch-detail"><div><strong>{selectedBatch.batch_name}</strong><span>{selectedBatch.parser} · {selectedBatch.status.replaceAll('_', ' ')}</span><small>{selectedBatch.source_sha256 ? `SHA-256 ${selectedBatch.source_sha256}` : 'Source hash unavailable'}</small>{selectedBatch.duplicate_of_batch_id && <small>Duplicate of batch {selectedBatch.duplicate_of_batch_id.slice(0, 8)}</small>}{selectedBatch.review_reason && <small>Reason: {selectedBatch.review_reason}</small>}</div><div><span>Mappings</span>{(selectedBatch.schema_json.mappings ?? []).map((mapping) => <small key={`${mapping.source}-${mapping.target}`}>{mapping.source} to {mapping.target} ({mapping.confidence})</small>)}</div><div><span>Warnings</span>{(selectedBatch.schema_json.warnings ?? []).map((warning) => <small key={warning}>{warning}</small>)}</div>{selectedBatch.schema_json.headers && selectedBatch.schema_json.sample_rows && <div className="file-system-batch-sample"><span>Sample rows</span>{selectedBatch.schema_json.sample_rows.map((row, rowIndex) => <small key={`batch-sample-${rowIndex}`}>{row.join(' · ')}</small>)}</div>}{(selectedBatch.status === 'preview' || selectedBatch.status === 'needs_review') && <div className="file-system-batch-review"><label htmlFor="batch-review-reason">Review reason</label><textarea id="batch-review-reason" rows={2} value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} placeholder="Explain the review decision" /><div><button type="button" onClick={() => void reviewBatch('approved')} disabled={reviewingBatch}>Approve batch</button><button type="button" onClick={() => void reviewBatch('rejected')} disabled={reviewingBatch}>Reject batch</button></div></div>}</article>}
    </section>
    {intakeAttachments.length > 0 && <section className="file-system-intake" aria-label="Bob intake waiting registration"><div><span>Bob intake</span><h2>Files waiting registration</h2><p>These uploads are not yet canonical Files records. Registration extracts, hashes, classifies, and preserves upload provenance.</p></div><div>{intakeAttachments.map((attachment) => { const disposition = intakeDisposition(attachment); return <article key={attachment.id}><strong>{attachment.file_name}</strong><small>{attachment.file_type} · {Math.round(attachment.file_size_bytes / 1024)} KB · {new Date(attachment.created_at).toLocaleDateString('en-NZ')}</small>{disposition.allowed ? <button type="button" onClick={() => void registerAttachment(attachment)}>Register in Files</button> : <span className="file-system-quarantine">Quarantined: {disposition.reason}</span>}</article>; })}</div></section>}
    <section className="file-system-spaces" aria-label="File spaces">{FILE_SPACES.map((item) => <button type="button" key={item.key} className={space === item.key ? 'is-active' : ''} onClick={() => setSpace(item.key)}><FolderOpen size={16} /><span>{item.label}</span></button>)}</section>
    <div className="file-system-toolbar"><label><Search size={16} /><input type="search" placeholder="Search filenames, type, source, or hash" value={search} onChange={(event) => setSearch(event.target.value)} /></label><select aria-label="File status" value={scope} onChange={(event) => setScope(event.target.value as FileFilter)}><option value="all">All statuses</option><option value="quarantined">Quarantined</option><option value="tenant_reference">Reference</option><option value="tenant">Tenant files</option><option value="global_reference">Global reference</option></select></div>
    <div className="file-system-layout"><section className="file-system-list" aria-label="Files"><div className="file-system-list-heading"><div><span>Permitted records</span><h2>{visibleDocuments.length} files</h2></div><small>{documents.length} loaded</small></div>{loading ? <div className="file-system-empty"><RefreshCw size={20} className="is-spinning" />Loading files</div> : visibleDocuments.length === 0 ? <div className="file-system-empty"><FileArchive size={22} />No files match this view</div> : <div className="file-system-records">{visibleDocuments.map((document) => { const Icon = fileIcon(document.mime_type); return <button type="button" key={document.id} className={selectedId === document.id ? 'is-selected' : ''} onClick={() => setSelectedId(document.id)}><span className="file-system-record-icon"><Icon size={17} /></span><span><strong>{document.original_filename}</strong><small>{spaceFor(document)} · {scopeLabel(document.current_scope)}</small></span><time dateTime={document.updated_at}>{new Date(document.updated_at).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })}</time></button>; })}</div>}</section>
    <aside className="file-system-detail" aria-label="File details">{!selected ? <div className="file-system-empty"><FileText size={22} />Select a file to inspect</div> : <><div className="file-system-detail-heading"><div><span>{spaceFor(selected)}</span><h2>{selected.original_filename}</h2><small>{selected.mime_type} · {scopeLabel(selected.current_scope)}</small></div><button type="button" onClick={() => void openFile()} disabled={opening || !selected.storage_object_ref} title="Open source file"><Download size={17} />{opening ? 'Opening' : 'Open source'}</button></div><dl className="file-system-facts"><div><dt>Source</dt><dd>{selected.source_channel.replaceAll('_', ' ')}</dd></div><div><dt>Storage</dt><dd>{selected.storage_bucket}</dd></div><div><dt>Uploaded</dt><dd>{new Date(selected.created_at).toLocaleString('en-NZ')}</dd></div><div><dt>SHA-256</dt><dd>{selected.sha256 ?? 'Not recorded'}</dd></div></dl><section className="file-system-section"><div className="file-system-section-heading"><div><span>Versions</span><h3>{versions.length} extracted versions</h3></div>{versionsLoading && <RefreshCw size={15} className="is-spinning" />}</div>{versions.length === 0 ? <p className="file-system-muted">No extracted version is available yet. This source remains reviewable without treating it as authoritative.</p> : <div className="file-system-versions">{versions.map((version) => <article key={version.id}><strong>{version.version_label}</strong><span>{version.extraction_confidence === null ? 'Confidence unavailable' : `${Math.round(version.extraction_confidence * 100)}% extraction confidence`}{version.ocr_required ? ' · OCR required' : ''}</span><small>{version.extracted_text?.slice(0, 280) || 'No extracted text preview.'}</small></article>)}</div>}</section><section className="file-system-provenance"><Clock3 size={15} /><span>Promotion is deliberately separate from file storage. Bob can prepare a review, but a human must approve any CRM, HR, finance, evidence, or investigation change.</span></section></>}</aside></div>
  </div>;
};

export default FileSystemPage;
