import React, { useEffect, useState } from 'react';
import { Bold, Check, CheckCircle2, FilePlus2, Heading2, Italic, List, ListOrdered, PanelRight, Save, Search, ShieldCheck, Sparkles, Upload, X } from 'lucide-react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './BobDocumentStudioPage.css';

type ReferenceResult = {
  catalog_entry_id: string;
  title: string;
  topic: string | null;
  publisher: string | null;
  jurisdiction: string | null;
  document_type: string | null;
  trust_level: string;
  retrieval_handle: string;
};

type SaveState = 'idle' | 'saving' | 'saved' | 'reviewing' | 'needs_review' | 'error';
type OutputFormat = 'print' | 'docx';
type DraftSummary = { id: string; title: string; updatedAt: string; versionId: string; status: string; html: string; text: string; documentType: string; sourceChannel: string; currentScope: string; authorable: boolean };
type BrandAsset = { id: string; label: string; asset_kind: string; variant: string; status: string; asset_url: string | null; storage_bucket: string | null; storage_path: string | null; alt_text: string | null };
type OutputReceipt = { id: string; status: string; output_format: OutputFormat | 'pdf'; sha256: string | null; storage_bucket: string | null; storage_path: string | null };
const FILE_SPACES = ['Organisation', 'Contracts', 'Sites and Operations', 'HR and People', 'Finance', 'Evidence', 'Investigations', 'Bob Intake', 'Generated Outputs'];

