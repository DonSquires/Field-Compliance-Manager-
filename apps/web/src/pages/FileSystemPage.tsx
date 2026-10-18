import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock3, Download, FileArchive, FileInput, FileText, FolderPlus, Image, RefreshCw, Search, ShieldCheck, Upload, Video, X } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { FileExplorerTree, type FileExplorerTreeData } from '../components/FileExplorerTree';
import { GeneratedArtifactActions } from '../components/GeneratedArtifactActions';
import { useAuth } from '../context/AuthContext';
import { ImportSchemaPreview, parseCsvPreview, parseJsonPreview, parseXlsxPreview, sha256Hex } from '../lib/importPreview';
import { supabase } from '../lib/supabase';
import { ShellLayout } from '../layouts/ShellLayout';
import './PageStyles.css';
import './FileSystemPage.css';
import './FileSystemResponsive.css';

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
  malformed_row_count?: number;
  review_reason: string | null;
  reviewed_at: string | null;
  manifest_json: Record<string, unknown>;
  schema_json: { mappings?: Array<{ source: string; target: string; confidence: string }>; warnings?: string[]; headers?: string[]; sample_rows?: string[][] };
  created_at: string;
}

interface FileImportMappingReview {
  source_column: string;
  target_entity: string | null;
  target_field: string | null;
  decision: 'proposed' | 'confirmed' | 'rejected';
  review_reason: string | null;
}

interface FileImportRowProposal {
  id: string;
  source_record_key: string;
  source_row_number: number | null;
  target_type: string;
  proposed_payload: Record<string, unknown>;
  source_values: Record<string, unknown>;
  confidence: number | null;
  status: 'proposed' | 'approved' | 'rejected' | 'applied' | 'failed';
  review_reason: string | null;
  applied_target_id: string | null;
  reviewed_at: string | null;
}

interface GeneratedOutputRow {
  id: string;
  document_id: string;
  document_version_id: string;
  output_format: string;
  status: string;
  mime_type: string | null;
  renderer_version: string | null;
  sha256: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
  requested_by: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  generated_at: string | null;
  documents?: { original_filename: string; source_channel: string; current_scope: string } | Array<{ original_filename: string; source_channel: string; current_scope: string }> | null;
  document_versions?: { version_label: string; metadata_json: Record<string, unknown> } | Array<{ version_label: string; metadata_json: Record<string, unknown> }> | null;
}

interface NoticeArtifactRow {
  id: string;
  kind: 'notice_to_vacate' | 'infringement';
  label: string;
  notice_number: string | null;
  plate_number: string;
  status: string;
  issued_at: string;
  storage_path: string | null;
}

interface DocumentSourceRun {
  id: string;
  status: 'queued' | 'running' | 'cancel_requested' | 'cancelled' | 'completed' | 'failed';
  phase: string;
  discovered_count: number;
  hashed_count: number;
  duplicate_count: number;
  supported_count: number;
  partial_count: number;
  gap_count: number;
  excluded_count: number;
  quarantined_count: number;
  failed_count: number;
  requested_at: string;
  heartbeat_at: string | null;
  completed_at: string | null;
  error_detail_redacted: string | null;
  document_reference_sources?: { label: string } | Array<{ label: string }> | null;
}

type FileFilter = 'all' | 'quarantined' | 'tenant_reference' | 'tenant' | 'global_reference';
type OutputStatusFilter = 'all' | 'requested' | 'generating' | 'ready' | 'failed' | 'revoked';
type OutputFormatFilter = 'all' | 'pdf' | 'print' | 'docx';

const EMPTY_FILE_TREE: FileExplorerTreeData = { organization: null, spaces: [], folders: [], placements: [] };

function fileIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return Image;
  if (mimeType.startsWith('video/')) return Video;
  if (mimeType.includes('pdf') || mimeType.includes('word') || mimeType.includes('sheet')) return FileText;
  return FileArchive;
}

function scopeLabel(scope: DocumentRow['current_scope']): string {
  return scope.replaceAll('_', ' ');
}

function outputLabel(format: string): string {
  if (format === 'docx') return 'DOCX';
  if (format === 'print') return 'Print PDF';
  return format.toUpperCase();
}

function relationOne<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function outputTitle(output: GeneratedOutputRow): string {
  const version = relationOne(output.document_versions);
  const document = relationOne(output.documents);
  const metadataTitle = version?.metadata_json?.title;
  if (typeof metadataTitle === 'string' && metadataTitle.trim()) return metadataTitle;
  return document?.original_filename ?? `${outputLabel(output.output_format)} output`;
}

