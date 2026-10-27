import { isAdminTierRole } from '../lib/roles';
import React, { useEffect, useState } from 'react';
import { AlertTriangle, Bold, Check, CheckCircle2, FilePlus2, Heading2, Italic, List, ListOrdered, PanelRight, Save, Search, ShieldCheck, Sparkles, Upload, X } from 'lucide-react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { GeneratedArtifactActions } from '../components/GeneratedArtifactActions';
import './BobDocumentStudioPage.css';
import './BobDocumentStudioSourceReview.css';

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

type SaveState = 'idle' | 'saving' | 'saved' | 'reviewing' | 'needs_review' | 'approved' | 'error';
type OutputFormat = 'print' | 'docx';
type DraftSummary = { id: string; title: string; updatedAt: string; versionId: string; status: string; html: string; text: string; documentType: string; sourceChannel: string; currentScope: string; authorable: boolean };
type SourcePromotionProposal = { id: string; document_version_id: string; target_type: string; status: string; proposed_payload: Record<string, unknown>; source_map: Record<string, unknown>; created_at: string; review_reason: string | null };
type SourceClassification = { privacy_class: string; confidence: number | null; rationale: string | null; contains_pii: boolean; contains_operational_security: boolean; contains_financial_data: boolean; contains_legal_privilege: boolean; classifier_source: string; reviewed_at: string | null; created_at: string };
type SourceProposalTarget = 'crm_agreement' | 'site_brief' | 'credential' | 'finance_reconciliation' | 'hr_case' | 'investigation_link';
type BrandAsset = { id: string; label: string; asset_kind: string; variant: string; status: string; asset_url: string | null; storage_bucket: string | null; storage_path: string | null; alt_text: string | null };
type OutputReceipt = { id: string; status: string; output_format: OutputFormat | 'pdf'; sha256: string | null; storage_bucket: string | null; storage_path: string | null };
const FILE_SPACES = ['Organisation', 'Contracts', 'Sites and Operations', 'HR and People', 'Finance', 'Evidence', 'Investigations', 'Bob Intake', 'Generated Outputs'];

function fileSpaceForDraft(draft: DraftSummary): string {
  const name = draft.title.toLowerCase();
  if (draft.authorable && draft.sourceChannel === 'system_generated') return 'Generated Outputs';
  if (draft.currentScope === 'quarantined') return 'Bob Intake';
  if (/contract|agreement|terms|proposal|rfq/.test(name)) return 'Contracts';
  if (/hr|employment|discip|credential|certificate/.test(name)) return 'HR and People';
  if (/invoice|finance|cost|expense|pay/.test(name)) return 'Finance';
  if (/cctv|evidence|incident|report|photo|video/.test(name)) return 'Evidence';
  if (/site|patrol|assignment|attendance|safety/.test(name)) return 'Sites and Operations';
  return 'Organisation';
}