export default function BobDocumentStudioPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { profile } = useAuth();
  const [title, setTitle] = useState('Untitled Bob document');
  const [documentType, setDocumentType] = useState('report');
  const [sourceContext, setSourceContext] = useState<{ type: string; id: string; label: string; prompt: string } | null>(null);
  const [autoDraftStarted, setAutoDraftStarted] = useState(false);
  const [referenceQuery, setReferenceQuery] = useState('');
  const [references, setReferences] = useState<ReferenceResult[]>([]);
  const [selectedReferences, setSelectedReferences] = useState<ReferenceResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  const [draftIds, setDraftIds] = useState<{ documentId: string; versionId: string } | null>(null);
  const [reviewReason, setReviewReason] = useState('Prepared for human review of source coverage, assumptions, and operational suitability.');
  const [decisionReason, setDecisionReason] = useState('Reviewed source coverage, unresolved fields, and operational suitability.');
  const [organizationName, setOrganizationName] = useState('Current organization');
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [brandAssets, setBrandAssets] = useState<BrandAsset[]>([]);
  const [brandBusy, setBrandBusy] = useState(false);
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('print');
  const [outputReceipt, setOutputReceipt] = useState<OutputReceipt | null>(null);
  const [outputBusy, setOutputBusy] = useState(false);
  const [outputHistory, setOutputHistory] = useState<OutputReceipt[]>([]);
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [fileSpace, setFileSpace] = useState('Bob Intake');
  const [fileSearch, setFileSearch] = useState('');
  const [selectedFile, setSelectedFile] = useState<DraftSummary | null>(null);
  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: 'Start writing, or ask Bob to draft from the selected references…' }),
    ],
    content: '',
    editorProps: { attributes: { 'aria-label': 'Editable document surface', 'aria-multiline': 'true' } },
  });

  useEffect(() => {
    if (!profile?.organizationId) return;
    let active = true;
    void Promise.all([
      supabase.from('organizations').select('name,logo_url').eq('id', profile.organizationId).maybeSingle(),
      supabase.from('organization_brand_assets').select('asset_url,storage_bucket,storage_path').eq('organization_id', profile.organizationId).eq('asset_kind', 'logo').eq('variant', 'default').eq('status', 'approved').order('updated_at', { ascending: false }).limit(1).maybeSingle(),
    ]).then(([organizationResponse, assetResponse]) => {
      if (!active) return;
      if (organizationResponse.data) setOrganizationName(organizationResponse.data.name || 'Current organization');
      const asset = assetResponse.data;
      if (asset?.asset_url) setLogoUrl(asset.asset_url);
      else if (asset?.storage_bucket && asset?.storage_path) {
        void supabase.storage.from(asset.storage_bucket).createSignedUrl(asset.storage_path, 3600).then(({ data }) => { if (active) setLogoUrl(data?.signedUrl ?? null); });
      } else if (organizationResponse.data?.logo_url) setLogoUrl(organizationResponse.data.logo_url);
    });
    return () => { active = false; };
  }, [profile?.organizationId]);

  useEffect(() => {
    if (!profile?.organizationId || !draftIds) return;
    let active = true;
    void supabase.from('bob_generated_document_outputs').select('id,status,output_format,sha256,storage_bucket,storage_path').eq('organization_id', profile.organizationId).eq('document_id', draftIds.documentId).order('created_at', { ascending: false }).limit(20).then(({ data }) => {
      if (active) setOutputHistory((data as OutputReceipt[]) ?? []);
    });
    return () => { active = false; };
  }, [profile?.organizationId, draftIds]);

  const loadBrandAssets = async () => {
    if (!profile?.organizationId) return;
    const { data } = await supabase.from('organization_brand_assets').select('id,label,asset_kind,variant,status,asset_url,storage_bucket,storage_path,alt_text').eq('organization_id', profile.organizationId).order('updated_at', { ascending: false });
    setBrandAssets((data as BrandAsset[]) ?? []);
  };

  useEffect(() => { void loadBrandAssets(); }, [profile?.organizationId]);

  useEffect(() => {
    const sourceType = searchParams.get('sourceType');
    const sourceId = searchParams.get('sourceId');
    if (!sourceType || !sourceId || !profile?.organizationId) return;
    let active = true;
    const loadSourceContext = async () => {
      try {
        if (sourceType === 'site') {
          const { data: site } = await supabase.from('client_sites').select('id,name,address,site_type,site_brief,hs_notes,access_instructions').eq('id', sourceId).maybeSingle();
          if (active && site) {
            setSourceContext({
              type: 'site',
              id: site.id,
              label: `${site.name}${site.address ? ` (${site.address})` : ''}`,
              prompt: `Draft a site safety plan for ${site.name}. Site type: ${site.site_type || '[TO CONFIRM]'}. Existing brief: ${site.site_brief || '[TO CONFIRM]'}. Health and safety notes: ${site.hs_notes || '[TO CONFIRM]'}. Access instructions: ${site.access_instructions || '[TO CONFIRM]'}. Include hazards, controls, emergency procedures, and an approval checklist based on these details and attached reference materials.`,
            });
            setDocumentType('site_safety_plan');
            setTitle(`Site Safety Plan - ${site.name}`);
          }
        } else if (sourceType === 'cctv') {
          const { data: evidence } = await supabase.from('evidence_items').select('id,evidence_kind,storage_path,captured_at,metadata').eq('id', sourceId).maybeSingle();
          if (active && evidence) {
            setSourceContext({
              type: 'cctv',
              id: evidence.id,
              label: `CCTV ${evidence.evidence_kind || 'Evidence'}`,
              prompt: `Draft an incident report from the CCTV evidence review. Evidence captured: ${evidence.captured_at || '[TO CONFIRM]'}. Storage reference: ${evidence.storage_path || '[TO CONFIRM]'}. Metadata: ${JSON.stringify(evidence.metadata || {})}. Include what was observed, when, where, who was involved, and recommended next actions based on the evidence details and attached reference materials.`,
            });
            setDocumentType('incident_report');
            setTitle(`Incident Report - CCTV ${evidence.evidence_kind || 'Evidence'}`);
          }
        } else if (sourceType === 'notice' || sourceType === 'breach') {
          const { data: alert } = await supabase.from('breach_alerts').select('id,zone_id,observed_at,breach_type').eq('id', sourceId).maybeSingle();
          if (active && alert) {
            setSourceContext({
              type: sourceType,
              id: alert.id,
              label: `Breach Alert ${alert.breach_type || 'Notice'}`,
              prompt: sourceType === 'notice'
                ? `Draft a formal notice letter regarding the breach alert. Include the breach details, relevant policy/bylaw section, required actions, and response deadline based on the alert information and attached reference materials.`
                : `Draft an incident report from the breach alert. Separate observed facts from assumptions, include the location and timing, document immediate actions, and list recommended follow-up actions. Mark unknowns as [TO CONFIRM].`,
            });
            setDocumentType(sourceType === 'notice' ? 'letter' : 'incident_report');
            setTitle(`${sourceType === 'notice' ? 'Notice Letter' : 'Breach Incident Report'} - ${alert.breach_type || 'Breach Alert'}`);
          }
        }
      } catch (err) {
        console.error('Failed to load source context:', err);
      }
    };
    void loadSourceContext();
    return () => { active = false; };
  }, [searchParams, profile?.organizationId]);

  useEffect(() => {
    if (autoDraftStarted || searchParams.get('auto') !== '1' || !profile?.organizationId || !editor) return;
    const sourceType = searchParams.get('sourceType');
    const sourceId = searchParams.get('sourceId');
    if (!sourceType || !sourceId) return;
    setAutoDraftStarted(true);
    setSaveState('saving');
    void supabase.functions.invoke('bob-agentic-document-draft', { body: { sourceType, sourceId } }).then(({ data, error }) => {
      const draft = data?.draft;
      if (error || !draft?.document_id || !draft?.document_version_id) {
        setSaveState('error');
        setNotice(data?.error ?? error?.message ?? 'The agentic draft could not be prepared.');
        return;
      }
      setTitle(draft.title);
      setDocumentType(draft.document_type);
      editor.commands.setContent(draft.authored_html);
      setDraftIds({ documentId: draft.document_id, versionId: draft.document_version_id });
      setSaveState('needs_review');
      setNotice('Bob prepared this draft from source context and submitted it for human review.');
    });
  }, [autoDraftStarted, editor, profile?.organizationId, searchParams]);

  const uploadBrandAsset = async (file: File) => {
    if (!profile?.organizationId) return;
    setBrandBusy(true); setNotice(null);
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `org/${profile.organizationId}/brand-assets/${crypto.randomUUID()}-${safeName}`;
    const { error: uploadError } = await supabase.storage.from('bob-uploads').upload(storagePath, file, { contentType: file.type || 'application/octet-stream', upsert: false });
    if (uploadError) { setNotice(uploadError.message); setBrandBusy(false); return; }
    const { error: registerError } = await supabase.rpc('register_organization_brand_asset', {
      p_organization_id: profile.organizationId, p_asset_kind: 'logo', p_variant: 'default', p_label: file.name,
      p_storage_bucket: 'bob-uploads', p_storage_path: storagePath, p_mime_type: file.type || null,
      p_alt_text: `${organizationName} logo`, p_usage_scope: 'documents',
    });
    if (registerError) setNotice(registerError.message);
    else setNotice('Brand asset uploaded and queued for administrator approval.');
    await loadBrandAssets(); setBrandBusy(false);
  };

  const reviewBrandAsset = async (asset: BrandAsset, decision: 'approved' | 'revoked') => {
    setBrandBusy(true); setNotice(null);
    const { error } = await supabase.rpc('review_organization_brand_asset', { p_asset_id: asset.id, p_decision: decision, p_reason: decision === 'approved' ? 'Approved for organization document use.' : 'Revoked from organization document use.' });
    if (error) setNotice(error.message); else setNotice(`Brand asset ${decision}.`);
    await loadBrandAssets(); setBrandBusy(false);
  };

  useEffect(() => {
    if (!profile?.organizationId) return;
    let active = true;
    setDraftsLoading(true);
    void supabase.from('documents')
      .select('id,original_filename,updated_at,source_channel,current_scope,document_versions(id,extracted_text,metadata_json,created_at)')
      .or(`organization_id.eq.${profile.organizationId},organization_id.is.null`)
      .order('updated_at', { ascending: false })
      .limit(20)
      .then(({ data }) => {
        if (!active) return;
        const rows = (data as Array<{ id: string; original_filename: string; updated_at: string; source_channel: string; current_scope: string; document_versions?: Array<{ id: string; extracted_text: string | null; metadata_json: Record<string, unknown>; created_at: string }> }> ?? []);
        setDrafts(rows.flatMap((row) => {
          const version = [...(row.document_versions ?? [])].sort((left, right) => right.created_at.localeCompare(left.created_at))[0];
          if (!version) return [];
          const metadata = version.metadata_json ?? {};
          return [{
            id: row.id,
            title: String(metadata.title ?? row.original_filename.replace(/\.html$/i, '')),
            updatedAt: row.updated_at,
            versionId: version.id,
            status: String(metadata.authoring_status ?? 'draft'),
            html: String(metadata.authoring_html ?? `<p>${version.extracted_text ?? ''}</p>`),
            text: version.extracted_text ?? '',
            documentType: String(metadata.document_type ?? 'custom'),
            sourceChannel: row.source_channel,
            currentScope: row.current_scope,
            authorable: row.source_channel === 'system_generated' && Boolean(metadata.authoring_html),
          }];
        }));
        setDraftsLoading(false);
      });
    return () => { active = false; };
  }, [profile?.organizationId]);

  const searchReferences = async () => {
    if (!referenceQuery.trim()) return;
    setSearching(true);
    setNotice(null);
    const { data, error } = await supabase.functions.invoke('bob-document-search', {
      body: { query: referenceQuery.trim(), scope: 'both', limit: 12 },
    });
    setSearching(false);
    if (error || !data?.success) {
      setNotice(error?.message ?? data?.error ?? 'Reference search failed.');
      return;
    }
    setReferences((data.results as ReferenceResult[]) ?? []);
  };

  const toggleReference = (reference: ReferenceResult) => {
    setSelectedReferences((current) => current.some((item) => item.catalog_entry_id === reference.catalog_entry_id)
      ? current.filter((item) => item.catalog_entry_id !== reference.catalog_entry_id)
      : [...current, reference]);
  };

  const insertCitation = (reference: ReferenceResult) => {
    const citation = `<p><em>Source: ${reference.title}${reference.publisher ? ` — ${reference.publisher}` : ''}${reference.jurisdiction ? ` (${reference.jurisdiction})` : ''}. Approved reference; verify the cited source before final approval.</em></p>`;
    editor?.commands.insertContent(citation);
    editor?.commands.focus('end');
  };

  const saveDraft = async () => {
    if (!profile?.organizationId || !profile.id || !editor) return;
    const authoredHtml = editor.getHTML().trim();
    const authoredText = editor.getText().trim();
    if (!authoredText) {
      setNotice('Add some content before saving the draft.');
      return;
    }
    setSaveState('saving');
    setNotice(null);
    const revisionPayload = {
      p_title: title.trim() || 'Untitled Bob document',
      p_document_type: documentType,
      p_authored_html: authoredHtml,
      p_authored_text: authoredText,
      p_reference_handles: selectedReferences.map((reference) => reference.retrieval_handle),
      p_reference_metadata: selectedReferences.map(({ title: referenceTitle, publisher, jurisdiction, trust_level }) => ({ title: referenceTitle, publisher, jurisdiction, trust_level })),
    };
    const { data: draftResult, error: draftError } = draftIds
      ? await supabase.rpc('save_bob_document_revision', { ...revisionPayload, p_document_id: draftIds.documentId, p_supersedes_version_id: draftIds.versionId })
      : await supabase.rpc('create_bob_document_draft', revisionPayload);
    if (draftError || !draftResult?.ok) {
      setSaveState('error');
      setNotice(draftError?.message ?? draftResult?.error ?? 'The document draft could not be saved.');
      return;
    }
    setDraftIds({ documentId: draftResult.document_id, versionId: draftResult.document_version_id });
    setSaveState('saved');
    setNotice('Draft saved to the conversation-only document library. Human review is still required before promotion.');
  };

  const submitForReview = async () => {
    if (!draftIds) return;
    setSaveState('reviewing');
    setNotice(null);
    const { data, error } = await supabase.rpc('submit_bob_document_for_review', {
      p_document_id: draftIds.documentId,
      p_document_version_id: draftIds.versionId,
      p_review_reason: reviewReason.trim(),
    });
    if (error || !data?.ok) {
      setSaveState('error');
      setNotice(error?.message ?? data?.error ?? 'The document could not be submitted for review.');
      return;
    }
    setSaveState('needs_review');
    setNotice('Submitted for human review. The document remains conversation-only until an approved promotion is completed.');
  };

  const decideReview = async (decision: 'approved' | 'rejected') => {
    if (!draftIds) return;
    setSaveState('reviewing');
    setNotice(null);
    const { data, error } = await supabase.rpc('review_bob_document_draft', {
      p_document_id: draftIds.documentId,
      p_document_version_id: draftIds.versionId,
      p_decision: decision,
      p_review_reason: decisionReason.trim(),
    });
    if (error || !data?.ok) {
      setSaveState('error');
      setNotice(error?.message ?? data?.error ?? 'The review decision could not be recorded.');
      return;
    }
    setSaveState(decision === 'approved' ? 'saved' : 'error');
    setNotice(decision === 'approved' ? 'Approved with a durable review receipt. Promotion remains a separate governed action.' : 'Rejected with a durable review receipt. Create a revision after addressing the reviewer reason.');
  };

  const outputLabel = (format: OutputReceipt['output_format']) => format === 'docx' ? 'DOCX' : 'Print PDF';

  const requestDocumentOutput = async () => {
    if (!draftIds || saveState !== 'saved') return;
    setOutputBusy(true); setNotice(null);
    const { data: receipt, error: requestError } = await supabase.rpc('request_bob_document_output', {
      p_document_id: draftIds.documentId,
      p_document_version_id: draftIds.versionId,
      p_output_format: outputFormat,
    });
    if (requestError || !receipt?.id) {
      setNotice(requestError?.message ?? `Only an approved document can request ${outputLabel(outputFormat).toLowerCase()} output.`);
      setOutputBusy(false);
      return;
    }
    setOutputReceipt(receipt as OutputReceipt);
    setOutputHistory((current) => [receipt as OutputReceipt, ...current.filter((item) => item.id !== receipt.id)]);
    const { data: generated, error: generationError } = await supabase.functions.invoke('generate-bob-document-output', { body: { output_id: receipt.id } });
    if (generationError || !generated?.output) setNotice(generationError?.message ?? generated?.error ?? `${outputLabel(outputFormat)} output could not be generated.`);
    else {
      const ready = generated.output as OutputReceipt;
      setOutputReceipt(ready);
      setOutputHistory((current) => [ready, ...current.filter((item) => item.id !== ready.id)]);
      if (!ready.storage_bucket || !ready.storage_path) setNotice('The output receipt is missing its private storage location. It was not opened.');
      else {
        const { data: signed, error: signedError } = await supabase.storage.from(ready.storage_bucket).createSignedUrl(ready.storage_path, 900);
        if (signedError) setNotice(signedError.message); else if (signed?.signedUrl) window.open(signed.signedUrl, '_blank', 'noopener,noreferrer');
      }
    }
    setOutputBusy(false);
  };

  const openOutput = async () => {
    if (!outputReceipt?.storage_bucket || !outputReceipt.storage_path) return;
    const { data, error } = await supabase.storage.from(outputReceipt.storage_bucket).createSignedUrl(outputReceipt.storage_path, 900);
    if (error) setNotice(error.message);
    else if (data?.signedUrl) window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
  };

  const insertTemplate = (template: string) => {
    editor?.commands.setContent(template);
    editor?.commands.focus('end');
  };

  const resumeDraft = (draft: DraftSummary) => {
    setSelectedFile(draft);
    if (!draft.authorable) {
      return;
    }
    setTitle(draft.title);
    setDocumentType(draft.documentType);
    setDraftIds({ documentId: draft.id, versionId: draft.versionId });
    setSaveState(draft.status === 'needs_review' ? 'needs_review' : 'saved');
    setOutputReceipt(null);
    editor?.commands.setContent(draft.html);
    editor?.commands.focus('end');
    setNotice(`Resumed ${draft.status.replaceAll('_', ' ')} draft. Review its source and state before continuing.`);
  };

  const fileSpaceFor = (draft: DraftSummary) => {
    const name = draft.title.toLowerCase();
    if (draft.authorable && draft.sourceChannel === 'system_generated') return 'Generated Outputs';
    if (draft.currentScope === 'quarantined') return 'Bob Intake';
    if (/contract|agreement|terms|proposal|rfq/.test(name)) return 'Contracts';
    if (/hr|employment|discip|credential|certificate/.test(name)) return 'HR and People';
    if (/invoice|finance|cost|expense|pay/.test(name)) return 'Finance';
    if (/cctv|evidence|incident|report|photo|video/.test(name)) return 'Evidence';
    if (/site|patrol|assignment|attendance|safety/.test(name)) return 'Sites and Operations';
    return 'Organisation';
  };
  const visibleDrafts = drafts.filter((draft) => fileSpaceFor(draft) === fileSpace && (!fileSearch.trim() || draft.title.toLowerCase().includes(fileSearch.trim().toLowerCase())));

  return (
    <main className="bob-document-page">
      <header className="bob-document-topbar">
        <div className="bob-document-brand"><span><Sparkles size={17} /></span><div><strong>Bob document studio</strong><small>Author, reference, review, promote</small></div></div>
        <div className="bob-document-top-actions">
          <span className={`bob-save-state is-${saveState}`} role="status">{saveState === 'saving' ? 'Saving…' : saveState === 'reviewing' ? 'Submitting…' : saveState === 'saved' ? 'Saved draft' : saveState === 'needs_review' ? 'Needs review' : 'Draft'}</span>
          <button type="button" className="bob-document-secondary" onClick={() => navigate('/admin/bob')}><X size={15} /> Close</button>
          <button type="button" className="bob-document-primary" onClick={() => void saveDraft()} disabled={saveState === 'saving'}><Save size={15} /> Save draft</button>
          {draftIds && saveState === 'saved' && <button type="button" className="bob-document-review" onClick={() => void submitForReview()}>Submit for review</button>}
          {draftIds && saveState === 'needs_review' && <><button type="button" className="bob-document-reject" onClick={() => void decideReview('rejected')}>Reject</button><button type="button" className="bob-document-review" onClick={() => void decideReview('approved')}>Approve</button></>}
          {draftIds && saveState === 'saved' && <label className="bob-output-format">Output<select value={outputFormat} onChange={(event) => { setOutputFormat(event.target.value as OutputFormat); setOutputReceipt(null); }}><option value="print">Print PDF</option><option value="docx">DOCX</option></select></label>}
          {draftIds && saveState === 'saved' && <button type="button" className="bob-document-output" onClick={() => outputReceipt?.status === 'ready' ? void openOutput() : void requestDocumentOutput()} disabled={outputBusy}>{outputBusy ? 'Generating…' : outputReceipt?.status === 'ready' ? `Open ${outputLabel(outputReceipt.output_format)}` : `Generate ${outputLabel(outputFormat)}`}</button>}
        </div>
      </header>

      <div className="bob-document-layout">
        <aside className="bob-document-outline" aria-label="Document files and setup">
          <div className="bob-document-section-heading"><span>Files</span><FilePlus2 size={15} /></div>
          <label className="bob-file-search" htmlFor="bob-file-search"><Search size={13} /><input id="bob-file-search" aria-label="Search document files" placeholder="Search files" value={fileSearch} onChange={(event) => setFileSearch(event.target.value)} /></label>
          <div className="bob-file-spaces" aria-label="Document spaces">{FILE_SPACES.map((space) => <button type="button" key={space} className={fileSpace === space ? 'is-active' : ''} onClick={() => setFileSpace(space)}>{space}</button>)}</div>
          <div className="bob-document-section-heading"><span>{fileSpace}</span><small>{visibleDrafts.length} files</small></div>
          <div className="bob-document-drafts" aria-label="Document files">
            {draftsLoading ? <p>Loading files…</p> : visibleDrafts.length === 0 ? <p>No files in this space.</p> : visibleDrafts.map((draft) => <button type="button" key={draft.id} className={selectedFile?.id === draft.id ? 'is-selected' : ''} onClick={() => resumeDraft(draft)}><strong>{draft.title}</strong><small>{draft.authorable ? draft.status.replaceAll('_', ' ') : `${draft.currentScope.replaceAll('_', ' ')} · inspect`}</small></button>)}
          </div>
          {selectedFile && <section className="bob-file-inspector" aria-label="Selected file details"><strong>{selectedFile.title}</strong><dl><div><dt>State</dt><dd>{selectedFile.status.replaceAll('_', ' ')}</dd></div><div><dt>Scope</dt><dd>{selectedFile.currentScope.replaceAll('_', ' ')}</dd></div><div><dt>Source</dt><dd>{selectedFile.sourceChannel.replaceAll('_', ' ')}</dd></div></dl>{selectedFile.authorable ? <button type="button" onClick={() => resumeDraft(selectedFile)}>Resume draft</button> : <button type="button" onClick={() => navigate(`/admin/files?document=${encodeURIComponent(selectedFile.id)}`)}>Open in Files workspace</button>}</section>}
          <div className="bob-document-section-heading"><span>Document setup</span></div>
          {sourceContext && <div className="bob-source-context" role="status" aria-label="Source context for document"><span className="bob-source-type">{sourceContext.type.replace('_', ' ').toUpperCase()}</span><strong>{sourceContext.label}</strong><p className="bob-source-prompt">{sourceContext.prompt}</p></div>}
          <label htmlFor="bob-document-title">Title<input id="bob-document-title" aria-label="Document title" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label htmlFor="bob-document-type">Type<select id="bob-document-type" aria-label="Document type" value={documentType} onChange={(event) => setDocumentType(event.target.value)}>
            <option value="site_safety_plan">Site safety plan</option><option value="risk_assessment">Security risk assessment</option><option value="incident_report">Incident / near miss</option><option value="corrective_action">Corrective action review</option><option value="emergency_plan">Emergency response plan</option><option value="working_alone_plan">Working-alone plan</option><option value="training_record">Training / competency record</option><option value="customer_review">Customer service review</option><option value="report">Operational report</option><option value="letter">Controlled correspondence</option><option value="policy">Policy / SOP</option><option value="proposal">Proposal / RFQ</option><option value="evidence_package">Evidence package</option><option value="custom">Custom</option>
          </select></label>
          <div className="bob-document-template-heading">Start with structure</div>
          <button type="button" onClick={() => insertTemplate('<h1>Report title</h1><p><strong>Purpose</strong></p><p>Describe the decision this document supports.</p><h2>Findings</h2><p>Record evidence-backed findings and mark unknowns as [TO CONFIRM].</p><h2>Recommended next action</h2><p>State the safe next step and owner.</p>')}>Report structure</button>
          <button type="button" onClick={() => insertTemplate('<h1>Proposal</h1><p><strong>Decision requested</strong></p><p>Describe the decision and approval boundary.</p><h2>Evidence and assumptions</h2><p>List source-backed facts and open assumptions.</p><h2>Approval checklist</h2><ul><li>Human owner identified</li><li>Source evidence reviewed</li></ul>')}>Proposal structure</button>
          <button type="button" onClick={() => insertTemplate('<h1>Site safety plan</h1><p><strong>Site and activity</strong></p><p>Identify the agreement, place, work activity, affected people, and review owner.</p><h2>Hazards and controls</h2><p>Record each hazard, existing control, proposed control, residual risk, and evidence. Mark unknowns as [TO CONFIRM].</p><h2>Emergency and escalation</h2><p>State the emergency response, supervisor, contact path, and worker acknowledgement required.</p><h2>Review and approval</h2><p>Record reviewer, approval date, expiry/review date, and unresolved actions.</p>')}>Site safety structure</button>
          <button type="button" onClick={() => insertTemplate('<h1>Incident and corrective action</h1><p><strong>What happened</strong></p><p>Record the time, place, people, work activity, immediate actions, and evidence.</p><h2>Investigation</h2><p>Separate observed facts from provisional contributing factors. Do not state a root cause until reviewed.</p><h2>Actions</h2><ul><li>Owner and due date</li><li>Control change required</li><li>Effectiveness review</li></ul>')}>Incident structure</button>
          <div className="bob-document-brand-status" role="status"><strong>{organizationName}</strong>{logoUrl ? <img src={logoUrl} alt={`${organizationName} approved logo`} /> : <span>No approved organization logo is configured. The draft will not invent branding.</span>}<label className="bob-brand-upload"><Upload size={13} /> Upload brand asset<input type="file" accept="image/png,image/jpeg,image/svg+xml" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadBrandAsset(file); event.currentTarget.value = ''; }} disabled={brandBusy} /></label>{brandAssets.filter((asset) => asset.status === 'pending').map((asset) => <div className="bob-brand-pending" key={asset.id}><span>{asset.label} · pending approval</span><button type="button" onClick={() => void reviewBrandAsset(asset, 'approved')} disabled={brandBusy}><CheckCircle2 size={13} /> Approve</button></div>)}</div>
          <div className="bob-document-safety"><ShieldCheck size={15} /><span>Draft only. Bob cannot silently publish, sign, or promote this document.</span></div>
        </aside>

        <section className="bob-editor-shell" aria-label="Document editor">
          <div className="bob-editor-toolbar" role="toolbar" aria-label="Formatting tools">
            <button type="button" onClick={() => editor?.chain().focus().toggleBold().run()} title="Bold" aria-label="Bold" aria-pressed={editor?.isActive('bold')}><Bold size={16} /></button>
            <button type="button" onClick={() => editor?.chain().focus().toggleItalic().run()} title="Italic" aria-label="Italic" aria-pressed={editor?.isActive('italic')}><Italic size={16} /></button>
            <span />
            <button type="button" onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} title="Heading" aria-label="Heading" aria-pressed={editor?.isActive('heading', { level: 2 })}><Heading2 size={16} /></button>
            <button type="button" onClick={() => editor?.chain().focus().toggleBulletList().run()} title="Bulleted list" aria-label="Bulleted list" aria-pressed={editor?.isActive('bulletList')}><List size={16} /></button>
            <button type="button" onClick={() => editor?.chain().focus().toggleOrderedList().run()} title="Numbered list" aria-label="Numbered list" aria-pressed={editor?.isActive('orderedList')}><ListOrdered size={16} /></button>
            <span />
            <button type="button" onClick={() => editor?.chain().focus().undo().run()} title="Undo" aria-label="Undo">↶</button>
            <button type="button" onClick={() => editor?.chain().focus().redo().run()} title="Redo" aria-label="Redo">↷</button>
          </div>
          <div className="bob-editor-paper-wrap">
            <div className="bob-editor-paper" role="textbox" aria-label="Document content" aria-multiline="true"><EditorContent editor={editor} /></div>
          </div>
          {notice && <p className="bob-document-notice" role={saveState === 'error' ? 'alert' : 'status'}>{notice}</p>}
          {outputReceipt?.status === 'ready' && <p className="bob-output-receipt" role="status"><CheckCircle2 size={14} /><span>{outputLabel(outputReceipt.output_format)} ready · SHA-256 {outputReceipt.sha256?.slice(0, 16) ?? 'unavailable'}…</span><button type="button" onClick={() => void openOutput()}>Open again</button></p>}
          {outputHistory.length > 0 && <section className="bob-output-history" aria-label="Generated document outputs"><strong>Generated outputs</strong>{outputHistory.map((output) => <div key={output.id}><span>{outputLabel(output.output_format)} · {output.status}</span><small>{output.sha256 ? `SHA-256 ${output.sha256.slice(0, 16)}…` : 'Checksum pending'}</small>{output.status === 'ready' && <button type="button" onClick={() => { setOutputReceipt(output); void openOutput(); }}>Open</button>}</div>)}</section>}
          {draftIds && saveState === 'saved' && <label className="bob-review-reason">Review reason<textarea value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} maxLength={1000} rows={2} /></label>}
          {draftIds && saveState === 'needs_review' && <label className="bob-review-reason">Reviewer rationale<textarea value={decisionReason} onChange={(event) => setDecisionReason(event.target.value)} maxLength={1000} rows={2} /></label>}
        </section>

        <aside className="bob-reference-rail" aria-label="Reference material">
          <div className="bob-reference-heading"><div><span>Reference material</span><strong>Approved sources</strong></div><PanelRight size={16} /></div>
          <div className="bob-reference-search"><Search size={14} /><input value={referenceQuery} onChange={(event) => setReferenceQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void searchReferences(); }} placeholder="Search bylaws, policies, reports…" aria-label="Search reference material" /><button type="button" onClick={() => void searchReferences()} disabled={searching} aria-label="Search references"><Search size={14} /></button></div>
          <div className="bob-reference-selected"><strong>Selected for this draft</strong><small>{selectedReferences.length} approved source{selectedReferences.length === 1 ? '' : 's'} attached to the saved version.</small>{selectedReferences.length === 0 ? <p>No references selected.</p> : selectedReferences.map((reference) => <div className="bob-reference-selected-item" key={reference.catalog_entry_id}><button type="button" onClick={() => toggleReference(reference)}>{reference.title}<span>Remove</span></button><button type="button" className="bob-reference-cite" onClick={() => insertCitation(reference)}>Insert citation</button></div>)}</div>
          <div className="bob-reference-results">{references.length === 0 ? <p>{searching ? 'Searching approved sources…' : 'Search approved sources to ground the document.'}</p> : references.map((reference) => <button type="button" key={reference.catalog_entry_id} className={selectedReferences.some((item) => item.catalog_entry_id === reference.catalog_entry_id) ? 'is-selected' : ''} onClick={() => toggleReference(reference)}><strong>{reference.title}</strong><small>{[reference.document_type, reference.jurisdiction, reference.publisher].filter(Boolean).join(' · ') || 'Approved reference'}</small><em>{reference.trust_level}</em><Check size={14} /></button>)}</div>
        </aside>
      </div>
    </main>
  );
}
