import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock3, Download, FileArchive, FileText, FolderOpen, Image, RefreshCw, Search, ShieldCheck, Video, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
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

  const loadDocuments = useCallback(async () => {
    const organizationId = operatingOrganizationId ?? profile?.organizationId;
    if (!organizationId) return;
    setLoading(true);
    setError(null);
    const [{ data, error: loadError }, { data: intakeData, error: intakeError }] = await Promise.all([supabase
      .from('documents')
      .select('id,attachment_id,storage_bucket,storage_object_ref,original_filename,mime_type,sha256,uploaded_by,source_channel,organization_id,current_scope,created_at,updated_at')
      .or(`organization_id.eq.${organizationId},organization_id.is.null`)
      .order('updated_at', { ascending: false })
      .limit(250), supabase.from('bob_attachments').select('id,file_name,file_type,file_size_bytes,processing_state,created_at').eq('processing_state', 'pending').order('created_at', { ascending: false }).limit(50)]);
    if (loadError || intakeError) setError(loadError?.message ?? intakeError?.message ?? 'Files could not be loaded.');
    else {
      const rows = (data as DocumentRow[]) ?? [];
      setDocuments(rows);
      setSelectedId((current) => current && rows.some((row) => row.id === current) ? current : rows[0]?.id ?? null);
      setIntakeAttachments((intakeData as IntakeAttachment[]) ?? []);
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

  return <div className="file-system-page">
    <header className="file-system-header"><div><span>Organisation workspace / Files</span><h1>File system</h1><p>Find source documents, inspect provenance, and review extracted versions before anything becomes an authoritative record.</p></div><div className="file-system-header-actions"><button type="button" onClick={() => navigate('/admin/approvals')}><ShieldCheck size={17} />Review promotions</button><button type="button" onClick={() => void loadDocuments()} disabled={loading}><RefreshCw size={17} className={loading ? 'is-spinning' : ''} />Refresh</button></div></header>
    {error && <div className="file-system-message is-error" role="alert"><span>{error}</span><button type="button" title="Dismiss" onClick={() => setError(null)}><X size={16} /></button></div>}
    {notice && <div className="file-system-message is-success" role="status"><ShieldCheck size={16} /><span>{notice}</span><button type="button" title="Dismiss" onClick={() => setNotice(null)}><X size={16} /></button></div>}
    {intakeAttachments.length > 0 && <section className="file-system-intake" aria-label="Bob intake waiting registration"><div><span>Bob intake</span><h2>Files waiting registration</h2><p>These uploads are not yet canonical Files records. Registration extracts, hashes, classifies, and preserves upload provenance.</p></div><div>{intakeAttachments.map((attachment) => { const disposition = intakeDisposition(attachment); return <article key={attachment.id}><strong>{attachment.file_name}</strong><small>{attachment.file_type} · {Math.round(attachment.file_size_bytes / 1024)} KB · {new Date(attachment.created_at).toLocaleDateString('en-NZ')}</small>{disposition.allowed ? <button type="button" onClick={() => void registerAttachment(attachment)}>Register in Files</button> : <span className="file-system-quarantine">Quarantined: {disposition.reason}</span>}</article>; })}</div></section>}
    <section className="file-system-spaces" aria-label="File spaces">{FILE_SPACES.map((item) => <button type="button" key={item.key} className={space === item.key ? 'is-active' : ''} onClick={() => setSpace(item.key)}><FolderOpen size={16} /><span>{item.label}</span></button>)}</section>
    <div className="file-system-toolbar"><label><Search size={16} /><input type="search" placeholder="Search filenames, type, source, or hash" value={search} onChange={(event) => setSearch(event.target.value)} /></label><select aria-label="File status" value={scope} onChange={(event) => setScope(event.target.value as FileFilter)}><option value="all">All statuses</option><option value="quarantined">Quarantined</option><option value="tenant_reference">Reference</option><option value="tenant">Tenant files</option><option value="global_reference">Global reference</option></select></div>
    <div className="file-system-layout"><section className="file-system-list" aria-label="Files"><div className="file-system-list-heading"><div><span>Permitted records</span><h2>{visibleDocuments.length} files</h2></div><small>{documents.length} loaded</small></div>{loading ? <div className="file-system-empty"><RefreshCw size={20} className="is-spinning" />Loading files</div> : visibleDocuments.length === 0 ? <div className="file-system-empty"><FileArchive size={22} />No files match this view</div> : <div className="file-system-records">{visibleDocuments.map((document) => { const Icon = fileIcon(document.mime_type); return <button type="button" key={document.id} className={selectedId === document.id ? 'is-selected' : ''} onClick={() => setSelectedId(document.id)}><span className="file-system-record-icon"><Icon size={17} /></span><span><strong>{document.original_filename}</strong><small>{spaceFor(document)} · {scopeLabel(document.current_scope)}</small></span><time dateTime={document.updated_at}>{new Date(document.updated_at).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })}</time></button>; })}</div>}</section>
    <aside className="file-system-detail" aria-label="File details">{!selected ? <div className="file-system-empty"><FileText size={22} />Select a file to inspect</div> : <><div className="file-system-detail-heading"><div><span>{spaceFor(selected)}</span><h2>{selected.original_filename}</h2><small>{selected.mime_type} · {scopeLabel(selected.current_scope)}</small></div><button type="button" onClick={() => void openFile()} disabled={opening || !selected.storage_object_ref} title="Open source file"><Download size={17} />{opening ? 'Opening' : 'Open source'}</button></div><dl className="file-system-facts"><div><dt>Source</dt><dd>{selected.source_channel.replaceAll('_', ' ')}</dd></div><div><dt>Storage</dt><dd>{selected.storage_bucket}</dd></div><div><dt>Uploaded</dt><dd>{new Date(selected.created_at).toLocaleString('en-NZ')}</dd></div><div><dt>SHA-256</dt><dd>{selected.sha256 ?? 'Not recorded'}</dd></div></dl><section className="file-system-section"><div className="file-system-section-heading"><div><span>Versions</span><h3>{versions.length} extracted versions</h3></div>{versionsLoading && <RefreshCw size={15} className="is-spinning" />}</div>{versions.length === 0 ? <p className="file-system-muted">No extracted version is available yet. This source remains reviewable without treating it as authoritative.</p> : <div className="file-system-versions">{versions.map((version) => <article key={version.id}><strong>{version.version_label}</strong><span>{version.extraction_confidence === null ? 'Confidence unavailable' : `${Math.round(version.extraction_confidence * 100)}% extraction confidence`}{version.ocr_required ? ' · OCR required' : ''}</span><small>{version.extracted_text?.slice(0, 280) || 'No extracted text preview.'}</small></article>)}</div>}</section><section className="file-system-provenance"><Clock3 size={15} /><span>Promotion is deliberately separate from file storage. Bob can prepare a review, but a human must approve any CRM, HR, finance, evidence, or investigation change.</span></section></>}</aside></div>
  </div>;
};

export default FileSystemPage;