export default function BobDocumentStudioPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedDocumentId = searchParams.get('document');
  const requestedVersionId = searchParams.get('version');
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
  const [sourceProposals, setSourceProposals] = useState<SourcePromotionProposal[]>([]);
  const [sourceProposalReasons, setSourceProposalReasons] = useState<Record<string, string>>({});
  const [sourceProposalBusyId, setSourceProposalBusyId] = useState<string | null>(null);
  const [sourceClassification, setSourceClassification] = useState<SourceClassification | null>(null);
  const [sourceOcrRequired, setSourceOcrRequired] = useState(false);
  const [classificationForm, setClassificationForm] = useState({ privacyClass: 'tenant_sensitive', containsPii: false, containsOperationalSecurity: false, containsFinancialData: false, containsLegalPrivilege: false, reason: '' });
  const [classificationBusy, setClassificationBusy] = useState(false);
  const [proposalTarget, setProposalTarget] = useState<SourceProposalTarget>('crm_agreement');
  const [proposalBusy, setProposalBusy] = useState(false);
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
          const { data: alert } = await supabase.from('breach_alerts').select('id,zone_id,created_at,breach_type,notes,action_type,status').eq('id', sourceId).maybeSingle();
          if (active && alert) {
            setSourceContext({
              type: sourceType,
              id: alert.id,
              label: `Breach Alert ${alert.breach_type || 'Notice'}`,
              prompt: sourceType === 'notice'
                ? `Draft a formal notice letter regarding the breach alert. Include the breach details, relevant policy/bylaw section, required actions, and response deadline based on the alert information and attached reference materials.`
                : `Draft an incident report from the breach alert. Alert created: ${alert.created_at || '[TO CONFIRM]'}. Notes: ${alert.notes || '[TO CONFIRM]'}. Action: ${alert.action_type || '[TO CONFIRM]'}. Status: ${alert.status || '[TO CONFIRM]'}. Separate observed facts from assumptions, include the location and timing, document immediate actions, and list recommended follow-up actions. Mark unknowns as [TO CONFIRM].`,
            });
            setDocumentType(sourceType === 'notice' ? 'letter' : 'incident_report');
            setTitle(`${sourceType === 'notice' ? 'Notice Letter' : 'Breach Incident Report'} - ${alert.breach_type || 'Breach Alert'}`);
          }
        } else if (sourceType === 'debrief') {
          const { data: debrief } = await supabase.from('shift_debriefs').select('id,summary,safety_incident_reported,equipment_issue_reported,follow_up_required,follow_up_notes,submitted_at').eq('id', sourceId).maybeSingle();
          if (active && debrief) {
            setSourceContext({
              type: 'debrief',
              id: debrief.id,
              label: `Shift Debrief (${debrief.submitted_at ? debrief.submitted_at.slice(0, 10) : 'Handover'})`,
              prompt: `Draft a handover report from the shift debrief. Summary: ${debrief.summary || '[TO CONFIRM]'}. Safety incident: ${debrief.safety_incident_reported ? 'Yes' : 'No'}. Equipment issue: ${debrief.equipment_issue_reported ? 'Yes' : 'No'}. Follow-up notes: ${debrief.follow_up_notes || '[TO CONFIRM]'}. Separate observed facts from assumptions and list required follow-up actions with owners and deadlines.`,
            });
            setDocumentType(debrief.safety_incident_reported ? 'incident_report' : debrief.equipment_issue_reported || debrief.follow_up_required ? 'corrective_action' : 'report');
            setTitle(`Shift Debrief Report - ${debrief.submitted_at ? debrief.submitted_at.slice(0, 10) : 'Handover'}`);
          }
        } else if (sourceType === 'company') {
          // Grounds a capability statement in the org's own record, live service lines and client
          // count, so the draft states what the business demonstrably does rather than a guess.
          const [organizationResponse, moduleResponse, agreementResponse] = await Promise.all([
            supabase.from('organizations').select('id,name,nzbn,contact_email,contact_phone,organization_type').eq('id', sourceId).maybeSingle(),
            supabase.from('organization_modules').select('module_key').eq('organization_id', sourceId).eq('enabled', true),
            supabase.from('service_agreements').select('client_organization_id').eq('provider_organization_id', sourceId),
          ]);
          const organization = organizationResponse.data;
          if (active && organization) {
            const serviceLines = (moduleResponse.data ?? []).map((row) => String(row.module_key).replaceAll('_', ' '));
            const clientCount = new Set((agreementResponse.data ?? []).map((row) => row.client_organization_id)).size;
            setSourceContext({
              type: 'company',
              id: organization.id,
              label: organization.name,
              prompt: `Draft a capability statement for ${organization.name}. NZBN: ${organization.nzbn || '[TO CONFIRM]'}. Contact: ${organization.contact_email || '[TO CONFIRM]'} / ${organization.contact_phone || '[TO CONFIRM]'}. Service lines currently operated in the platform: ${serviceLines.length ? serviceLines.join(', ') : '[TO CONFIRM]'}. Client organisations under active service agreements: ${clientCount || '[TO CONFIRM]'}. Cover who the company is, the services it delivers, its operating scale, and how work is evidenced and reported. Use only the facts given here plus attached source files; mark licences, certifications, insurance, and anything else not supplied as [TO CONFIRM] rather than estimating.`,
            });
            setDocumentType('capability_statement');
            setTitle(`Capability Statement - ${organization.name}`);
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
      editor?.commands?.setContent(draft.authored_html);
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
    const select = 'id,original_filename,updated_at,source_channel,current_scope,document_versions(id,extracted_text,metadata_json,created_at)';
    const recentDocuments = supabase.from('documents')
      .select(select)
      .or(`organization_id.eq.${profile.organizationId},organization_id.is.null`)
      .order('updated_at', { ascending: false })
      .limit(20);
    const requestedDocument = requestedDocumentId
      ? supabase.from('documents').select(select).eq('id', requestedDocumentId).maybeSingle()
      : Promise.resolve({ data: null });
    void Promise.all([recentDocuments, requestedDocument])
      .then(([recentResponse, requestedResponse]) => {
        if (!active) return;
        const rows = (recentResponse.data as Array<{ id: string; original_filename: string; updated_at: string; source_channel: string; current_scope: string; document_versions?: Array<{ id: string; extracted_text: string | null; metadata_json: Record<string, unknown>; created_at: string }> }> ?? []);
        const requestedRow = requestedResponse.data as typeof rows[number] | null;
        if (requestedRow && !rows.some((row) => row.id === requestedRow.id)) rows.unshift(requestedRow);
        setDrafts(rows.flatMap((row) => {
          const versions = [...(row.document_versions ?? [])].sort((left, right) => right.created_at.localeCompare(left.created_at));
          const version = row.id === requestedDocumentId && requestedVersionId
            ? versions.find((item) => item.id === requestedVersionId)
            : versions[0];
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
  }, [profile?.organizationId, requestedDocumentId, requestedVersionId]);

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
    editor?.commands?.insertContent(citation);
    editor?.commands?.focus('end');
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
    setSaveState(decision === 'approved' ? 'approved' : 'error');
    setNotice(decision === 'approved' ? 'Approved with a durable review receipt. You can now generate an output.' : 'Rejected with a durable review receipt. Create a revision after addressing the reviewer reason.');
  };

  const outputLabel = (format: OutputReceipt['output_format']) => format === 'docx' ? 'DOCX' : 'Print PDF';

  const requestDocumentOutput = async () => {
    if (!draftIds || saveState !== 'approved') return;
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
    if (generationError || !generated?.output) {
      setNotice(generationError?.message ?? generated?.error ?? `${outputLabel(outputFormat)} output could not be generated.`);
    } else {
      const ready = generated.output as OutputReceipt;
      setOutputReceipt(ready);
      setOutputHistory((current) => [ready, ...current.filter((item) => item.id !== ready.id)]);
      if (!ready.storage_bucket || !ready.storage_path) setNotice('The output receipt is missing its private storage location. It was not opened.');
    }
    setOutputBusy(false);
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
    setSaveState(draft.status === 'needs_review' ? 'needs_review' : draft.status === 'approved' ? 'approved' : 'saved');
    setOutputReceipt(null);
    editor?.commands.setContent(draft.html);
    editor?.commands.focus('end');
    setNotice(`Resumed ${draft.status.replaceAll('_', ' ')} draft. Review its source and state before continuing.`);
  };

  useEffect(() => {
    if (!requestedDocumentId || !profile?.organizationId || !editor) return;
    if (selectedFile?.id === requestedDocumentId && (!requestedVersionId || selectedFile.versionId === requestedVersionId)) return;
    let active = true;

    const openRequestedDocument = async () => {
      const existingDraft = drafts.find((draft) => draft.id === requestedDocumentId && (!requestedVersionId || draft.versionId === requestedVersionId));
      if (existingDraft) {
        setFileSpace(fileSpaceForDraft(existingDraft));
        resumeDraft(existingDraft);
        return;
      }

      const { data, error } = await supabase.from('documents')
        .select('id,original_filename,updated_at,source_channel,current_scope,document_versions(id,extracted_text,metadata_json,created_at)')
        .eq('id', requestedDocumentId)
        .maybeSingle();
      if (!active) return;
      if (error || !data) {
        setNotice(error?.message ?? 'The requested document is not available in this organization.');
        return;
      }
      const versions = (data.document_versions ?? []) as Array<{ id: string; extracted_text: string | null; metadata_json: Record<string, unknown>; created_at: string }>;
      const version = requestedVersionId
        ? versions.find((item) => item.id === requestedVersionId)
        : [...versions].sort((left, right) => right.created_at.localeCompare(left.created_at))[0];
      if (!version) {
        setNotice('The requested document version is no longer available.');
        return;
      }
      const metadata = version.metadata_json ?? {};
      const draft: DraftSummary = {
        id: data.id,
        title: String(metadata.title ?? data.original_filename.replace(/\.html$/i, '')),
        updatedAt: data.updated_at,
        versionId: version.id,
        status: String(metadata.authoring_status ?? 'draft'),
        html: String(metadata.authoring_html ?? `<p>${version.extracted_text ?? ''}</p>`),
        text: version.extracted_text ?? '',
        documentType: String(metadata.document_type ?? 'custom'),
        sourceChannel: data.source_channel,
        currentScope: data.current_scope,
        authorable: data.source_channel === 'system_generated' && Boolean(metadata.authoring_html),
      };
      setDrafts((current) => [draft, ...current.filter((item) => item.id !== draft.id)]);
      setFileSpace(fileSpaceForDraft(draft));
      resumeDraft(draft);
    };

    void openRequestedDocument();
    return () => { active = false; };
  }, [drafts, editor, profile?.organizationId, requestedDocumentId, requestedVersionId, selectedFile]);

  useEffect(() => {
    const versionId = selectedFile?.versionId;
    if (!versionId) {
      setSourceProposals([]);
      setSourceProposalReasons({});
      return undefined;
    }
    let active = true;
    void supabase.from('document_promotion_proposals')
      .select('id,document_version_id,target_type,status,proposed_payload,source_map,created_at,review_reason')
      .eq('document_version_id', versionId)
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (!active) return;
        if (error) {
          setSourceProposals([]);
          setNotice(error.message);
        } else setSourceProposals((data as SourcePromotionProposal[]) ?? []);
      });
    return () => { active = false; };
  }, [selectedFile?.versionId]);

  useEffect(() => {
    const versionId = selectedFile?.versionId;
    if (!versionId) {
      setSourceClassification(null);
      setSourceOcrRequired(false);
      return undefined;
    }
    let active = true;
    void supabase.from('document_versions')
      .select('id,ocr_required,document_classifications(privacy_class,confidence,rationale,contains_pii,contains_operational_security,contains_financial_data,contains_legal_privilege,classifier_source,reviewed_at,created_at)')
      .eq('id', versionId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active) return;
        if (error) {
          setNotice(error.message);
          return;
        }
        const classifications = (data?.document_classifications ?? []) as SourceClassification[];
        const latest = [...classifications].sort((left, right) => right.created_at.localeCompare(left.created_at))[0] ?? null;
        setSourceClassification(latest);
        setSourceOcrRequired(data?.ocr_required === true);
        setClassificationForm({
          privacyClass: latest?.privacy_class ?? 'tenant_sensitive',
          containsPii: latest?.contains_pii ?? false,
          containsOperationalSecurity: latest?.contains_operational_security ?? false,
          containsFinancialData: latest?.contains_financial_data ?? false,
          containsLegalPrivilege: latest?.contains_legal_privilege ?? false,
          reason: '',
        });
      });
    return () => { active = false; };
  }, [selectedFile?.versionId]);

  const canReviewSourceDocuments = isAdminTierRole(profile?.role);
  const reviewSourceClassification = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedFile || !canReviewSourceDocuments || !classificationForm.reason.trim()) return;
    setClassificationBusy(true);
    setNotice(null);
    const { data, error } = await supabase.rpc('review_document_classification', {
      p_document_version_id: selectedFile.versionId,
      p_privacy_class: classificationForm.privacyClass,
      p_contains_pii: classificationForm.containsPii,
      p_contains_operational_security: classificationForm.containsOperationalSecurity,
      p_contains_financial_data: classificationForm.containsFinancialData,
      p_contains_legal_privilege: classificationForm.containsLegalPrivilege,
      p_reason: classificationForm.reason.trim(),
    });
    if (error) setNotice(error.message);
    else {
      const review = (Array.isArray(data) ? data[0] : data) as SourceClassification | null;
      if (review) setSourceClassification(review);
      setClassificationForm((current) => ({ ...current, reason: '' }));
      setNotice('Classification review recorded for this source version.');
    }
    setClassificationBusy(false);
  };

  const promoteSelectedDocument = async () => {
    if (!selectedFile || !canReviewSourceDocuments || sourceOcrRequired || !sourceClassification?.reviewed_at || !sourceClassification.privacy_class) return;
    setClassificationBusy(true);
    setNotice(null);
    const { data, error } = await supabase.functions.invoke('bob-document-promote', {
      body: { document_version_id: selectedFile.versionId, target_scope: 'tenant_reference', metadata: { title: selectedFile.title } },
    });
    if (error) setNotice(error.message);
    else if (!data?.success) setNotice(data?.error ?? 'Document promotion was not completed.');
    else {
      setSelectedFile((current) => current?.id === selectedFile.id ? { ...current, currentScope: 'tenant_reference' } : current);
      setNotice(`${selectedFile.title} promoted to the tenant reference library.`);
    }
    setClassificationBusy(false);
  };

  const prepareSourceProposal = async () => {
    if (!selectedFile || !canReviewSourceDocuments || sourceOcrRequired || !sourceClassification?.reviewed_at) return;
    if (sourceProposals.some((proposal) => proposal.target_type === proposalTarget && ['proposed', 'approved', 'applied'].includes(proposal.status))) return;
    setProposalBusy(true);
    setNotice(null);
    const excerpt = selectedFile.text.trim().slice(0, 1200) || null;
    const { data, error } = await supabase.rpc('propose_document_promotion', {
      p_document_version_id: selectedFile.versionId,
      p_target_type: proposalTarget,
      p_proposed_payload: { title: selectedFile.title, document_type: proposalTarget, extracted_summary: excerpt },
      p_source_map: { document_id: selectedFile.id, document_version_id: selectedFile.versionId, source_excerpt: excerpt },
    });
    if (error) setNotice(error.message);
    else if (data) {
      const proposal = data as SourcePromotionProposal;
      setSourceProposals((current) => [proposal, ...current.filter((item) => item.id !== proposal.id)]);
      setNotice('Proposal prepared from this source. Review and decision stay with this document.');
    }
    setProposalBusy(false);
  };

  const reviewSourceProposal = async (proposal: SourcePromotionProposal, decision: 'approved' | 'rejected') => {
    const reason = sourceProposalReasons[proposal.id]?.trim();
    if (!reason || proposal.status !== 'proposed') return;
    setSourceProposalBusyId(proposal.id);
    setNotice(null);
    const { error } = await supabase.rpc('review_document_promotion_proposal', { p_proposal_id: proposal.id, p_decision: decision, p_reason: reason });
    if (error) setNotice(error.message);
    else {
      setSourceProposals((current) => current.map((item) => item.id === proposal.id ? { ...item, status: decision, review_reason: reason } : item));
      setSourceProposalReasons((current) => ({ ...current, [proposal.id]: '' }));
      setNotice(decision === 'approved' ? 'Proposal approved with a review receipt. No target business record was created.' : 'Proposal rejected with a review receipt.');
    }
    setSourceProposalBusyId(null);
  };

  const unconfirmedMatches = (editor?.getText().match(/\[TO CONFIRM\]/g) || []).length;

  const jumpToNextUnconfirmed = () => {
    if (!editor) return;
    const text = editor.getText();
    const target = '[TO CONFIRM]';
    const index = text.indexOf(target);
    if (index >= 0) {
      editor.chain().focus().setTextSelection({ from: index + 1, to: index + target.length + 1 }).run();
    }
  };

  const visibleDrafts = drafts.filter((draft) => fileSpaceForDraft(draft) === fileSpace && (!fileSearch.trim() || draft.title.toLowerCase().includes(fileSearch.trim().toLowerCase())));

  return (
    <main className="bob-document-page">
      <header className="bob-document-topbar">
        <div className="bob-document-brand"><span><Sparkles size={17} /></span><div><h1 className="bob-document-title">Bob document studio</h1><small>Author, reference, review, promote</small></div></div>
        <div className="bob-document-top-actions">
          <span className={`bob-save-state is-${saveState}`} role="status">{saveState === 'saving' ? 'Saving…' : saveState === 'reviewing' ? 'Submitting…' : saveState === 'saved' ? 'Step 2 of 4 · Saved draft' : saveState === 'needs_review' ? 'Step 3 of 4 · Awaiting your decision' : saveState === 'approved' ? 'Step 4 of 4 · Approved' : 'Step 1 of 4 · Writing'}</span>
          {unconfirmedMatches > 0 && <span className="bob-unconfirmed-badge" role="status"><AlertTriangle size={13} /><span>{unconfirmedMatches} unconfirmed</span><button type="button" onClick={jumpToNextUnconfirmed}>Find next</button></span>}
          <button type="button" className="bob-document-secondary" onClick={() => navigate('/admin/bob')}><X size={15} /> Close</button>
          <button type="button" className="bob-document-primary" onClick={() => void saveDraft()} disabled={saveState === 'saving'}><Save size={15} /> Save draft</button>
          {draftIds && saveState === 'saved' && <button type="button" className="bob-document-review" onClick={() => void submitForReview()} title="Lock this version and move it to the approval step">Send to review</button>}
          {draftIds && saveState === 'needs_review' && <><button type="button" className="bob-document-reject" onClick={() => void decideReview('rejected')} title="Send back for edits">Reject</button><button type="button" className="bob-document-review" onClick={() => void decideReview('approved')} title="Approve so the document can be printed or exported">Approve</button></>}
          {draftIds && saveState === 'approved' && <label className="bob-output-format">Output<select value={outputFormat} onChange={(event) => { setOutputFormat(event.target.value as OutputFormat); setOutputReceipt(null); }}><option value="print">Print PDF</option><option value="docx">DOCX</option></select></label>}
          {draftIds && saveState === 'approved' && <button type="button" className="bob-document-output" onClick={() => void requestDocumentOutput()} disabled={outputBusy || outputReceipt?.status === 'ready'}>{outputBusy ? 'Generating…' : `Generate ${outputLabel(outputFormat)}`}</button>}
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
          {selectedFile && <section className="bob-file-inspector" aria-label="Selected file details"><strong>{selectedFile.title}</strong><dl><div><dt>State</dt><dd>{selectedFile.status.replaceAll('_', ' ')}</dd></div><div><dt>Scope</dt><dd>{selectedFile.currentScope.replaceAll('_', ' ')}</dd></div><div><dt>Source</dt><dd>{selectedFile.sourceChannel.replaceAll('_', ' ')}</dd></div></dl>{selectedFile.authorable ? <button type="button" onClick={() => resumeDraft(selectedFile)}>Resume draft</button> : <button type="button" onClick={() => navigate(`/admin/files?document=${encodeURIComponent(selectedFile.id)}`)}>Open in Files workspace</button>}{selectedFile.text && <details className="bob-source-preview"><summary>Source text preview</summary><p>{selectedFile.text.slice(0, 1600)}</p></details>}</section>}
          {selectedFile && <section className="bob-source-governance" aria-label="Source classification and promotion">
            <div className="bob-document-section-heading"><span>Source review</span><small>{sourceClassification?.reviewed_at ? 'Human reviewed' : 'Review required'}</small></div>
            <p>Classification, tenant-library promotion, and domain proposals stay attached to this source version.</p>
            {sourceOcrRequired && <p className="bob-source-governance-warning" role="status">OCR is required before this document can be promoted or proposed.</p>}
            {sourceClassification && <div className="bob-source-classification-summary"><strong>{sourceClassification.privacy_class.replaceAll('_', ' ')}</strong>{sourceClassification.contains_pii && <span>PII</span>}{sourceClassification.contains_operational_security && <span>Operational security</span>}{sourceClassification.contains_financial_data && <span>Financial data</span>}{sourceClassification.contains_legal_privilege && <span>Legal privilege</span>}<small>{sourceClassification.rationale ?? 'No classification rationale recorded.'}</small></div>}
            {canReviewSourceDocuments ? <>
              <form className="bob-source-classification-form" onSubmit={reviewSourceClassification}>
                <label><span>Privacy class</span><select value={classificationForm.privacyClass} onChange={(event) => setClassificationForm((current) => ({ ...current, privacyClass: event.target.value }))}><option value="public">Public</option><option value="internal_non_sensitive">Internal non-sensitive</option><option value="tenant_sensitive">Tenant sensitive</option><option value="restricted">Restricted</option></select></label>
                <div className="bob-source-classification-flags"><label><input type="checkbox" checked={classificationForm.containsPii} onChange={(event) => setClassificationForm((current) => ({ ...current, containsPii: event.target.checked }))} /><span>Contains PII</span></label><label><input type="checkbox" checked={classificationForm.containsOperationalSecurity} onChange={(event) => setClassificationForm((current) => ({ ...current, containsOperationalSecurity: event.target.checked }))} /><span>Operational security</span></label><label><input type="checkbox" checked={classificationForm.containsFinancialData} onChange={(event) => setClassificationForm((current) => ({ ...current, containsFinancialData: event.target.checked }))} /><span>Financial data</span></label><label><input type="checkbox" checked={classificationForm.containsLegalPrivilege} onChange={(event) => setClassificationForm((current) => ({ ...current, containsLegalPrivilege: event.target.checked }))} /><span>Legal privilege</span></label></div>
                <label><span>Classification review reason</span><textarea required rows={3} value={classificationForm.reason} onChange={(event) => setClassificationForm((current) => ({ ...current, reason: event.target.value }))} placeholder="Explain the source and why this classification is appropriate." /></label>
                <button type="submit" disabled={classificationBusy || !classificationForm.reason.trim()}>{classificationBusy ? 'Recording…' : 'Record classification review'}</button>
              </form>
              <button type="button" disabled={classificationBusy || sourceOcrRequired || !sourceClassification?.reviewed_at} onClick={() => void promoteSelectedDocument()}>{classificationBusy ? 'Working…' : 'Promote to tenant library'}</button>
              <label className="bob-source-proposal-target"><span>Domain proposal target</span><select value={proposalTarget} onChange={(event) => setProposalTarget(event.target.value as SourceProposalTarget)}><option value="crm_agreement">CRM agreement</option><option value="site_brief">Site brief</option><option value="credential">Credential</option><option value="finance_reconciliation">Finance reconciliation</option><option value="hr_case">HR case</option><option value="investigation_link">Investigation link</option></select></label>
              <button type="button" disabled={proposalBusy || sourceOcrRequired || !sourceClassification?.reviewed_at || sourceProposals.some((proposal) => proposal.target_type === proposalTarget && ['proposed', 'approved', 'applied'].includes(proposal.status))} onClick={() => void prepareSourceProposal()}>{proposalBusy ? 'Preparing…' : 'Prepare domain proposal'}</button>
            </> : <p>Classification and promotion decisions require an organisation administrator.</p>}
          </section>}
          {sourceProposals.length > 0 && <section className="bob-source-proposals" aria-label="Proposals for selected document"><div className="bob-document-section-heading"><span>Domain proposals</span><small>{sourceProposals.filter((proposal) => proposal.status === 'proposed').length} awaiting review</small></div>{sourceProposals.map((proposal) => <article className="bob-source-proposal" key={proposal.id}><div className="bob-source-proposal-heading"><strong>{proposal.target_type.replaceAll('_', ' ')}</strong><span>{proposal.status}</span></div><details><summary>Proposed fields</summary><pre>{JSON.stringify(proposal.proposed_payload, null, 2)}</pre></details>{typeof proposal.source_map.source_excerpt === 'string' && <details><summary>Source excerpt</summary><p>{proposal.source_map.source_excerpt}</p></details>}{proposal.status === 'proposed' ? <><label><span>Review reason</span><textarea rows={3} required value={sourceProposalReasons[proposal.id] ?? ''} onChange={(event) => setSourceProposalReasons((current) => ({ ...current, [proposal.id]: event.target.value }))} placeholder="Explain what source evidence supports this decision and what remains uncertain." /></label><div className="bob-source-proposal-actions"><button type="button" className="bob-document-reject" disabled={sourceProposalBusyId === proposal.id || !sourceProposalReasons[proposal.id]?.trim()} onClick={() => void reviewSourceProposal(proposal, 'rejected')}>Reject proposal</button><button type="button" className="bob-document-review" disabled={sourceProposalBusyId === proposal.id || !sourceProposalReasons[proposal.id]?.trim()} onClick={() => void reviewSourceProposal(proposal, 'approved')}>{sourceProposalBusyId === proposal.id ? 'Recording…' : 'Approve proposal'}</button></div></> : <p className="bob-source-proposal-boundary">This review records a proposal decision only; it has not created an authoritative {proposal.target_type.replaceAll('_', ' ')} record.</p>}</article>)}</section>}
          <div className="bob-document-section-heading"><span>Document setup</span></div>
          {sourceContext && <div className="bob-source-context" role="status" aria-label="Source context for document"><span className="bob-source-type">{sourceContext.type.replace('_', ' ').toUpperCase()}</span><strong>{sourceContext.label}</strong><p className="bob-source-prompt">{sourceContext.prompt}</p></div>}
          <label htmlFor="bob-document-title">Title<input id="bob-document-title" aria-label="Document title" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label htmlFor="bob-document-type">Type<select id="bob-document-type" aria-label="Document type" value={documentType} onChange={(event) => setDocumentType(event.target.value)}>
            <option value="capability_statement">Capability statement</option><option value="company_profile">Company profile</option><option value="site_safety_plan">Site safety plan</option><option value="risk_assessment">Security risk assessment</option><option value="incident_report">Incident / near miss</option><option value="corrective_action">Corrective action review</option><option value="emergency_plan">Emergency response plan</option><option value="working_alone_plan">Working-alone plan</option><option value="training_record">Training / competency record</option><option value="customer_review">Customer service review</option><option value="report">Operational report</option><option value="letter">Controlled correspondence</option><option value="policy">Policy / SOP</option><option value="proposal">Proposal / RFQ</option><option value="evidence_package">Evidence package</option><option value="custom">Custom</option>
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
          {outputReceipt?.status === 'ready' && <><p className="bob-output-receipt" role="status"><CheckCircle2 size={14} /><span>{outputLabel(outputReceipt.output_format)} ready · SHA-256 {outputReceipt.sha256?.slice(0, 16) ?? 'unavailable'}…</span></p>{outputReceipt.storage_bucket && outputReceipt.storage_path && <GeneratedArtifactActions bucket={outputReceipt.storage_bucket} path={outputReceipt.storage_path} fileName={`${title}.${outputReceipt.output_format === 'docx' ? 'docx' : 'pdf'}`} label={outputLabel(outputReceipt.output_format)} />}</>}
          {outputHistory.length > 0 && <section className="bob-output-history" aria-label="Generated document outputs"><strong>Generated outputs</strong>{outputHistory.map((output) => <div key={output.id}><span>{outputLabel(output.output_format)} · {output.status}</span><small>{output.sha256 ? `SHA-256 ${output.sha256.slice(0, 16)}…` : 'Checksum pending'}</small>{output.status === 'ready' && output.storage_bucket && output.storage_path && <GeneratedArtifactActions bucket={output.storage_bucket} path={output.storage_path} fileName={`${output.id}.${output.output_format === 'docx' ? 'docx' : 'pdf'}`} label={outputLabel(output.output_format)} />}</div>)}</section>}
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