function artifactFileName(title: string, extension: string): string {
  const safeTitle = title.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'generated-document';
  return `${safeTitle}.${extension}`;
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
  const [searchParams] = useSearchParams();
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [intakeAttachments, setIntakeAttachments] = useState<IntakeAttachment[]>([]);
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [fileTree, setFileTree] = useState<FileExplorerTreeData>(EMPTY_FILE_TREE);
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [folderRequestId, setFolderRequestId] = useState(() => crypto.randomUUID());
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [moveDestination, setMoveDestination] = useState('');
  const [moveRequestId, setMoveRequestId] = useState(() => crypto.randomUUID());
  const [organizing, setOrganizing] = useState(false);
  const [scope, setScope] = useState<FileFilter>('all');
  const [loading, setLoading] = useState(true);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [uploadedImportPreview, setUploadedImportPreview] = useState<ImportSchemaPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [creatingBatch, setCreatingBatch] = useState(false);
  const [importBatches, setImportBatches] = useState<FileImportBatch[]>([]);
  const [batchStatus, setBatchStatus] = useState<'all' | FileImportBatch['status']>('all');
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [reviewReason, setReviewReason] = useState('');
  const [reviewingBatch, setReviewingBatch] = useState(false);
  const [mappingReviews, setMappingReviews] = useState<FileImportMappingReview[]>([]);
  const [mappingDrafts, setMappingDrafts] = useState<Record<string, { targetEntity: string; targetField: string; decision: FileImportMappingReview['decision']; reason: string }>>({});
  const [savingMapping, setSavingMapping] = useState<string | null>(null);
  const [rowProposals, setRowProposals] = useState<FileImportRowProposal[]>([]);
  const [rowProposalReasons, setRowProposalReasons] = useState<Record<string, string>>({});
  const [reviewingRowProposal, setReviewingRowProposal] = useState<string | null>(null);
  const [financeImportAction, setFinanceImportAction] = useState<'mappings' | 'review' | 'apply' | null>(null);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [generatedOutputs, setGeneratedOutputs] = useState<GeneratedOutputRow[]>([]);
  const [noticeArtifacts, setNoticeArtifacts] = useState<NoticeArtifactRow[]>([]);
  const [documentSourceRuns, setDocumentSourceRuns] = useState<DocumentSourceRun[]>([]);
  const [documentSourceAction, setDocumentSourceAction] = useState(false);
  const [outputStatus, setOutputStatus] = useState<OutputStatusFilter>('all');
  const [outputFormat, setOutputFormat] = useState<OutputFormatFilter>('all');
  const organizationId = operatingOrganizationId ?? profile?.organizationId ?? null;
  const canManageFolders = ['grand_master', 'master', 'admin'].includes(profile?.role ?? '');

  const loadDocuments = useCallback(async () => {
    const organizationId = operatingOrganizationId ?? profile?.organizationId;
    if (!organizationId) {
      setError('An active organisation is required before loading files.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const [{ data, error: loadError }, { data: intakeData, error: intakeError }, { data: batchData, error: batchError }, { data: outputData, error: outputError }, { data: vacateData, error: vacateError }, { data: infringementData, error: infringementError }, { data: sourceRunData, error: sourceRunError }, { data: treeData, error: treeError }] = await Promise.all([
      supabase.from('documents').select('id,attachment_id,storage_bucket,storage_object_ref,original_filename,mime_type,sha256,uploaded_by,source_channel,organization_id,current_scope,created_at,updated_at').or(`organization_id.eq.${organizationId},organization_id.is.null`).order('updated_at', { ascending: false }).limit(250),
      supabase.from('bob_attachments').select('id,file_name,file_type,file_size_bytes,processing_state,created_at').eq('processing_state', 'pending').order('created_at', { ascending: false }).limit(50),
      supabase.from('file_import_batches').select('id,batch_name,source_file,parser,status,source_sha256,duplicate_of_batch_id,row_count,duplicate_count,unresolved_count,manifest_json,schema_json,created_at').order('created_at', { ascending: false }).limit(50),
      supabase.from('bob_generated_document_outputs').select('id,document_id,document_version_id,output_format,status,mime_type,renderer_version,sha256,storage_bucket,storage_path,requested_by,approved_by,approved_at,created_at,generated_at,documents(original_filename,source_channel,current_scope),document_versions(version_label,metadata_json)').eq('organization_id', organizationId).order('created_at', { ascending: false }).limit(100),
      supabase.from('notices_to_vacate').select('id,plate_number,status,issued_at,pdf_url').eq('organization_id', organizationId).order('issued_at', { ascending: false }).limit(100),
      supabase.from('infringement_notices').select('id,notice_number,plate_number,status,issued_at,pdf_url').eq('organization_id', organizationId).order('issued_at', { ascending: false }).limit(100),
      supabase.from('document_source_ingestion_runs').select('id,status,phase,discovered_count,hashed_count,duplicate_count,supported_count,partial_count,gap_count,excluded_count,quarantined_count,failed_count,requested_at,heartbeat_at,completed_at,error_detail_redacted,document_reference_sources(label)').eq('organization_id', organizationId).order('requested_at', { ascending: false }).limit(5),
      supabase.rpc('get_file_explorer_tree', { p_organization_id: organizationId }),
    ]);
    if (loadError || intakeError || outputError || vacateError || infringementError || treeError) setError(loadError?.message ?? intakeError?.message ?? outputError?.message ?? vacateError?.message ?? infringementError?.message ?? treeError?.message ?? 'Files could not be loaded.');
    else {
      const rows = (data as DocumentRow[]) ?? [];
      setDocuments(rows);
      setSelectedId((current) => current && rows.some((row) => row.id === current) ? current : rows[0]?.id ?? null);
      setIntakeAttachments((intakeData as IntakeAttachment[]) ?? []);
      const batches = (batchData as FileImportBatch[]) ?? [];
      setImportBatches(batches);
      setSelectedBatchId((current) => current && batches.some((batch) => batch.id === current) ? current : batches[0]?.id ?? null);
      setGeneratedOutputs((outputData as GeneratedOutputRow[]) ?? []);
      setDocumentSourceRuns((sourceRunData as DocumentSourceRun[]) ?? []);
      const nextTree = (treeData as FileExplorerTreeData | null) ?? EMPTY_FILE_TREE;
      setFileTree(nextTree);
      setSelectedSpaceId((current) => current && nextTree.spaces.some((item) => item.id === current) ? current : null);
      setSelectedFolderId((current) => current && nextTree.folders.some((item) => item.id === current) ? current : null);
      setNoticeArtifacts([
        ...((vacateData as Array<{ id: string; plate_number: string; status: string; issued_at: string; pdf_url: string | null }> | null) ?? []).map((notice) => ({ ...notice, kind: 'notice_to_vacate' as const, label: 'Notice to vacate', notice_number: null, storage_path: notice.pdf_url })),
        ...((infringementData as Array<{ id: string; notice_number: string; plate_number: string; status: string; issued_at: string; pdf_url: string | null }> | null) ?? []).map((notice) => ({ ...notice, kind: 'infringement' as const, label: 'Infringement notice', storage_path: notice.pdf_url })),
      ].sort((left, right) => right.issued_at.localeCompare(left.issued_at)));
      if (batchError || sourceRunError) setNotice('Some import or source-inventory history is unavailable until its migration is deployed.');
    }
    setLoading(false);
  }, [operatingOrganizationId, profile?.organizationId]);

  const requestDocumentSourceAction = async (action: 'start' | 'cancel', runId?: string) => {
    setDocumentSourceAction(true); setError(null); setNotice(null);
    const { data, error: actionError } = await supabase.functions.invoke('bob-document-source-ingestion', {
      body: { action, run_id: runId },
    });
    if (actionError) setError(actionError.message);
    else if ((data as { error?: string } | null)?.error) setError((data as { error: string }).error);
    else setNotice(action === 'start' ? 'Read-only document source inventory requested.' : 'Document source inventory cancellation requested.');
    setDocumentSourceAction(false);
    await loadDocuments();
  };

  const registerAttachment = async (attachment: IntakeAttachment) => {
    setNotice(null); setError(null);
    const { data: registration, error: registerError } = await supabase.functions.invoke('bob-document-register', { body: { attachment_id: attachment.id } });
    if (registerError) setError(registerError.message);
    else {
      const documentId = (registration as { document_id?: string } | null)?.document_id;
      if (documentId && organizationId && selectedSpaceId && canManageFolders) {
        const { error: placementError } = await supabase.rpc('move_document_to_folder', { p_organization_id: organizationId, p_document_id: documentId, p_space_id: selectedSpaceId, p_folder_id: selectedFolderId, p_client_request_id: crypto.randomUUID() });
        if (placementError) setError(`File registered in Unfiled, but could not be moved here: ${placementError.message}`);
      }
      setNotice(`${attachment.file_name} registered into the Files workspace.`); await loadDocuments();
    }
  };

  const uploadHumanIntakeFile = async (file: File) => {
    const organizationId = operatingOrganizationId ?? profile?.organizationId;
    if (!organizationId || !profile) { setError('An active organisation is required before uploading a source file.'); return; }
    setUploadingFile(true); setError(null); setNotice(null);
    const attachmentId = crypto.randomUUID();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-180);
    const storagePath = `org/${organizationId}/bob/files/${attachmentId}-${safeName}`;
    const { error: uploadError } = await supabase.storage.from('bob-uploads').upload(storagePath, file, { contentType: file.type || 'application/octet-stream', upsert: false });
    if (uploadError) { setError(`Source upload failed: ${uploadError.message}`); setUploadingFile(false); return; }
    const { data: existingConversation, error: conversationLookupError } = await supabase.from('bob_conversations').select('id').eq('organization_id', organizationId).eq('user_id', profile.id).eq('module_key', 'operations').order('updated_at', { ascending: false }).limit(1).maybeSingle();
    if (conversationLookupError) { await supabase.storage.from('bob-uploads').remove([storagePath]); setError(`Source conversation could not be loaded: ${conversationLookupError.message}`); setUploadingFile(false); return; }
    let conversationId = existingConversation?.id ?? null;
    if (!conversationId) {
      const { data: createdConversation, error: conversationCreateError } = await supabase.from('bob_conversations').insert({ organization_id: organizationId, user_id: profile.id, module_key: 'operations', title: 'Bob Operations' }).select('id').single();
      if (conversationCreateError) { await supabase.storage.from('bob-uploads').remove([storagePath]); setError(`Source conversation could not be created: ${conversationCreateError.message}`); setUploadingFile(false); return; }
      conversationId = createdConversation.id;
    }
    const { error: metadataError } = await supabase.from('bob_attachments').insert({ id: attachmentId, organization_id: organizationId, conversation_id: conversationId, uploaded_by: profile.id, file_name: file.name, file_type: file.type || 'application/octet-stream', file_size_bytes: file.size, storage_bucket: 'bob-uploads', storage_path: storagePath, purpose: file.type.startsWith('video/') ? 'video_intake' : file.type.startsWith('image/') ? 'photo_intake' : 'document_intake', processing_state: 'pending' });
    if (metadataError) { await supabase.storage.from('bob-uploads').remove([storagePath]); setError(`Source registration failed: ${metadataError.message}`); setUploadingFile(false); return; }
    const { data: registration, error: registerError } = await supabase.functions.invoke('bob-document-register', { body: { attachment_id: attachmentId } });
    if (registerError) setError(`Source registration failed: ${registerError.message}`);
    else {
      const documentId = (registration as { document_id?: string } | null)?.document_id;
      if (documentId && selectedSpaceId && canManageFolders) {
        const { error: placementError } = await supabase.rpc('move_document_to_folder', { p_organization_id: organizationId, p_document_id: documentId, p_space_id: selectedSpaceId, p_folder_id: selectedFolderId, p_client_request_id: crypto.randomUUID() });
        if (placementError) setError(`File registered in Unfiled, but could not be moved here: ${placementError.message}`);
      }
      setNotice(`${file.name} uploaded through the human intake path and registered for review.`);
    }
    setUploadingFile(false);
    await loadDocuments();
  };

  const selectedBatch = importBatches.find((batch) => batch.id === selectedBatchId) ?? null;
  const selectedMappingSources = selectedBatch ? Array.from(new Set([...(selectedBatch.schema_json.mappings ?? []).map((mapping) => mapping.source), ...(selectedBatch.schema_json.headers ?? [])])) : [];

  useEffect(() => { void loadDocuments(); }, [loadDocuments]);

  useEffect(() => {
    let active = true;
    const loadMappings = async () => {
      if (!selectedBatch) { setMappingReviews([]); setMappingDrafts({}); return; }
      const { data, error: mappingError } = await supabase.from('file_import_mapping_reviews').select('source_column,target_entity,target_field,decision,review_reason').eq('batch_id', selectedBatch.id).order('source_column');
      if (!active) return;
      if (mappingError) { setError(mappingError.message); return; }
      const reviews = (data as FileImportMappingReview[]) ?? [];
      setMappingReviews(reviews);
      setMappingDrafts(Object.fromEntries(reviews.map((review) => [review.source_column, { targetEntity: review.target_entity ?? '', targetField: review.target_field ?? '', decision: review.decision, reason: review.review_reason ?? '' }])));
    };
    void loadMappings();
    return () => { active = false; };
  }, [selectedBatch]);

  useEffect(() => {
    let active = true;
    const loadRowProposals = async () => {
      if (!selectedBatch) { setRowProposals([]); setRowProposalReasons({}); return; }
      const { data, error: proposalError } = await supabase.from('file_import_row_proposals')
        .select('id,source_record_key,source_row_number,target_type,proposed_payload,source_values,confidence,status,review_reason,applied_target_id,reviewed_at')
        .eq('batch_id', selectedBatch.id)
        .order('source_row_number', { ascending: true, nullsFirst: false });
      if (!active) return;
      if (proposalError) { setPreviewError(proposalError.message); return; }
      const proposals = (data as FileImportRowProposal[]) ?? [];
      setRowProposals(proposals);
      setRowProposalReasons(Object.fromEntries(proposals.map((proposal) => [proposal.id, proposal.review_reason ?? ''])));
    };
    void loadRowProposals();
    return () => { active = false; };
  }, [selectedBatch]);

  const visibleDocuments = useMemo(() => {
    const term = search.trim().toLowerCase();
    return documents.filter((document) => {
      const matchesSearch = !term || [document.original_filename, document.mime_type, document.source_channel, document.sha256].some((value) => value?.toLowerCase().includes(term));
      const matchesScope = scope === 'all' || document.current_scope === scope;
      const placement = fileTree.placements.find((item) => item.document_id === document.id);
      const matchesFolder = selectedFolderId
        ? placement?.folder_id === selectedFolderId
        : selectedSpaceId
          ? placement?.space_id === selectedSpaceId
          : document.organization_id === null || Boolean(placement);
      return matchesSearch && matchesScope && matchesFolder;
    });
  }, [documents, fileTree.placements, scope, search, selectedFolderId, selectedSpaceId]);

  const visibleBatches = useMemo(() => batchStatus === 'all' ? importBatches : importBatches.filter((batch) => batch.status === batchStatus), [batchStatus, importBatches]);
  const visibleOutputs = useMemo(() => generatedOutputs.filter((output) => {
    const matchesStatus = outputStatus === 'all' || output.status === outputStatus;
    const matchesFormat = outputFormat === 'all' || output.output_format === outputFormat;
    const term = search.trim().toLowerCase();
    const document = relationOne(output.documents);
    const matchesSearch = !term || [outputTitle(output), output.output_format, output.status, output.mime_type, output.renderer_version, output.sha256, document?.source_channel].some((value) => value?.toLowerCase().includes(term));
    return matchesStatus && matchesFormat && matchesSearch;
  }), [generatedOutputs, outputFormat, outputStatus, search]);

  const selected = documents.find((document) => document.id === selectedId) ?? null;
  const selectedSpace = fileTree.spaces.find((item) => item.id === selectedSpaceId) ?? null;
  const selectedFolder = fileTree.folders.find((item) => item.id === selectedFolderId) ?? null;
  const currentPlacement = selected ? fileTree.placements.find((item) => item.document_id === selected.id) ?? null : null;
  const currentFolder = currentPlacement?.folder_id ? fileTree.folders.find((item) => item.id === currentPlacement.folder_id) ?? null : null;
  const currentSpace = currentPlacement ? fileTree.spaces.find((item) => item.id === currentPlacement.space_id) ?? null : null;
  const destinationOptions = useMemo(() => {
    const folderPath = (folderId: string): string => {
      const folder = fileTree.folders.find((item) => item.id === folderId);
      if (!folder) return '';
      return folder.parent_folder_id ? `${folderPath(folder.parent_folder_id)} / ${folder.name}` : folder.name;
    };
    return fileTree.spaces.flatMap((item) => [
      { value: `space:${item.id}`, label: item.name },
      ...fileTree.folders.filter((folder) => folder.space_id === item.id).map((folder) => ({ value: `folder:${folder.id}`, label: `${item.name} / ${folderPath(folder.id)}` })),
    ]);
  }, [fileTree.folders, fileTree.spaces]);

  useEffect(() => {
    setSelectedId((current) => current && visibleDocuments.some((document) => document.id === current) ? current : visibleDocuments[0]?.id ?? null);
  }, [visibleDocuments]);

  const selectExplorerLocation = (spaceId: string | null, folderId: string | null) => {
    setSelectedSpaceId(spaceId);
    setSelectedFolderId(folderId);
    setSearch('');
  };

  const createFolder = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!organizationId || !selectedSpace || !folderName.trim()) return;
    setOrganizing(true); setError(null); setNotice(null);
    const { data, error: folderError } = await supabase.rpc('create_file_folder', {
      p_organization_id: organizationId,
      p_space_id: selectedSpace.id,
      p_parent_folder_id: selectedFolder?.id ?? null,
      p_name: folderName.trim(),
      p_client_request_id: folderRequestId,
    });
    if (folderError) setError(folderError.message);
    else {
      const folder = data as { id: string; name: string };
      setFolderDialogOpen(false); setFolderName(''); setFolderRequestId(crypto.randomUUID());
      await loadDocuments(); setSelectedSpaceId(selectedSpace.id); setSelectedFolderId(folder.id);
      setNotice(`${folder.name} created.`);
    }
    setOrganizing(false);
  };

  const moveSelectedDocument = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!organizationId || !selected || !moveDestination) return;
    const isFolder = moveDestination.startsWith('folder:');
    const destinationId = moveDestination.slice(moveDestination.indexOf(':') + 1);
    const destinationFolder = isFolder ? fileTree.folders.find((item) => item.id === destinationId) ?? null : null;
    const destinationSpaceId = isFolder ? destinationFolder?.space_id ?? null : destinationId;
    if (!destinationSpaceId) return;
    setOrganizing(true); setError(null); setNotice(null);
    const { error: moveError } = await supabase.rpc('move_document_to_folder', {
      p_organization_id: organizationId,
      p_document_id: selected.id,
      p_space_id: destinationSpaceId,
      p_folder_id: destinationFolder?.id ?? null,
      p_client_request_id: moveRequestId,
    });
    if (moveError) setError(moveError.message);
    else {
      setMoveDialogOpen(false); setMoveRequestId(crypto.randomUUID());
      await loadDocuments(); setSelectedSpaceId(destinationSpaceId); setSelectedFolderId(destinationFolder?.id ?? null);
      setNotice(`${selected.original_filename} moved to ${destinationOptions.find((item) => item.value === moveDestination)?.label ?? 'the selected folder'}.`);
    }
    setOrganizing(false);
  };

  useEffect(() => {
    const requestedDocumentId = searchParams.get('document');
    if (requestedDocumentId && documents.some((document) => document.id === requestedDocumentId)) setSelectedId(requestedDocumentId);
  }, [documents, searchParams]);

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
    if (!lowerName.endsWith('.csv') && !lowerName.endsWith('.xlsx') && !lowerName.endsWith('.json')) {
      setPreviewError('Preview supports JSON, CSV, and XLSX files. Other formats remain staged for their dedicated parser.');
      return;
    }
    try {
      const bytes = await file.arrayBuffer();
      const preview = lowerName.endsWith('.xlsx')
        ? await parseXlsxPreview(bytes, file.name)
        : lowerName.endsWith('.json')
          ? parseJsonPreview(new TextDecoder().decode(bytes), file.name)
          : parseCsvPreview(new TextDecoder().decode(bytes), file.name);
      setUploadedImportPreview({ ...preview, source_sha256: await sha256Hex(bytes) });
    } catch {
      setPreviewError('The CSV could not be parsed safely for preview.');
    }
  };

  const activeImportPreview = uploadedImportPreview;

  const createReviewBatch = async () => {
    const organizationId = operatingOrganizationId ?? profile?.organizationId;
    if (!organizationId || !activeImportPreview) {
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
      p_schema_json: { mappings: activeImportPreview.mappings, warnings: activeImportPreview.warnings, headers: activeImportPreview.headers, sample_rows: activeImportPreview.sample_rows, malformed_row_count: activeImportPreview.malformed_row_count ?? 0 },
      p_row_count: activeImportPreview.row_count,
      p_duplicate_count: activeImportPreview.duplicate_count,
      p_unresolved_count: activeImportPreview.unresolved_count ?? 0,
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
    if (decision === 'approved' && rowProposals.some((proposal) => proposal.status === 'proposed')) {
      setPreviewError('Review every consequential row proposal before approving the batch.');
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

  const saveMappingReview = async (sourceColumn: string) => {
    if (!selectedBatch) return;
    const draft = mappingDrafts[sourceColumn] ?? { targetEntity: '', targetField: '', decision: 'proposed' as const, reason: '' };
    setSavingMapping(sourceColumn); setPreviewError(null);
    const { data, error: mappingError } = await supabase.rpc('review_file_import_mapping', { p_batch_id: selectedBatch.id, p_source_column: sourceColumn, p_target_entity: draft.targetEntity, p_target_field: draft.targetField, p_decision: draft.decision, p_review_reason: draft.reason });
    if (mappingError) setPreviewError(mappingError.message);
    else { setMappingReviews((current) => [...current.filter((review) => review.source_column !== sourceColumn), data as FileImportMappingReview].sort((left, right) => left.source_column.localeCompare(right.source_column))); setNotice(`Mapping review recorded for ${sourceColumn}. No canonical records were changed.`); }
    setSavingMapping(null);
  };

  const reviewRowProposal = async (proposal: FileImportRowProposal, decision: 'approved' | 'rejected') => {
    const reason = rowProposalReasons[proposal.id]?.trim();
    if (!reason) { setPreviewError('A row-level review reason is required.'); return; }
    setReviewingRowProposal(proposal.id); setPreviewError(null); setNotice(null);
    const { data, error: proposalError } = await supabase.rpc('review_file_import_row_proposal', { p_proposal_id: proposal.id, p_decision: decision, p_reason: reason });
    if (proposalError) setPreviewError(proposalError.message);
    else {
      setRowProposals((current) => current.map((item) => item.id === proposal.id ? data as FileImportRowProposal : item));
      setNotice(decision === 'approved' ? 'Row proposal approved for the later governed apply step.' : 'Row proposal rejected. No proposed target was applied.');
    }
    setReviewingRowProposal(null);
  };

  const confirmProfileMappings = async () => {
    if (!selectedBatch || !reviewReason.trim()) { setPreviewError('A review reason is required to confirm profile mappings.'); return; }
    setFinanceImportAction('mappings'); setPreviewError(null);
    const { error: mappingError } = await supabase.rpc('confirm_file_import_profile_mappings', { p_batch_id: selectedBatch.id, p_reason: reviewReason.trim() });
    if (mappingError) setPreviewError(mappingError.message);
    else {
      setMappingReviews((current) => current.map((review) => ({ ...review, decision: 'confirmed', review_reason: reviewReason.trim() })));
      setNotice('Every exact source-profile mapping was confirmed. No business records were changed.');
    }
    setFinanceImportAction(null);
  };

  const reviewFinanceProposals = async () => {
    if (!selectedBatch || !reviewReason.trim()) { setPreviewError('A review reason is required to approve the reconciled finance proposal summary.'); return; }
    const proposals = rowProposals.filter((proposal) => proposal.target_type === 'finance_service_cost' && proposal.status === 'proposed');
    const expectedTotal = proposals.reduce((total, proposal) => total + Number(proposal.proposed_payload.unit_cost ?? 0), 0);
    setFinanceImportAction('review'); setPreviewError(null);
    const { error: proposalError } = await supabase.rpc('review_file_import_finance_proposals', {
      p_batch_id: selectedBatch.id,
      p_expected_proposal_count: proposals.length,
      p_expected_total: expectedTotal,
      p_reason: reviewReason.trim(),
    });
    if (proposalError) setPreviewError(proposalError.message);
    else {
      setRowProposals((current) => current.map((proposal) => proposal.target_type === 'finance_service_cost' && proposal.status === 'proposed'
        ? { ...proposal, status: 'approved', review_reason: reviewReason.trim(), reviewed_at: new Date().toISOString() }
        : proposal));
      setNotice(`${proposals.length} reconciled finance proposals approved for the later batch apply step. No finance costs were created.`);
    }
    setFinanceImportAction(null);
  };

  const applyFinanceBatch = async () => {
    if (!selectedBatch) return;
    setFinanceImportAction('apply'); setPreviewError(null);
    const { data, error: applyError } = await supabase.rpc('apply_file_import_finance_batch', { p_batch_id: selectedBatch.id });
    if (applyError) setPreviewError(applyError.message);
    else {
      const receipt = data as { applied?: number; existing?: number; periods_created?: number; total?: number };
      setImportBatches((current) => current.map((batch) => batch.id === selectedBatch.id ? { ...batch, status: 'applied' } : batch));
      setRowProposals((current) => current.map((proposal) => proposal.status === 'approved' ? { ...proposal, status: 'applied' } : proposal));
      setNotice(`Finance batch applied: ${receipt.applied ?? 0} new cost lines, ${receipt.existing ?? 0} existing, ${receipt.periods_created ?? 0} monthly P&L periods created, total ${Number(receipt.total ?? 0).toLocaleString('en-NZ', { style: 'currency', currency: 'NZD' })}.`);
    }
    setFinanceImportAction(null);
  };

  const isFinanceBatch = rowProposals.length > 0 && rowProposals.every((proposal) => proposal.target_type === 'finance_service_cost');
  const proposedFinance = rowProposals.filter((proposal) => proposal.target_type === 'finance_service_cost' && proposal.status === 'proposed');
  const proposedFinanceTotal = proposedFinance.reduce((total, proposal) => total + Number(proposal.proposed_payload.unit_cost ?? 0), 0);
  const rowProposalReview = selectedBatch ? <section className="file-system-row-proposals" aria-label="Consequential row proposal review"><div><span>Row proposals</span><strong>{isFinanceBatch ? 'Review the reconciled monthly cost summary.' : 'Review consequential targets one row at a time.'}</strong><small>Approval records a decision only. Targets are created later, after the complete batch is approved.</small></div>{rowProposals.length === 0 ? <p className="file-system-muted">No consequential row proposals were staged for this batch.</p> : <>{isFinanceBatch && <div className="file-system-import-facts"><div><small>Proposals</small><strong>{rowProposals.length}</strong></div><div><small>Awaiting review</small><strong>{proposedFinance.length}</strong></div><div><small>Awaiting total</small><strong>{proposedFinanceTotal.toLocaleString('en-NZ', { style: 'currency', currency: 'NZD' })}</strong></div></div>}{rowProposals.map((proposal) => <article key={proposal.id}><header><div><strong>{proposal.target_type.replaceAll('_', ' ')}</strong><small>Source row {proposal.source_row_number ?? 'aggregate'} - {proposal.source_record_key}</small></div><span>{proposal.status}</span></header><div className="file-system-row-proposal-values"><div><span>Source values</span><pre>{JSON.stringify(proposal.source_values, null, 2)}</pre></div><div><span>Proposed target</span><pre>{JSON.stringify(proposal.proposed_payload, null, 2)}</pre></div></div><small>Confidence: {proposal.confidence === null ? 'not scored' : `${Math.round(proposal.confidence * 100)}%`}{proposal.applied_target_id ? ` - Applied target ${proposal.applied_target_id}` : ''}</small>{proposal.status === 'proposed' && !isFinanceBatch ? <div className="file-system-row-proposal-decision"><label><span>Decision reason</span><textarea rows={2} value={rowProposalReasons[proposal.id] ?? ''} onChange={(event) => setRowProposalReasons((current) => ({ ...current, [proposal.id]: event.target.value }))} placeholder="What source evidence supports this decision?" /></label><div><button type="button" disabled={reviewingRowProposal !== null} onClick={() => void reviewRowProposal(proposal, 'approved')}>{reviewingRowProposal === proposal.id ? 'Reviewing' : 'Approve proposal'}</button><button type="button" disabled={reviewingRowProposal !== null} onClick={() => void reviewRowProposal(proposal, 'rejected')}>Reject proposal</button></div></div> : proposal.status !== 'proposed' ? <p>Decision reason: {proposal.review_reason ?? 'Not recorded'}</p> : null}</article>)}{isFinanceBatch && selectedBatch.status === 'needs_review' && <div className="file-system-row-proposal-decision"><button type="button" onClick={() => void confirmProfileMappings()} disabled={financeImportAction !== null || mappingReviews.every((review) => review.decision === 'confirmed')}>{financeImportAction === 'mappings' ? 'Confirming mappings' : 'Confirm exact profile mappings'}</button><button type="button" onClick={() => void reviewFinanceProposals()} disabled={financeImportAction !== null || proposedFinance.length === 0 || mappingReviews.some((review) => review.decision !== 'confirmed')}>{financeImportAction === 'review' ? 'Recording review' : 'Approve reconciled finance summary'}</button></div>}{isFinanceBatch && selectedBatch.status === 'approved' && <div className="file-system-row-proposal-decision"><button type="button" onClick={() => void applyFinanceBatch()} disabled={financeImportAction !== null}>{financeImportAction === 'apply' ? 'Applying approved costs' : 'Apply approved finance batch'}</button></div>}</>}</section> : null;

  return <ShellLayout shell="admin" className="file-system-shell">
    <div className="file-system-page">
    <header className="file-system-header"><div><span>Organisation workspace / Files</span><h1>File system</h1><p>Find source documents, inspect provenance, and review extracted versions before anything becomes an authoritative record.</p></div><div className="file-system-header-actions"><label className="file-system-human-upload"><Upload size={17} />{uploadingFile ? 'Uploading...' : 'Upload source file'}<input type="file" aria-label="Upload source file" disabled={uploadingFile} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadHumanIntakeFile(file); event.currentTarget.value = ''; }} /></label><button type="button" onClick={() => navigate('/admin/approvals')}><ShieldCheck size={17} />Review promotions</button><button type="button" onClick={() => void loadDocuments()} disabled={loading}><RefreshCw size={17} className={loading ? 'is-spinning' : ''} />Refresh</button></div></header>
    {error && <div className="file-system-message is-error" role="alert"><span>{error}</span><button type="button" title="Dismiss" onClick={() => setError(null)} aria-label="Dismiss error"><X size={16} /></button></div>}
    {notice && <div className="file-system-message is-success" role="status"><ShieldCheck size={16} /><span>{notice}</span><button type="button" title="Dismiss" onClick={() => setNotice(null)} aria-label="Dismiss notice"><X size={16} /></button></div>}
    {canManageFolders && <section className="file-system-source-runs" aria-label="Approved local source inventory">
      <div className="file-system-source-runs-heading"><div><span>Approved local source</span><h2>Bob document inventory</h2><p>Read-only enumeration, capability classification, bounded hashing, and quarantine receipts. Business records are created only through the separate governed promotion lane.</p></div><button type="button" onClick={() => void requestDocumentSourceAction('start')} disabled={documentSourceAction || documentSourceRuns.some((run) => ['queued', 'running', 'cancel_requested'].includes(run.status))}><FolderPlus size={17} />{documentSourceAction ? 'Working' : 'Start inventory'}</button></div>
      {documentSourceRuns.length === 0 ? <p className="file-system-muted">No source inventory has been requested.</p> : <div className="file-system-source-run-list">{documentSourceRuns.map((run) => { const source = relationOne(run.document_reference_sources); const active = ['queued', 'running', 'cancel_requested'].includes(run.status); return <article key={run.id} className={searchParams.get('sourceRun') === run.id ? 'is-selected' : ''}><div><strong>{source?.label ?? 'Approved source'}</strong><span>{run.status.replaceAll('_', ' ')} · {run.phase}</span><small>Requested {new Date(run.requested_at).toLocaleString('en-NZ')}{run.heartbeat_at ? ` · Last receipt ${new Date(run.heartbeat_at).toLocaleTimeString('en-NZ')}` : ''}</small></div><dl><div><dt>Discovered</dt><dd>{run.discovered_count.toLocaleString()}</dd></div><div><dt>Hashed</dt><dd>{run.hashed_count.toLocaleString()}</dd></div><div><dt>Duplicates</dt><dd>{run.duplicate_count.toLocaleString()}</dd></div><div><dt>Supported</dt><dd>{run.supported_count.toLocaleString()}</dd></div><div><dt>Partial</dt><dd>{run.partial_count.toLocaleString()}</dd></div><div><dt>Gaps</dt><dd>{run.gap_count.toLocaleString()}</dd></div><div><dt>Excluded</dt><dd>{run.excluded_count.toLocaleString()}</dd></div><div><dt>Quarantined</dt><dd>{run.quarantined_count.toLocaleString()}</dd></div></dl>{run.error_detail_redacted && <p role="alert">{run.error_detail_redacted}</p>}{active && <button type="button" onClick={() => void requestDocumentSourceAction('cancel', run.id)} disabled={documentSourceAction}>Cancel inventory</button>}</article>; })}</div>}
    </section>}
    <details className="file-system-import-tools">
      <summary><span>Structured data imports</span><small>{importBatches.length} review batch{importBatches.length === 1 ? '' : 'es'}</small></summary>
      <section className="file-system-intake" aria-label="Structured data import preview">
        <div>
          <span>Import preview</span>
          <h2>Choose a CSV or XLSX file</h2>
          <p>Preview its columns, sample rows and unresolved values before creating a review batch. No business records are changed here.</p>
        </div>
        <div className="file-system-import-switcher">
          <label className="file-system-import-upload">Choose CSV/XLSX<input type="file" aria-label="Upload import CSV or XLSX" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { const file = event.target.files?.[0]; if (file) void previewImportFile(file); event.currentTarget.value = ''; }} /></label>
        </div>
        {previewError && <p className="file-system-import-warning" role="alert">{previewError}</p>}
        {!activeImportPreview ? <p className="file-system-muted">No structured file selected.</p> : <div className="file-system-import-detail">
          <strong className="file-system-import-source">{activeImportPreview.source_file}</strong>
          <small className="file-system-import-hash">SHA-256: {activeImportPreview.source_sha256 ?? 'Generated when a local source is selected'}</small>
          <button type="button" className="file-system-import-create" onClick={() => void createReviewBatch()} disabled={creatingBatch} aria-label="Create import batch for review">{creatingBatch ? 'Creating review batch' : 'Create review batch'}</button>
          <div className="file-system-import-facts"><div><small>Parser</small><strong>{activeImportPreview.parser}</strong></div><div><small>Rows</small><strong>{activeImportPreview.row_count.toLocaleString()}</strong></div><div><small>Duplicate rows</small><strong>{activeImportPreview.duplicate_count}</strong></div><div><small>Malformed rows</small><strong>{activeImportPreview.malformed_row_count ?? 0}</strong></div><div><small>Unresolved values</small><strong>{activeImportPreview.unresolved_count ?? 0}</strong></div><div><small>Date range</small><strong>{activeImportPreview.date_range}</strong></div></div>
          {activeImportPreview.headers && activeImportPreview.sample_rows && <div className="file-system-import-sample"><span>Sample rows, first 5 only</span><div className="file-system-import-table-wrap"><table><thead><tr>{activeImportPreview.headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{activeImportPreview.sample_rows.map((row, rowIndex) => <tr key={`sample-${rowIndex}`}>{activeImportPreview.headers?.map((header, columnIndex) => <td key={`${header}-${rowIndex}`}>{row[columnIndex] || '-'}</td>)}</tr>)}</tbody></table></div></div>}
          <div className="file-system-import-columns"><div><span>Column mapping</span>{activeImportPreview.mappings.map((mapping) => <div className="file-system-import-mapping" key={`${mapping.source}-${mapping.target}`}><strong>{mapping.source}</strong><span>to {mapping.target}</span><small>{mapping.confidence}</small></div>)}</div><div><span>Review warnings</span>{activeImportPreview.warnings.map((warning) => <p key={warning}>{warning}</p>)}<p className="file-system-import-warning">{activeImportPreview.unresolved_count ?? 0} unresolved values</p></div></div>
        </div>}
      </section>
    <section className="file-system-batches" aria-label="Import batch history">
      <div className="file-system-batches-heading"><div><span>Review history</span><h2>Import batches</h2></div><select id="batch-status-filter" aria-label="Import batch status" value={batchStatus} onChange={(event) => setBatchStatus(event.target.value as typeof batchStatus)}><option value="all">All statuses</option><option value="preview">Preview</option><option value="needs_review">Needs review</option><option value="approved">Approved</option><option value="applied">Applied</option><option value="rejected">Rejected</option><option value="failed">Failed</option></select></div>
      {visibleBatches.length === 0 ? <p className="file-system-muted">No persisted review batches match this status.</p> : <div className="file-system-batch-grid">{visibleBatches.map((batch) => <button type="button" key={batch.id} className={selectedBatchId === batch.id ? 'is-selected' : ''} onClick={() => setSelectedBatchId(batch.id)}><strong>{batch.source_file}</strong><span>{batch.status.replaceAll('_', ' ')} · {batch.row_count.toLocaleString()} rows</span><small>{batch.duplicate_of_batch_id ? 'Duplicate source linked' : 'Original source'} · {batch.duplicate_count} row duplicates · {batch.unresolved_count} unresolved</small></button>)}</div>}
      {selectedBatch && <article className="file-system-batch-detail"><div><strong>{selectedBatch.batch_name}</strong><span>{selectedBatch.parser} · {selectedBatch.status.replaceAll('_', ' ')}</span><small>{selectedBatch.source_sha256 ? `SHA-256 ${selectedBatch.source_sha256}` : 'Source hash unavailable'}</small>{selectedBatch.duplicate_of_batch_id && <small>Duplicate of batch {selectedBatch.duplicate_of_batch_id.slice(0, 8)}</small>}{selectedBatch.review_reason && <small>Reason: {selectedBatch.review_reason}</small>}</div><div><span>Mappings</span>{(selectedBatch.schema_json.mappings ?? []).map((mapping) => <small key={`${mapping.source}-${mapping.target}`}>{mapping.source} to {mapping.target} ({mapping.confidence})</small>)}</div><div><span>Warnings</span>{(selectedBatch.schema_json.warnings ?? []).map((warning) => <small key={warning}>{warning}</small>)}</div>{selectedBatch.schema_json.headers && selectedBatch.schema_json.sample_rows && <div className="file-system-batch-sample"><span>Sample rows</span>{selectedBatch.schema_json.sample_rows.map((row, rowIndex) => <small key={`batch-sample-${rowIndex}`}>{row.join(' · ')}</small>)}</div>}<section className="file-system-mapping-review" aria-label="Human mapping review"><div><span>Human mapping review</span><strong>Bob proposes; you confirm the target.</strong><small>These decisions are stored as review evidence only. No canonical records are changed here.</small></div>{selectedMappingSources.length === 0 ? <p className="file-system-muted">No source columns were captured for this batch.</p> : selectedMappingSources.map((sourceColumn) => { const existing = mappingReviews.find((review) => review.source_column === sourceColumn); const draft = mappingDrafts[sourceColumn] ?? { targetEntity: existing?.target_entity ?? '', targetField: existing?.target_field ?? '', decision: existing?.decision ?? 'proposed', reason: existing?.review_reason ?? '' }; return <div className="file-system-mapping-row" key={sourceColumn}><strong>{sourceColumn}</strong><label><span>Target entity</span><input aria-label="Target entity" value={draft.targetEntity} onChange={(event) => setMappingDrafts((current) => ({ ...current, [sourceColumn]: { ...draft, targetEntity: event.target.value } }))} placeholder="Bob/schema candidate" /></label><label><span>Target field</span><input aria-label="Target field" value={draft.targetField} onChange={(event) => setMappingDrafts((current) => ({ ...current, [sourceColumn]: { ...draft, targetField: event.target.value } }))} placeholder="Canonical field" /></label><label><span>Decision</span><select aria-label="Decision" value={draft.decision} onChange={(event) => setMappingDrafts((current) => ({ ...current, [sourceColumn]: { ...draft, decision: event.target.value as FileImportMappingReview['decision'] } }))}><option value="proposed">Proposed</option><option value="confirmed">Confirmed</option><option value="rejected">Rejected</option></select></label><label><span>Reason</span><input aria-label="Review reason" value={draft.reason} onChange={(event) => setMappingDrafts((current) => ({ ...current, [sourceColumn]: { ...draft, reason: event.target.value } }))} placeholder="Evidence or unresolved reason" /></label><button type="button" onClick={() => void saveMappingReview(sourceColumn)} disabled={savingMapping === sourceColumn}>{savingMapping === sourceColumn ? 'Saving' : 'Record mapping review'}</button></div>; })}</section>{rowProposalReview}{(selectedBatch.status === 'preview' || selectedBatch.status === 'needs_review') && <div className="file-system-batch-review"><label htmlFor="batch-review-reason">Review reason</label><textarea id="batch-review-reason" rows={2} value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} placeholder="Explain the review decision" /><div><button type="button" onClick={() => void reviewBatch('approved')} disabled={reviewingBatch}>Approve batch</button><button type="button" onClick={() => void reviewBatch('rejected')} disabled={reviewingBatch}>Reject batch</button></div></div>}</article>}
    </section>
    </details>
    {intakeAttachments.length > 0 && <section className="file-system-intake" aria-label="Bob intake waiting registration"><div><span>Bob intake</span><h2>Files waiting registration</h2><p>These uploads are not yet canonical Files records. Registration extracts, hashes, classifies, and preserves upload provenance.</p></div><div>{intakeAttachments.map((attachment) => { const disposition = intakeDisposition(attachment); return <article key={attachment.id}><strong>{attachment.file_name}</strong><small>{attachment.file_type} · {Math.round(attachment.file_size_bytes / 1024)} KB · {new Date(attachment.created_at).toLocaleDateString('en-NZ')}</small>{disposition.allowed ? <button type="button" onClick={() => void registerAttachment(attachment)}>Register in Files</button> : <span className="file-system-quarantine">Quarantined: {disposition.reason}</span>}</article>; })}</div></section>}
    <div className="file-explorer-workspace">
    <FileExplorerTree tree={fileTree} selectedSpaceId={selectedSpaceId} selectedFolderId={selectedFolderId} canCreateFolder={canManageFolders} onSelect={selectExplorerLocation} onCreateFolder={() => { const targetSpace = selectedSpace ?? fileTree.spaces.find((item) => item.space_key === 'organisation') ?? fileTree.spaces[0]; if (!targetSpace) return; setSelectedSpaceId(targetSpace.id); setSelectedFolderId(null); setFolderName(''); setFolderRequestId(crypto.randomUUID()); setFolderDialogOpen(true); }} />
    <section className="file-explorer-content">
    <header className="file-explorer-location"><div><span>{fileTree.organization?.name ?? 'Organisation files'}{selectedSpace ? ` / ${selectedSpace.name}` : ''}</span><h2>{selectedFolder?.name ?? selectedSpace?.name ?? 'All files'}</h2></div><small>{visibleDocuments.length} file{visibleDocuments.length === 1 ? '' : 's'}</small></header>
    {selectedSpace?.space_key === 'generated' ? <section className="file-system-batches file-system-generated-registry" aria-label="Generated outputs">
      <div className="file-system-batches-heading"><div><span>Generated Outputs</span><h2>Approved document artifacts</h2></div><div className="file-system-output-filters"><select aria-label="Generated output status" value={outputStatus} onChange={(event) => setOutputStatus(event.target.value as OutputStatusFilter)}><option value="all">All statuses</option><option value="requested">Requested</option><option value="generating">Generating</option><option value="ready">Ready</option><option value="failed">Failed</option><option value="revoked">Revoked</option></select><select aria-label="Generated output format" value={outputFormat} onChange={(event) => setOutputFormat(event.target.value as OutputFormatFilter)}><option value="all">All formats</option><option value="print">Print PDF</option><option value="pdf">PDF</option><option value="docx">DOCX</option></select><Download size={17} /></div></div>
      {visibleOutputs.length === 0 ? <p className="file-system-muted">No generated outputs match this view.</p> : <div className="file-system-output-grid">{visibleOutputs.map((output) => {
        const version = relationOne(output.document_versions);
        const extension = output.output_format === 'docx' ? 'docx' : 'pdf';
        return <article className={`file-system-output-card is-${output.status}`} key={output.id}>
          <div><span>{outputLabel(output.output_format)} · {output.status.replaceAll('_', ' ')}</span><strong>{outputTitle(output)}</strong><small>{version?.version_label ?? 'Version unavailable'} · {output.generated_at ? new Date(output.generated_at).toLocaleString('en-NZ') : 'Not generated'}</small></div>
          <dl><div><dt>MIME</dt><dd>{output.mime_type ?? 'Pending'}</dd></div><div><dt>Renderer</dt><dd>{output.renderer_version ?? 'Pending'}</dd></div><div><dt>Approved</dt><dd>{output.approved_at ? new Date(output.approved_at).toLocaleString('en-NZ') : 'Pending'}</dd></div><div><dt>SHA-256</dt><dd>{output.sha256 ?? 'Checksum pending'}</dd></div></dl>
          {output.status === 'ready' && output.storage_bucket && output.storage_path && <GeneratedArtifactActions bucket={output.storage_bucket} path={output.storage_path} fileName={artifactFileName(outputTitle(output), extension)} label={outputLabel(output.output_format)} />}
        </article>;
      })}</div>}
    </section> : null}
    {selectedSpace?.space_key === 'generated' ? <section className="file-system-batches file-system-generated-registry" aria-label="Enforcement notice artifacts"><div className="file-system-batches-heading"><div><span>Enforcement notices</span><h2>Issued notice artifacts</h2></div><ShieldCheck size={17} /></div>{noticeArtifacts.length === 0 ? <p className="file-system-muted">No notice artifacts are available for this organisation.</p> : <div className="file-system-output-grid">{noticeArtifacts.map((notice) => <article className="file-system-output-card is-ready" key={`${notice.kind}-${notice.id}`}><div><span>{notice.label} · {notice.status.replaceAll('_', ' ')}</span><strong>{notice.notice_number ?? `Vehicle ${notice.plate_number}`}</strong><small>{new Date(notice.issued_at).toLocaleString('en-NZ')}</small></div><dl><div><dt>Vehicle</dt><dd>{notice.plate_number}</dd></div><div><dt>Storage</dt><dd>{notice.storage_path ? 'PDF artifact' : 'Unavailable'}</dd></div></dl>{notice.storage_path && <GeneratedArtifactActions bucket="notice-artifacts" path={notice.storage_path} fileName={artifactFileName(`notice-${notice.notice_number ?? notice.id}`, 'pdf')} label="Notice PDF" />}</article>)}</div>}</section> : null}
    <div className="file-system-toolbar"><label><Search size={16} /><input type="search" aria-label="Search files" placeholder="Search filenames, type, source, or hash" value={search} onChange={(event) => setSearch(event.target.value)} /></label><select aria-label="File status" value={scope} onChange={(event) => setScope(event.target.value as FileFilter)}><option value="all">All statuses</option><option value="quarantined">Quarantined</option><option value="tenant_reference">Reference</option><option value="tenant">Tenant files</option><option value="global_reference">Global reference</option></select></div>
    <div className="file-system-layout"><section className="file-system-list" aria-label="Files"><div className="file-system-list-heading"><div><span>Permitted records</span><h2>{visibleDocuments.length} files</h2></div><small>{documents.length} loaded</small></div>{loading ? <div className="file-system-empty"><RefreshCw size={20} className="is-spinning" />Loading files</div> : visibleDocuments.length === 0 ? <div className="file-system-empty"><FileArchive size={22} />No files match this folder</div> : <div className="file-system-records">{visibleDocuments.map((document) => { const Icon = fileIcon(document.mime_type); const placement = fileTree.placements.find((item) => item.document_id === document.id); const folder = placement?.folder_id ? fileTree.folders.find((item) => item.id === placement.folder_id) : null; const placementSpace = placement ? fileTree.spaces.find((item) => item.id === placement.space_id) : null; return <button type="button" key={document.id} className={selectedId === document.id ? 'is-selected' : ''} onClick={() => setSelectedId(document.id)}><span className="file-system-record-icon"><Icon size={17} /></span><span><strong>{document.original_filename}</strong><small>{folder?.name ?? placementSpace?.name ?? 'Shared reference'} · {scopeLabel(document.current_scope)}</small></span><time dateTime={document.updated_at}>{new Date(document.updated_at).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })}</time></button>; })}</div>}</section>
    <aside className="file-system-detail" aria-label="File details">{!selected ? <div className="file-system-empty"><FileText size={22} />Select a file to inspect</div> : <><div className="file-system-detail-heading"><div><span>{currentFolder?.name ?? currentSpace?.name ?? 'Shared reference'}</span><h2>{selected.original_filename}</h2><small>{selected.mime_type} · {scopeLabel(selected.current_scope)}</small></div><div className="file-system-detail-actions">{canManageFolders && selected.organization_id && <button type="button" onClick={() => { setMoveDestination(currentFolder ? `folder:${currentFolder.id}` : currentSpace ? `space:${currentSpace.id}` : ''); setMoveRequestId(crypto.randomUUID()); setMoveDialogOpen(true); }} title="Move file"><FileInput size={17} />Move</button>}<button type="button" onClick={() => void openFile()} disabled={opening || !selected.storage_object_ref} title="Open source file"><Download size={17} />{opening ? 'Opening' : 'Open source'}</button></div></div><dl className="file-system-facts"><div><dt>Source</dt><dd>{selected.source_channel.replaceAll('_', ' ')}</dd></div><div><dt>Folder</dt><dd>{currentFolder?.name ?? currentSpace?.name ?? 'Shared reference'}</dd></div><div><dt>Uploaded</dt><dd>{new Date(selected.created_at).toLocaleString('en-NZ')}</dd></div><div><dt>SHA-256</dt><dd>{selected.sha256 ?? 'Not recorded'}</dd></div></dl><section className="file-system-section"><div className="file-system-section-heading"><div><span>Versions</span><h3>{versions.length} extracted versions</h3></div>{versionsLoading && <RefreshCw size={15} className="is-spinning" />}</div>{versions.length === 0 ? <p className="file-system-muted">No extracted version is available yet. This source remains reviewable without treating it as authoritative.</p> : <div className="file-system-versions">{versions.map((version) => <article key={version.id}><strong>{version.version_label}</strong><span>{version.extraction_confidence === null ? 'Confidence unavailable' : `${Math.round(version.extraction_confidence * 100)}% extraction confidence`}{version.ocr_required ? ' · OCR required' : ''}</span><small>{version.extracted_text?.slice(0, 280) || 'No extracted text preview.'}</small></article>)}</div>}</section><section className="file-system-provenance"><Clock3 size={15} /><span>Promotion is deliberately separate from file storage. Bob can prepare a review, but a human must approve any CRM, HR, finance, evidence, or investigation change.</span></section></>}</aside></div>
    </section>
    </div>
    {folderDialogOpen && selectedSpace && <div className="file-system-dialog-backdrop"><form className="file-system-dialog" role="dialog" aria-modal="true" aria-labelledby="new-folder-title" onSubmit={createFolder}><header><div><span>New folder</span><h2 id="new-folder-title">Create inside {selectedFolder?.name ?? selectedSpace.name}</h2></div><button type="button" onClick={() => setFolderDialogOpen(false)} aria-label="Close new folder"><X size={17} /></button></header><label><span>Folder name</span><input autoFocus required maxLength={160} value={folderName} onChange={(event) => setFolderName(event.target.value)} /></label><footer><button type="button" onClick={() => setFolderDialogOpen(false)}>Cancel</button><button type="submit" className="is-primary" disabled={organizing || !folderName.trim()}><FolderPlus size={16} />{organizing ? 'Creating' : 'Create folder'}</button></footer></form></div>}
    {moveDialogOpen && selected && <div className="file-system-dialog-backdrop"><form className="file-system-dialog" role="dialog" aria-modal="true" aria-labelledby="move-file-title" onSubmit={moveSelectedDocument}><header><div><span>Move file</span><h2 id="move-file-title">{selected.original_filename}</h2></div><button type="button" onClick={() => setMoveDialogOpen(false)} aria-label="Close move file"><X size={17} /></button></header><label><span>Destination</span><select required value={moveDestination} onChange={(event) => setMoveDestination(event.target.value)}><option value="">Choose a section or folder</option>{destinationOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><footer><button type="button" onClick={() => setMoveDialogOpen(false)}>Cancel</button><button type="submit" className="is-primary" disabled={organizing || !moveDestination}><FileInput size={16} />{organizing ? 'Moving' : 'Move file'}</button></footer></form></div>}
    </div>
  </ShellLayout>;
};

export default FileSystemPage;
