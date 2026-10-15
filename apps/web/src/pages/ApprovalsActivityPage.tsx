type ApprovalWorkArea = 'actions' | 'documents' | 'plans' | 'runs';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ChevronRight, Clock3, FileCheck2, Filter, History, ListChecks, RefreshCw, Search, ShieldCheck, X, XCircle } from 'lucide-react';
import { formatGovernedPayload } from '../lib/governedPayload';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { ShellLayout } from '../layouts/ShellLayout';
import './ApprovalsActivityPage.css';

type ActionStatus = 'pending' | 'pending_approval' | 'proposed' | 'approved' | 'rejected' | 'applied' | 'failed';
type StatusFilter = 'pending' | 'approved' | 'rejected' | 'applied' | 'failed' | 'all';

interface ApprovalRow {
  id: string;
  action_type: string;
  status: ActionStatus;
  bob_reasoning: string | null;
  confidence_score: number | null;
  context_table: string | null;
  context_summary: string | null;
  created_at: string;
  applied_at: string | null;
  approved_at: string | null;
  proposed_payload: Record<string, unknown>;
  amended_payload: Record<string, unknown> | null;
  organization_id: string;
  org_name: string | null;
  triggered_by_name: string | null;
  user_name: string | null;
  approved_by_name: string | null;
  rejection_reason: string | null;
  error_message: string | null;
  result_table: string | null;
  result_record_id: string | null;
  assigned_approver_id: string | null;
  assigned_approver_name: string | null;
  can_decide: boolean;
}

interface JobPlanRow {
  id: string;
  goal: string;
  status: 'draft' | 'proposed' | 'executing' | 'needs_review' | 'completed' | 'failed' | 'cancelled';
  reasoning: string | null;
  created_at: string;
  organization_id: string;
}

interface JobPlanStep {
  id: string;
  sequence: number;
  action_type: string;
  status: string;
}

interface JobRunStep {
  step_id?: string;
  tool?: string;
  status?: string;
  kind?: string;
}

interface JobRunRow {
  id: string;
  job_id: string;
  goal: string;
  status: string;
  approval_mode: string;
  contains_writes: boolean;
  stopped_reason: string | null;
  steps: JobRunStep[];
  clarifications: string[];
  created_at: string;
}

interface JobTargetReference {
  id: string;
  job_id: string;
  step_id: string;
  tool: string;
  target_table: string | null;
  target_record_id: string | null;
  action: string | null;
  reversible: boolean;
  reversed: boolean;
  reversed_at: string | null;
  created_at: string;
}

interface DocumentPromotionRow {
  document_id: string;
  version_id: string;
  file_name: string;
  scope: string;
  privacy_class: string | null;
  confidence: number | null;
  rationale: string | null;
  ocr_required: boolean;
  extracted_text: string | null;
  contains_pii: boolean;
  contains_operational_security: boolean;
  contains_financial_data: boolean;
  contains_legal_privilege: boolean;
  classifier_source: string | null;
  reviewed_at: string | null;
  created_at: string;
}

interface DocumentReviewRow {
  document_id: string;
  version_id: string;
  file_name: string;
  title: string;
  document_type: string;
  preview: string | null;
  review_reason: string | null;
  authored_by: string | null;
  updated_at: string;
  unconfirmed_count?: number;
}

interface PromotionProposalRow {
  id: string;
  target_type: string;
  status: string;
  proposed_payload: Record<string, unknown>;
  source_map: Record<string, unknown>;
  created_at: string;
  review_reason: string | null;
  document_version?: { id: string; documents?: { id: string; original_filename: string } | null } | null;
}

type PromotionProposalResponse = Omit<PromotionProposalRow, 'document_version'> & {
  document_version?: Array<{ id: string; documents?: Array<{ id: string; original_filename: string }> | { id: string; original_filename: string } | null }>
    | { id: string; documents?: Array<{ id: string; original_filename: string }> | { id: string; original_filename: string } | null }
    | null;
};

type DomainProposalTarget = 'crm_agreement' | 'site_brief' | 'credential' | 'finance_reconciliation' | 'hr_case' | 'investigation_link';

interface ClientOrganizationOption { id: string; name: string; }
interface StaffOption { id: string; display_name: string | null; email: string | null; }
interface InvestigationOption { id: string; investigation_reference: string; title: string; status: string; }

const STATUS_FILTERS: Array<{ id: StatusFilter; label: string }> = [
  { id: 'pending', label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'applied', label: 'Applied' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'failed', label: 'Failed' },
  { id: 'all', label: 'All activity' },
];

const APPROVAL_VIEW_BY_ROLE: Record<string, { eyebrow: string; title: string; description: string; scope: string }> = {
  grand_master: {
    eyebrow: 'Platform governance',
    title: 'Platform approvals',
    description: 'Review consequential decisions across the organisations you oversee.',
    scope: 'Platform and authorised organisations',
  },
  master: {
    eyebrow: 'Organisation governance',
    title: 'Organisation approvals',
    description: 'Review plans and consequential decisions for your organisation and its branches.',
    scope: 'Your organisation and branches',
  },
  admin: {
    eyebrow: 'Team governance',
    title: 'Team approvals',
    description: 'Review operational and document decisions for your organisation.',
    scope: 'Your organisation',
  },
};

function isPendingAction(status: ActionStatus): boolean {
  return status === 'pending' || status === 'pending_approval' || status === 'proposed';
}

function matchesStatusFilter(status: ActionStatus, filter: StatusFilter): boolean {
  return filter === 'all' || (filter === 'pending' ? isPendingAction(status) : status === filter);
}

function statusClass(status: ActionStatus): string {
  return isPendingAction(status) ? 'pending' : status;
}

const ApprovalsActivityPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedActionId = searchParams.get('actionId');
  const deepLinkAnnouncedRef = useRef(false);
  const { operatingOrganizationId, profile } = useAuth();
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [plans, setPlans] = useState<JobPlanRow[]>([]);
  const [planSteps, setPlanSteps] = useState<Record<string, JobPlanStep[]>>({});
  const [jobRuns, setJobRuns] = useState<JobRunRow[]>([]);
  const [jobTargetReferences, setJobTargetReferences] = useState<JobTargetReference[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>(() => requestedActionId ? 'all' : 'pending');
  const [reviewArea, setReviewArea] = useState<ApprovalWorkArea>('actions');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [decision, setDecision] = useState<'approve' | 'reject' | null>(null);
  const [reasoning, setReasoning] = useState('');
  const [applyAfterApprove, setApplyAfterApprove] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [payloadLabels, setPayloadLabels] = useState<Record<string, string>>({});
  const [planDecision, setPlanDecision] = useState<'approve' | 'reject' | null>(null);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [documentPromotions, setDocumentPromotions] = useState<DocumentPromotionRow[]>([]);
  const [promotionProposals, setPromotionProposals] = useState<PromotionProposalRow[]>([]);
  const [clientOrganizations, setClientOrganizations] = useState<ClientOrganizationOption[]>([]);
  const [executionProposal, setExecutionProposal] = useState<PromotionProposalRow | null>(null);
  const [executionForm, setExecutionForm] = useState({ clientOrganizationId: '', name: '', startsOn: '', endsOn: '' });
  const [financeProposal, setFinanceProposal] = useState<PromotionProposalRow | null>(null);
  const [financeForm, setFinanceForm] = useState({ clientOrganizationId: '', serviceAgreementId: '', invoiceNumber: '', invoiceDate: '', dueDate: '', subtotal: '', gstAmount: '', totalAmount: '', notes: '' });
  const [targetExecution, setTargetExecution] = useState<{ proposal: PromotionProposalRow; target: DomainProposalTarget } | null>(null);
  const [staffOptions, setStaffOptions] = useState<StaffOption[]>([]);
  const [investigationOptions, setInvestigationOptions] = useState<InvestigationOption[]>([]);
  const [targetForm, setTargetForm] = useState({ staffId: '', credentialType: 'certificate_of_authority', credentialNumber: '', issuingAuthority: '', issuedDate: '', expiryDate: '', fileName: '', storagePath: '', documentType: 'certificate', notes: '', name: '', workUnitType: 'patrol', serviceType: 'patrol', investigationId: '', entityType: 'field_report', entityId: '', linkRole: 'supporting', linkReason: '' });
  const [documentReviews, setDocumentReviews] = useState<DocumentReviewRow[]>([]);
  const approvalView = APPROVAL_VIEW_BY_ROLE[profile?.role ?? ''] ?? {
    eyebrow: 'Governed activity',
    title: 'My approval activity',
    description: 'Review decisions assigned to you.',
    scope: 'Assigned work',
  };

  const loadActivity = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [activityResponse, plansResponse, stepsResponse, runsResponse, targetReferencesResponse, documentsResponse, proposalsResponse, clientsResponse, staffResponse, investigationsResponse] = await Promise.all([
        supabase.rpc('get_approvals_activity', {
        p_limit: 100,
        p_offset: 0,
        p_statuses: null,
        p_action_types: null,
        }),
        supabase.from('bob_job_plans').select('id,goal,status,reasoning,created_at,organization_id').in('status', ['proposed', 'executing', 'needs_review']).order('created_at', { ascending: false }).limit(30),
        supabase.from('bob_job_plan_steps').select('id,plan_id,sequence,action_type,status').order('sequence'),
        supabase.from('bob_job_runs').select('id,job_id,goal,status,approval_mode,contains_writes,stopped_reason,steps,clarifications,created_at').order('created_at', { ascending: false }).limit(30),
        supabase.from('bob_job_rollback_refs').select('id,job_id,step_id,tool,target_table,target_record_id,action,reversible,reversed,reversed_at,created_at').order('created_at', { ascending: false }).limit(100),
        supabase.from('documents').select('id,original_filename,current_scope,updated_at,document_versions(id,version_label,extracted_text,extraction_confidence,ocr_required,created_at,metadata_json,document_classifications(privacy_class,confidence,rationale,contains_pii,contains_operational_security,contains_financial_data,contains_legal_privilege,classifier_source,reviewed_at,created_at))').in('current_scope', ['conversation_only', 'tenant', 'quarantined']).order('created_at', { ascending: false }).limit(50),
        supabase.from('document_promotion_proposals').select('id,target_type,status,proposed_payload,source_map,created_at,review_reason,document_version:document_versions(id,documents(id,original_filename))').order('created_at', { ascending: false }).limit(50),
        supabase.from('organizations').select('id,name').eq('organization_type', 'client').eq('active', true).order('name').limit(100),
        supabase.from('staff_profiles').select('id,user_id,display_name:user_id').eq('organization_id', operatingOrganizationId ?? profile?.organizationId ?? '').limit(100),
        supabase.from('investigations').select('id,investigation_reference,title,status').eq('organization_id', operatingOrganizationId ?? profile?.organizationId ?? '').in('status', ['open','active','awaiting_evidence','awaiting_review']).order('created_at', { ascending: false }).limit(100),
      ]);
      if (activityResponse.error) throw activityResponse.error;
      if (plansResponse.error) throw plansResponse.error;
      if (stepsResponse.error) throw stepsResponse.error;
      if (runsResponse.error) throw runsResponse.error;
      if (targetReferencesResponse.error) throw targetReferencesResponse.error;
      if (documentsResponse.error) throw documentsResponse.error;
      if (proposalsResponse.error) throw proposalsResponse.error;
      if (clientsResponse.error) throw clientsResponse.error;
      if (staffResponse.error) throw staffResponse.error;
      if (investigationsResponse.error) throw investigationsResponse.error;
      const scopeOrganizationId = profile?.role === 'admin'
        ? profile.organizationId
        : operatingOrganizationId ?? profile?.organizationId ?? null;
      const activity = ((activityResponse.data as ApprovalRow[]) ?? []).filter((row) => !scopeOrganizationId || row.organization_id === scopeOrganizationId);
      setRows(activity);
      const planRows = (plansResponse.data as JobPlanRow[]) ?? [];
      setPlans(planRows);
      setPlanSteps(((stepsResponse.data as Array<JobPlanStep & { plan_id: string }>) ?? []).reduce<Record<string, JobPlanStep[]>>((grouped, step) => {
        (grouped[step.plan_id] ??= []).push(step);
        return grouped;
      }, {}));
      setJobRuns(((runsResponse.data as Array<Omit<JobRunRow, 'steps' | 'clarifications'> & { steps: unknown; clarifications: unknown }>) ?? []).map((run) => ({
        ...run,
        steps: Array.isArray(run.steps) ? run.steps as JobRunStep[] : [],
        clarifications: Array.isArray(run.clarifications) ? run.clarifications.filter((item): item is string => typeof item === 'string') : [],
      })));
      setJobTargetReferences((targetReferencesResponse.data as JobTargetReference[]) ?? []);
      const documentRows = (documentsResponse.data as Array<{ id: string; original_filename: string; current_scope: string; updated_at: string; document_versions?: Array<{ id: string; extracted_text: string | null; extraction_confidence: number | null; ocr_required: boolean; created_at: string; metadata_json?: Record<string, unknown>; document_classifications?: Array<{ privacy_class: string; confidence: number | null; rationale: string | null; contains_pii: boolean; contains_operational_security: boolean; contains_financial_data: boolean; contains_legal_privilege: boolean; classifier_source: string; reviewed_at: string | null; created_at: string }> }> }>) ?? [];
      setDocumentReviews(documentRows.flatMap((document) => {
        const version = [...(document.document_versions ?? [])].sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime())[0];
        const metadata = version?.metadata_json ?? {};
        if (!version || metadata.authoring_status !== 'needs_review') return [];
        const text = `${version.extracted_text ?? ''} ${String(metadata.authoring_html ?? '')}`;
        const unconfirmedCount = (text.match(/\[TO CONFIRM\]/g) || []).length;
        return [{ document_id: document.id, version_id: version.id, file_name: document.original_filename, title: String(metadata.title ?? document.original_filename), document_type: String(metadata.document_type ?? 'custom'), preview: version.extracted_text, review_reason: typeof metadata.review_reason === 'string' ? metadata.review_reason : null, authored_by: typeof metadata.authored_by === 'string' ? metadata.authored_by : null, updated_at: document.updated_at, unconfirmed_count: unconfirmedCount }];
      }));
      setDocumentPromotions(documentRows.flatMap((document) => {
        const version = [...(document.document_versions ?? [])].sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime())[0];
        if (!version) return [];
        const classification = [...(version.document_classifications ?? [])].sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime())[0];
        return [{ document_id: document.id, version_id: version.id, file_name: document.original_filename, scope: document.current_scope, privacy_class: classification?.privacy_class ?? null, confidence: classification?.confidence ?? version.extraction_confidence, rationale: classification?.rationale ?? null, ocr_required: version.ocr_required, extracted_text: version.extracted_text ?? null, contains_pii: classification?.contains_pii ?? false, contains_operational_security: classification?.contains_operational_security ?? false, contains_financial_data: classification?.contains_financial_data ?? false, contains_legal_privilege: classification?.contains_legal_privilege ?? false, classifier_source: classification?.classifier_source ?? null, reviewed_at: classification?.reviewed_at ?? null, created_at: version.created_at }];
      }));
      const proposalRows = (proposalsResponse.data as unknown as PromotionProposalResponse[] | null) ?? [];
      setPromotionProposals(proposalRows.map((proposal) => {
        const version = Array.isArray(proposal.document_version) ? proposal.document_version[0] : proposal.document_version;
        const document = Array.isArray(version?.documents) ? version.documents[0] : version?.documents;
        return { ...proposal, document_version: version ? { id: version.id, documents: document ?? null } : null };
      }));
      setClientOrganizations((clientsResponse.data as ClientOrganizationOption[]) ?? []);
      setStaffOptions(((staffResponse.data as Array<{ id: string; user_id: string | null }>) ?? []).map((staff) => ({ id: staff.id, display_name: null, email: staff.user_id })));
      setInvestigationOptions((investigationsResponse.data as InvestigationOption[]) ?? []);
      setSelectedId((current) => current && activity.some((row) => row.id === current) ? current : activity[0]?.id ?? null);
    } catch (loadError) {
      setRows([]);
      setSelectedId(null);
      setError(loadError instanceof Error ? loadError.message : 'Governed actions could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [operatingOrganizationId, profile?.organizationId]);

  const applyCrmAgreementProposal = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!executionProposal || !executionForm.clientOrganizationId || !executionForm.name.trim() || !operatingOrganizationId) return;
    setBusyId(executionProposal.id); setError(null); setNotice(null);
    const { data, error: applyError } = await supabase.rpc('apply_crm_agreement_promotion_proposal', {
      p_proposal_id: executionProposal.id,
      p_provider_organization_id: operatingOrganizationId,
      p_client_organization_id: executionForm.clientOrganizationId,
      p_name: executionForm.name.trim(),
      p_starts_on: executionForm.startsOn || null,
      p_ends_on: executionForm.endsOn || null,
      p_enabled_modules: [],
    });
    if (applyError) setError(applyError.message);
    else { setNotice(`CRM agreement created from approved proposal ${(data as { agreement_id?: string } | null)?.agreement_id ?? ''}.`); setExecutionProposal(null); await loadActivity(); }
    setBusyId(null);
  };

  const applyFinanceProposal = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!financeProposal || !financeForm.clientOrganizationId || !financeForm.invoiceNumber.trim() || !financeForm.invoiceDate || !financeForm.subtotal || !financeForm.totalAmount) return;
    setBusyId(financeProposal.id); setError(null); setNotice(null);
    const { data, error: applyError } = await supabase.rpc('apply_finance_reconciliation_proposal', {
      p_proposal_id: financeProposal.id,
      p_client_organization_id: financeForm.clientOrganizationId,
      p_service_agreement_id: financeForm.serviceAgreementId || null,
      p_invoice_number: financeForm.invoiceNumber.trim(),
      p_invoice_date: financeForm.invoiceDate,
      p_due_date: financeForm.dueDate || null,
      p_subtotal: Number(financeForm.subtotal),
      p_gst_amount: Number(financeForm.gstAmount || 0),
      p_total_amount: Number(financeForm.totalAmount),
      p_notes: financeForm.notes.trim() || null,
    });
    if (applyError) setError(applyError.message);
    else { setNotice(`Draft invoice created from approved proposal ${(data as { invoice_id?: string } | null)?.invoice_id ?? ''}.`); setFinanceProposal(null); await loadActivity(); }
    setBusyId(null);
  };

  const applyTargetProposal = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!targetExecution) return;
    const { proposal, target } = targetExecution;
    setBusyId(proposal.id); setError(null); setNotice(null);
    try {
      let applyError: { message: string } | null = null;
      if (target === 'credential') {
        ({ error: applyError } = await supabase.rpc('apply_credential_promotion_proposal', {
          p_proposal_id: proposal.id,
          p_staff_id: targetForm.staffId,
          p_credential_type: targetForm.credentialType,
          p_credential_number: targetForm.credentialNumber || undefined,
          p_issuing_authority: targetForm.issuingAuthority || undefined,
          p_issued_date: targetForm.issuedDate || undefined,
          p_expiry_date: targetForm.expiryDate || undefined,
          p_authorized_activities: [],
        }));
      } else if (target === 'hr_case') {
        ({ error: applyError } = await supabase.rpc('apply_hr_document_promotion_proposal', {
          p_proposal_id: proposal.id,
          p_staff_id: targetForm.staffId,
          p_document_type: targetForm.documentType,
          p_file_name: targetForm.fileName || targetForm.name,
          p_storage_path: targetForm.storagePath || targetForm.notes,
          p_expiry_date: targetForm.expiryDate || undefined,
          p_notes: targetForm.notes || undefined,
        }));
      } else if (target === 'site_brief') {
        ({ error: applyError } = await supabase.rpc('apply_site_brief_promotion_proposal', {
          p_proposal_id: proposal.id,
          p_name: targetForm.name,
          p_work_unit_type: targetForm.workUnitType,
          p_service_type: targetForm.serviceType,
        }));
      } else if (target === 'investigation_link') {
        ({ error: applyError } = await supabase.rpc('apply_investigation_link_promotion_proposal', {
          p_proposal_id: proposal.id,
          p_investigation_id: targetForm.investigationId || targetForm.staffId,
          p_entity_type: targetForm.entityType,
          p_entity_id: targetForm.entityId || targetForm.name,
          p_link_role: targetForm.linkRole,
          p_link_reason: targetForm.linkReason || targetForm.notes || undefined,
        }));
      } else {
        throw new Error(`Unsupported promotion target: ${target}`);
      }
      if (applyError) {
        setError(applyError.message);
      } else {
        setNotice(`${formatActionType(target)} applied from approved proposal.`);
        setTargetExecution(null);
        await loadActivity();
      }
    } catch (applyFailure) {
      setError(applyFailure instanceof Error ? applyFailure.message : 'The approved proposal could not be applied.');
    } finally {
      setBusyId(null);
    }
  };

  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);

  useEffect(() => {
    const payload = selectedPayload(rows.find((row) => row.id === selectedId) ?? null);
    if (!payload) { setPayloadLabels({}); return; }
    const loadLabels = async () => {
      const labels: Record<string, string> = {};
      if (typeof payload.site_id === 'string') {
        const { data } = await supabase.from('client_sites').select('id,name,address').eq('id', payload.site_id).maybeSingle();
        if (data) labels.site_id = `${data.name}${data.address ? ` · ${data.address}` : ''}`;
      }
      if (typeof payload.patrol_route_id === 'string') {
        const { data } = await supabase.from('patrol_routes').select('id,name,route_code').eq('id', payload.patrol_route_id).maybeSingle();
        if (data) labels.patrol_route_id = data.route_code ? `[${data.route_code}] ${data.name}` : data.name;
      }
      setPayloadLabels(labels);
    };
    void loadLabels();
  }, [rows, selectedId]);

  const visibleRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((row) => matchesStatusFilter(row.status, filter) && (!term || [row.action_type, row.context_summary, row.context_table, row.org_name, row.triggered_by_name]
      .some((value) => value?.toLowerCase().includes(term))));
  }, [filter, rows, search]);

  useEffect(() => {
    setSelectedId((current) => {
      if (requestedActionId && visibleRows.some((row) => row.id === requestedActionId)) return requestedActionId;
      return current && visibleRows.some((row) => row.id === current) ? current : visibleRows[0]?.id ?? null;
    });
  }, [requestedActionId, visibleRows]);

  useEffect(() => {
    if (loading || !requestedActionId || deepLinkAnnouncedRef.current) return;
    deepLinkAnnouncedRef.current = true;
    const requested = rows.find((row) => row.id === requestedActionId);
    if (!requested) {
      setError('The Bob action in this link is not available in your current organisation or role.');
      return;
    }
    setReviewArea('actions');
    setNotice('Bob opened the exact governed action. Review the evidence and choose whether to approve, amend, or reject it.');
  }, [loading, requestedActionId, rows]);

  const selected = rows.find((row) => row.id === selectedId) ?? null;
  const pendingCount = rows.filter((row) => isPendingAction(row.status)).length;
  const failedCount = rows.filter((row) => row.status === 'failed').length;
  const decidableCount = rows.filter((row) => isPendingAction(row.status) && row.can_decide).length;
  const visibleStatusFilters = STATUS_FILTERS.filter((item) => item.id === 'all' || rows.some((row) => matchesStatusFilter(row.status, item.id)));
  const documentWorkCount = documentReviews.length + documentPromotions.length + promotionProposals.filter((proposal) => proposal.status === 'proposed' || proposal.status === 'approved').length;
  const workAreas: Array<{ id: ApprovalWorkArea; label: string; count: number }> = [
    ...(rows.length > 0 || (documentWorkCount === 0 && plans.length === 0 && jobRuns.length === 0) ? [{ id: 'actions' as const, label: 'Decisions', count: rows.length }] : []),
    ...(documentWorkCount > 0 ? [{ id: 'documents' as const, label: 'Documents', count: documentWorkCount }] : []),
    ...(plans.length > 0 ? [{ id: 'plans' as const, label: 'Plans', count: plans.length }] : []),
    ...(jobRuns.length > 0 ? [{ id: 'runs' as const, label: 'Job history', count: jobRuns.length }] : []),
  ];

  useEffect(() => {
    if (loading || visibleStatusFilters.some((item) => item.id === filter)) return;
    setFilter(visibleStatusFilters[0]?.id ?? 'all');
  }, [filter, loading, visibleStatusFilters]);

  useEffect(() => {
    if (loading || workAreas.some((area) => area.id === reviewArea)) return;
    setReviewArea(workAreas[0]?.id ?? 'actions');
  }, [loading, reviewArea, workAreas]);

  const openDecision = (nextDecision: 'approve' | 'reject') => {
    setDecision(nextDecision);
    setReasoning('');
    setApplyAfterApprove(false);
    setError(null);
  };

  const openPlanDecision = (plan: JobPlanRow, nextDecision: 'approve' | 'reject') => {
    setSelectedPlanId(plan.id);
    setPlanDecision(nextDecision);
    setReasoning('');
    setError(null);
  };

  const submitPlanDecision = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedPlanId || !planDecision || !reasoning.trim()) return;
    setBusyId(selectedPlanId);
    setError(null);
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('bob-job-plan-approve', {
        body: { plan_id: selectedPlanId, action: planDecision, reasoning: reasoning.trim() },
      });
      if (invokeError) throw invokeError;
      setNotice((data as { note?: string } | null)?.note ?? `Plan ${planDecision === 'approve' ? 'approved' : 'rejected'} successfully.`);
      setPlanDecision(null);
      setSelectedPlanId(null);
      setReasoning('');
      await loadActivity();
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : `The plan ${planDecision} decision could not be recorded.`);
    } finally {
      setBusyId(null);
    }
  };

  const submitDecision = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !decision || !reasoning.trim() || !selected.can_decide) return;
    setBusyId(selected.id);
    setError(null);
    setNotice(null);
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('bob-proposal-approver', {
        body: {
          action_id: selected.id,
          action: decision,
          reasoning: reasoning.trim(),
          apply: decision === 'approve' && applyAfterApprove,
        },
      });
      if (invokeError) throw invokeError;
      const response = data as { status?: string; applied?: boolean; apply_error?: string; note?: string } | null;
      if (response?.apply_error) {
        setNotice(`Approval recorded, but application failed: ${response.apply_error}`);
      } else {
        setNotice(response?.note ?? `Action ${decision === 'approve' ? 'approved' : 'rejected'} successfully.`);
      }
      setDecision(null);
      setReasoning('');
      await loadActivity();
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : `The ${decision} decision could not be recorded.`);
    } finally {
      setBusyId(null);
    }
  };

  const renderTargetExecutionFields = () => {
    if (!targetExecution) return null;

    switch (targetExecution.target) {
      case 'credential':
        return (
          <>
            <p className="approvals-context">Advanced credential details</p>
            <label><span>Staff member</span><select required value={targetForm.staffId} onChange={(event) => setTargetForm({ ...targetForm, staffId: event.target.value })}><option value="">Select staff member</option>{staffOptions.map((staff) => <option key={staff.id} value={staff.id}>{staff.display_name || staff.email || staff.id}</option>)}</select></label>
            <label><span>Credential type</span><select required value={targetForm.credentialType} onChange={(event) => setTargetForm({ ...targetForm, credentialType: event.target.value })}><option value="certificate_of_authority">Certificate of authority</option><option value="warrant">Warrant</option><option value="driver_licence">Driver licence</option><option value="security_clearance">Security clearance</option></select></label>
            <label><span>Credential number</span><input value={targetForm.credentialNumber} onChange={(event) => setTargetForm({ ...targetForm, credentialNumber: event.target.value })} /></label>
            <label><span>Issuing authority</span><input value={targetForm.issuingAuthority} onChange={(event) => setTargetForm({ ...targetForm, issuingAuthority: event.target.value })} /></label>
            <div className="approvals-review-checks"><label><span>Issued date</span><input type="date" value={targetForm.issuedDate} onChange={(event) => setTargetForm({ ...targetForm, issuedDate: event.target.value })} /></label><label><span>Expiry date</span><input type="date" value={targetForm.expiryDate} onChange={(event) => setTargetForm({ ...targetForm, expiryDate: event.target.value })} /></label></div>
            <label><span>Evidence notes</span><textarea rows={3} value={targetForm.notes} onChange={(event) => setTargetForm({ ...targetForm, notes: event.target.value })} placeholder="Capture the authority basis, scope, and safe handling notes." /></label>
          </>
        );
      case 'hr_case':
        return (
          <>
            <p className="approvals-context">Advanced HR document details</p>
            <label><span>Staff member</span><select required value={targetForm.staffId} onChange={(event) => setTargetForm({ ...targetForm, staffId: event.target.value })}><option value="">Select staff member</option>{staffOptions.map((staff) => <option key={staff.id} value={staff.id}>{staff.display_name || staff.email || staff.id}</option>)}</select></label>
            <label><span>Document type</span><select value={targetForm.documentType} onChange={(event) => setTargetForm({ ...targetForm, documentType: event.target.value })}><option value="contract">Contract</option><option value="certificate">Certificate</option><option value="policy_acknowledgement">Policy acknowledgement</option><option value="other">Other</option></select></label>
            <label><span>File name</span><input required value={targetForm.fileName || targetForm.name} onChange={(event) => setTargetForm({ ...targetForm, fileName: event.target.value, name: event.target.value })} /></label>
            <label><span>Storage path</span><input required value={targetForm.storagePath} onChange={(event) => setTargetForm({ ...targetForm, storagePath: event.target.value })} /></label>
            <label><span>Expiry date</span><input type="date" value={targetForm.expiryDate} onChange={(event) => setTargetForm({ ...targetForm, expiryDate: event.target.value })} /></label>
            <label><span>Notes</span><textarea rows={3} value={targetForm.notes} onChange={(event) => setTargetForm({ ...targetForm, notes: event.target.value })} placeholder="Record the reason and handling requirements for this HR document." /></label>
          </>
        );
      case 'site_brief':
        return (
          <>
            <p className="approvals-context">Advanced site brief details</p>
            <label><span>Site brief name</span><input required value={targetForm.name} onChange={(event) => setTargetForm({ ...targetForm, name: event.target.value })} /></label>
            <div className="approvals-review-checks"><label><span>Work unit type</span><select value={targetForm.workUnitType} onChange={(event) => setTargetForm({ ...targetForm, workUnitType: event.target.value })}><option value="patrol">Patrol</option><option value="parking">Parking</option><option value="noise">Noise</option><option value="compliance">Compliance</option></select></label><label><span>Service type</span><select value={targetForm.serviceType} onChange={(event) => setTargetForm({ ...targetForm, serviceType: event.target.value })}><option value="patrol">Patrol</option><option value="enforcement">Enforcement</option><option value="investigation">Investigation</option><option value="support">Support</option></select></label></div>
            <label><span>Purpose</span><textarea rows={3} value={targetForm.notes} onChange={(event) => setTargetForm({ ...targetForm, notes: event.target.value })} placeholder="Describe the operational brief to be attached to the site." /></label>
          </>
        );
      case 'investigation_link':
        return (
          <>
            <p className="approvals-context">Advanced investigation link details</p>
            <label><span>Investigation</span><select required value={targetForm.investigationId} onChange={(event) => setTargetForm({ ...targetForm, investigationId: event.target.value })}><option value="">Select investigation</option>{investigationOptions.map((investigation) => <option key={investigation.id} value={investigation.id}>{investigation.investigation_reference} · {investigation.title}</option>)}</select></label>
            <div className="approvals-review-checks"><label><span>Entity type</span><select value={targetForm.entityType} onChange={(event) => setTargetForm({ ...targetForm, entityType: event.target.value })}><option value="field_report">Field report</option><option value="observation">Observation</option><option value="incident">Incident</option><option value="evidence_package">Evidence package</option></select></label><label><span>Link role</span><select value={targetForm.linkRole} onChange={(event) => setTargetForm({ ...targetForm, linkRole: event.target.value })}><option value="supporting">Supporting</option><option value="primary">Primary</option><option value="reviewing">Reviewing</option></select></label></div>
            <label><span>Entity ID</span><input required value={targetForm.entityId} onChange={(event) => setTargetForm({ ...targetForm, entityId: event.target.value })} /></label>
            <label><span>Reason</span><textarea rows={3} value={targetForm.linkReason} onChange={(event) => setTargetForm({ ...targetForm, linkReason: event.target.value })} placeholder="Explain why this record is linked to the investigation." /></label>
          </>
        );
      default:
        return (
          <>
            <label><span>Target name or type</span><input required value={targetForm.name || targetForm.credentialType} onChange={(event) => setTargetForm({ ...targetForm, name: event.target.value, credentialType: event.target.value, entityId: event.target.value })} /></label>
            <label><span>Notes</span><textarea required rows={4} value={targetForm.notes || targetForm.linkReason || targetForm.storagePath} onChange={(event) => setTargetForm({ ...targetForm, notes: event.target.value, linkReason: event.target.value, storagePath: event.target.value })} /></label>
          </>
        );
    }
  };

  return (
    <>
    <ShellLayout shell="admin" className="approvals-shell">
      <div className="approvals-page">
      {targetExecution && <div className="approvals-dialog-backdrop"><form className="approvals-dialog" onSubmit={applyTargetProposal} role="dialog" aria-modal="true" aria-labelledby="target-proposal-apply-title"><div className="approvals-panel-heading"><div><span>Approved proposal</span><h2 id="target-proposal-apply-title">{targetExecution.target === 'credential' ? 'Apply approved credential' : targetExecution.target === 'hr_case' ? 'Apply approved HR document' : targetExecution.target === 'site_brief' ? 'Apply approved site brief' : targetExecution.target === 'investigation_link' ? 'Apply approved investigation link' : `Apply approved ${formatActionType(targetExecution.target)}`}</h2></div><button type="button" onClick={() => setTargetExecution(null)}><X size={18} /><span className="sr-only">Close</span></button></div><p className="approvals-context">Enter the authoritative target details explicitly. No inference is applied silently.</p>{renderTargetExecutionFields()}<div className="approvals-dialog-actions"><button type="button" onClick={() => setTargetExecution(null)}>Cancel</button><button type="submit" className="is-approve" disabled={busyId === targetExecution.proposal.id}>{targetExecution.target === 'credential' ? 'Apply approved credential' : targetExecution.target === 'hr_case' ? 'Apply approved HR document' : targetExecution.target === 'site_brief' ? 'Apply approved site brief' : targetExecution.target === 'investigation_link' ? 'Apply approved investigation link' : `Apply approved ${formatActionType(targetExecution.target)}`}</button></div></form></div>}
      <header className="approvals-heading">
        <div><span>{approvalView.eyebrow}</span><h1>{approvalView.title}</h1><p>{approvalView.description}</p></div>
        <div className="approvals-heading-actions"><span>{approvalView.scope}</span><button type="button" onClick={() => void loadActivity()} disabled={loading}><RefreshCw size={17} className={loading ? 'is-spinning' : ''} /> Refresh</button></div>
      </header>

      {workAreas.length > 1 && <div className="approvals-work-areas" role="tablist" aria-label="Approval work area">{workAreas.map((area) => <button type="button" role="tab" aria-selected={reviewArea === area.id} className={reviewArea === area.id ? 'is-active' : ''} onClick={() => setReviewArea(area.id)} key={area.id}><span>{area.label}</span><strong>{area.count}</strong></button>)}</div>}

      {reviewArea === 'actions' && <section className="approvals-summary" aria-label="Approval queue summary">
        <div><Clock3 size={18} /><span>Pending</span><strong>{pendingCount}</strong></div>
        <div><ShieldCheck size={18} /><span>You can decide</span><strong>{decidableCount}</strong></div>
        <div><AlertTriangle size={18} /><span>Failed</span><strong>{failedCount}</strong></div>
        <div><History size={18} /><span>Visible activity</span><strong>{rows.length}</strong></div>
      </section>}

      {reviewArea === 'documents' && documentReviews.length > 0 && <section className="approvals-queue" aria-label="Bob document review queue"><div className="approvals-panel-heading"><div><span>Bob authoring</span><h2>Documents needing review</h2></div><FileCheck2 size={18} /></div><div className="approvals-list">{documentReviews.map((document) => <article className="status-pending" key={document.version_id}><div><strong>{document.title}</strong><small>{formatActionType(document.document_type)} · {formatAge(document.updated_at)}</small></div><p>{document.review_reason ?? 'The author requested human review of this document.'}</p><small>Source file: {document.file_name} · Conversation-only until approved{document.unconfirmed_count ? ` · ${document.unconfirmed_count} unconfirmed field${document.unconfirmed_count === 1 ? '' : 's'}` : ''}</small>{document.preview ? <details className="approvals-payload"><summary>Preview draft content</summary><p>{document.preview.slice(0, 1200)}</p></details> : <p>Open the draft to inspect its full content and source details.</p>}<small>Review and approve or reject this draft in Document Studio.</small><div className="approvals-actions"><button type="button" className="is-secondary" onClick={() => navigate(`/admin/document-studio?document=${encodeURIComponent(document.document_id)}&version=${encodeURIComponent(document.version_id)}`)}>Open exact draft in Studio</button></div></article>)}</div></section>}

      {reviewArea === 'plans' && plans.length > 0 && <section className="approvals-queue" aria-label="Governed job plans"><div className="approvals-panel-heading"><div><span>Whole-plan approval</span><h2>Job plans awaiting review</h2></div><ListChecks size={18} /></div><div className="approvals-list">{plans.map((plan) => { const steps = planSteps[plan.id] ?? []; return <article className={`status-${plan.status}`} key={plan.id}><div><strong>{plan.goal}</strong><small>{steps.length} ordered step{steps.length === 1 ? '' : 's'} · {formatAge(plan.created_at)}</small></div><p>{plan.reasoning ?? 'No plan reasoning was recorded.'}</p><small>{steps.map((step) => `${step.sequence + 1}. ${formatActionType(step.action_type)} (${step.status})`).join(' · ')}</small>{plan.status === 'proposed' && <div className="approvals-actions"><button type="button" className="is-reject" onClick={() => openPlanDecision(plan, 'reject')}><XCircle size={17} /> Reject plan</button><button type="button" className="is-approve" onClick={() => openPlanDecision(plan, 'approve')}><CheckCircle2 size={17} /> Review plan</button></div>}</article>; })}</div></section>}

      {reviewArea === 'runs' && jobRuns.length > 0 && <section className="approvals-queue approvals-job-history" aria-label="Bob job history">
        <div className="approvals-panel-heading"><div><span>Delivery and recovery trail</span><h2>Bob job history</h2></div><History size={18} /></div>
        <p className="approvals-context">Inspect what ran, what completed, and which records were affected. Generic reversal and hard deletion are unavailable; corrections must use the affected module&apos;s governed workflow.</p>
        <div className="approvals-list">
          {jobRuns.map((run) => {
            const targetReferences = jobTargetReferences.filter((reference) => reference.job_id === run.job_id);
            const completedSteps = run.steps.filter((step) => step.status === 'ok').length;
            return <article className={`status-${run.status}`} key={run.id}>
              <div><strong>{run.goal}</strong><small>{formatActionType(run.status)} · {formatAge(run.created_at)}</small></div>
              <div className="approvals-job-run-summary">
                <div><span>Progress</span><strong>{completedSteps} of {run.steps.length} steps completed</strong></div>
                <div><span>Approval mode</span><strong>{formatActionType(run.approval_mode)}</strong></div>
                <div><span>Write scope</span><strong>{run.contains_writes ? `${targetReferences.length} target reference${targetReferences.length === 1 ? '' : 's'}` : 'Read only'}</strong></div>
              </div>
              {run.stopped_reason && <div className="approvals-outcome is-failed"><AlertTriangle size={16} /><div><strong>Run stopped</strong><span>{formatActionType(run.stopped_reason)}</span></div></div>}
              {run.clarifications.length > 0 && <div className="approvals-change-summary"><span>Human follow-up</span><ul>{run.clarifications.map((clarification) => <li key={clarification}>{clarification}</li>)}</ul></div>}
              {run.steps.length > 0 && <details className="approvals-payload"><summary>Review step outcomes</summary><ol className="approvals-job-steps">{run.steps.map((step, index) => <li key={`${run.id}-${step.step_id ?? index}`}><strong>{step.tool ? formatActionType(step.tool) : `Step ${index + 1}`}</strong><span>{formatActionType(step.status ?? 'unknown')} · {formatActionType(step.kind ?? 'unspecified')}</span></li>)}</ol></details>}
              {targetReferences.length > 0 ? <div className="approvals-target-references"><span>Affected records</span>{targetReferences.map((reference) => <div key={reference.id}><strong>{reference.target_table ? formatActionType(reference.target_table) : 'Target not recorded'}</strong><code>{reference.target_record_id ?? 'No record ID'}</code><small>{reference.reversed ? `Legacy reversal recorded ${reference.reversed_at ? formatAge(reference.reversed_at) : ''}` : 'Automatic reversal unavailable. Use the target module correction, void, or deactivation workflow.'}</small></div>)}</div> : <div className="approvals-outcome"><ShieldCheck size={16} /><div><strong>{run.contains_writes ? 'No recoverable target receipt' : 'No records changed'}</strong><span>{run.contains_writes ? 'Do not infer that this run can be reversed. Review the step result and use the affected module workflow.' : 'This run was read-only, so no correction action is required.'}</span></div></div>}
            </article>;
          })}
        </div>
      </section>}

      {reviewArea === 'documents' && documentPromotions.length > 0 && <section className="approvals-queue" aria-label="Document promotion queue"><div className="approvals-panel-heading"><div><span>Reference library</span><h2>Documents awaiting review</h2></div><ShieldCheck size={18} /></div><div className="approvals-list">{documentPromotions.map((document) => <article className="status-pending" key={document.version_id}><div><strong>{document.file_name}</strong><small>{document.privacy_class ?? 'Unclassified'} · {document.confidence == null ? 'No confidence' : `${Math.round(document.confidence * 100)}% confidence`} · {document.reviewed_at ? 'Human reviewed' : 'Review pending'}</small></div><div className="approvals-document-flags">{document.contains_pii && <span>PII</span>}{document.contains_operational_security && <span>Operational security</span>}{document.contains_financial_data && <span>Financial data</span>}{document.contains_legal_privilege && <span>Legal privilege</span>}</div><p>{document.ocr_required ? 'OCR is still required before reliable classification.' : document.rationale ?? 'Open the source document to review its classification, evidence, and tenant scope.'}</p>{document.extracted_text && <details className="approvals-payload"><summary>Extracted source preview</summary><p>{document.extracted_text.slice(0, 900)}</p></details>}<small>Classifier: {document.classifier_source ?? 'Unavailable'} · Scope: {document.scope.replaceAll('_', ' ')}</small><div className="approvals-actions"><button type="button" className="is-secondary" onClick={() => navigate(`/admin/document-studio?document=${encodeURIComponent(document.document_id)}&version=${encodeURIComponent(document.version_id)}`)}>Open source review</button></div></article>)}</div></section>}
      {reviewArea === 'documents' && promotionProposals.length > 0 && <section className="approvals-queue" aria-label="Document promotion proposals"><div className="approvals-panel-heading"><div><span>Domain intake</span><h2>Promotion proposals</h2></div><FileCheck2 size={18} /></div><div className="approvals-list">{promotionProposals.map((proposal) => <article className={`status-${proposal.status}`} key={proposal.id}><div><strong>{proposal.document_version?.documents?.original_filename ?? 'Document proposal'}</strong><small>{formatActionType(proposal.target_type)} · {proposal.status} · {formatAge(proposal.created_at)}</small></div><details className="approvals-payload"><summary>Proposed fields</summary><pre>{formatGovernedPayload(proposal.proposed_payload)}</pre></details>{typeof proposal.source_map.source_excerpt === 'string' && <details className="approvals-payload"><summary>Source excerpt</summary><p>{proposal.source_map.source_excerpt}</p></details>}{proposal.review_reason && <small>Review reason: {proposal.review_reason}</small>}{proposal.status === 'approved' && <p className="approvals-proposal-boundary">No authoritative CRM record has been created by this approval.</p>}{proposal.status === 'approved' && proposal.target_type === 'crm_agreement' && <div className="approvals-actions"><button type="button" className="is-approve" onClick={() => { setExecutionProposal(proposal); setExecutionForm({ clientOrganizationId: '', name: String(proposal.proposed_payload.title ?? ''), startsOn: '', endsOn: '' }); }}>Apply to CRM</button></div>}{proposal.status === 'proposed' && <div className="approvals-actions">{proposal.document_version?.documents?.id && proposal.document_version.id ? <button type="button" className="is-secondary" onClick={() => navigate(`/admin/document-studio?document=${encodeURIComponent(proposal.document_version!.documents!.id)}&version=${encodeURIComponent(proposal.document_version!.id)}`)}>Review proposal in source Studio</button> : <small>Source document version is unavailable; this proposal cannot be reviewed here.</small>}</div>}</article>)}</div></section>}

      {reviewArea === 'documents' && promotionProposals.some((proposal) => proposal.status === 'approved' && proposal.target_type === 'finance_reconciliation') && <section className="approvals-queue" aria-label="Approved finance proposals"><div className="approvals-panel-heading"><div><span>Finance intake</span><h2>Approved finance proposals</h2></div><FileCheck2 size={18} /></div><div className="approvals-actions">{promotionProposals.filter((proposal) => proposal.status === 'approved' && proposal.target_type === 'finance_reconciliation').map((proposal) => <button type="button" className="is-approve" key={proposal.id} onClick={() => { setFinanceProposal(proposal); setFinanceForm({ clientOrganizationId: '', serviceAgreementId: '', invoiceNumber: '', invoiceDate: new Date().toISOString().slice(0, 10), dueDate: '', subtotal: '', gstAmount: '', totalAmount: '', notes: '' }); }}>Create draft invoice for {proposal.document_version?.documents?.original_filename ?? 'approved proposal'}</button>)}</div></section>}
      {reviewArea === 'documents' && promotionProposals.some((proposal) => proposal.status === 'approved' && ['credential','hr_case','site_brief','investigation_link'].includes(proposal.target_type)) && <section className="approvals-queue" aria-label="Approved operational proposals"><div className="approvals-panel-heading"><div><span>Operational intake</span><h2>Approved operational proposals</h2></div><FileCheck2 size={18} /></div><div className="approvals-list">{promotionProposals.filter((proposal) => proposal.status === 'approved' && ['credential','hr_case','site_brief','investigation_link'].includes(proposal.target_type)).map((proposal) => <article className="status-approved" key={proposal.id}><strong>{proposal.document_version?.documents?.original_filename ?? 'Approved proposal'}</strong><small>{formatActionType(proposal.target_type)}</small><div className="approvals-actions"><button type="button" className="is-approve" onClick={() => { setTargetExecution({ proposal, target: proposal.target_type as DomainProposalTarget }); setTargetForm({ ...targetForm, name: String(proposal.proposed_payload.title ?? '') }); }}>{`Apply ${formatActionType(proposal.target_type)}`}</button></div></article>)}</div></section>}
      {error && <div className="approvals-message is-error" role="alert"><AlertTriangle size={17} /><span>{error}</span><button type="button" onClick={() => setError(null)}><X size={16} /><span className="sr-only">Dismiss</span></button></div>}
      {notice && <div className={`approvals-message ${notice.includes('failed') ? 'is-warning' : 'is-success'}`} role="status"><CheckCircle2 size={17} /><span>{notice}</span><button type="button" onClick={() => setNotice(null)}><X size={16} /><span className="sr-only">Dismiss</span></button></div>}

      {reviewArea === 'actions' && <>
      <div className="approvals-toolbar">
        <div className="approvals-filters" role="tablist" aria-label="Action status">
          {visibleStatusFilters.map((item) => <button type="button" role="tab" aria-selected={filter === item.id} className={filter === item.id ? 'is-active' : ''} onClick={() => setFilter(item.id)} key={item.id}>{item.label}</button>)}
        </div>
        <label className="approvals-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search actions, organisations, or targets" /></label>
      </div>

      <div className="approvals-layout">
        <section className="approvals-queue" aria-label="Governed action queue">
          <div className="approvals-panel-heading"><div><span>Queue</span><h2>{filter === 'all' ? 'All governed activity' : `${filter} actions`}</h2></div><Filter size={18} /></div>
          {loading ? <div className="approvals-empty"><RefreshCw size={20} className="is-spinning" /> Loading governed actions</div> : visibleRows.length === 0 ? <div className="approvals-empty"><FileCheck2 size={21} /> No actions match this view</div> : (
            <div className="approvals-list">
              {visibleRows.map((row) => (
                <button type="button" className={`${selectedId === row.id ? 'is-selected' : ''} status-${statusClass(row.status)}`} onClick={() => setSelectedId(row.id)} key={row.id}>
                  <span className="approvals-status-mark" />
                  <div><strong>{formatActionType(row.action_type)}</strong><small>{row.context_summary ?? row.context_table ?? 'No context summary provided'}</small></div>
                  <div><span>{row.org_name ?? 'Organisation unavailable'}</span><time dateTime={row.created_at}>{formatAge(row.created_at)}</time></div>
                  <ChevronRight size={17} />
                </button>
              ))}
            </div>
          )}
        </section>

        <aside className="approvals-detail">
          {!selected ? <div className="approvals-empty"><FileCheck2 size={22} /> Select an action to inspect</div> : (
            <>
              <div className="approvals-panel-heading"><div><span>Action review</span><h2>{formatActionType(selected.action_type)}</h2></div><span className={`approvals-status status-${statusClass(selected.status)}`}>{formatActionType(selected.status)}</span></div>
              <p className="approvals-context">{selected.context_summary ?? 'No context summary was provided for this action.'}</p>

              <section className="approvals-live-summary" aria-label="Live evidence and action summary">
                <div className="approvals-live-summary-header">
                  <span>Live evidence</span>
                  <strong>{selected.org_name ?? 'Organisation unavailable'}</strong>
                </div>
                <div className="approvals-live-grid">
                  <div><span>Target</span><strong>{selected.context_table ?? 'Not specified'}</strong></div>
                  <div><span>Triggered by</span><strong>{selected.triggered_by_name ?? selected.user_name ?? 'Unknown'}</strong></div>
                  <div><span>Created</span><strong>{new Date(selected.created_at).toLocaleString('en-NZ')}</strong></div>
                  <div><span>Confidence</span><strong>{selected.confidence_score == null ? 'Not supplied' : `${Math.round(selected.confidence_score * 100)}%`}</strong></div>
                </div>
              </section>

              <section className="approvals-change-summary">
                <span>What this will change</span>
                <ul>
                  <li><strong>Organisation:</strong> {selected.org_name ?? 'Unavailable'}</li>
                  <li><strong>Target record:</strong> {selected.context_table ?? 'Not specified'}</li>
                  <li><strong>Decision owner:</strong> {selected.assigned_approver_id ? selected.assigned_approver_name ?? 'Assigned approver unavailable' : 'Role and organisation scope'}</li>
                  <li><strong>Your authority:</strong> {selected.can_decide ? 'Can decide' : 'View only'}</li>
                </ul>
              </section>

              <section className="approvals-reasoning"><span>Review action</span><p>{selected.bob_reasoning ?? 'No reasoning was recorded with this proposal.'}</p></section>
              {selected.action_type === 'create_patrol_route_assignment' ? <HumanPatrolAssignmentSummary payload={selectedPayload(selected)} labels={payloadLabels} /> : <details className="approvals-payload"><summary>Proposal details</summary><pre>{formatGovernedPayload(selected.amended_payload ?? selected.proposed_payload)}</pre>{selected.amended_payload && <small>Showing the human-amended payload.</small>}</details>}
              <details className="approvals-payload"><summary>Edit before apply</summary><pre>{formatGovernedPayload(selected.amended_payload ?? selected.proposed_payload)}</pre>{selected.amended_payload && <small>Showing the editable live payload before application.</small>}</details>

              {selected.rejection_reason && <div className="approvals-outcome is-rejected"><XCircle size={17} /><div><strong>Rejection reason</strong><span>{selected.rejection_reason}</span></div></div>}
              {selected.error_message && <div className="approvals-outcome is-failed"><AlertTriangle size={17} /><div><strong>Application error</strong><span>{selected.error_message}</span></div></div>}
              {selected.result_record_id && <div className="approvals-outcome is-applied"><CheckCircle2 size={17} /><div><strong>Applied result</strong><span>{selected.result_table ?? 'record'} · {selected.result_record_id}</span></div></div>}

              {isPendingAction(selected.status) && (
                selected.can_decide ? <div className="approvals-actions"><button type="button" className="is-reject" onClick={() => openDecision('reject')}><XCircle size={17} /> Reject action</button><button type="button" className="is-approve" onClick={() => openDecision('approve')}><CheckCircle2 size={17} /> Approve action</button></div> : <div className="approvals-no-authority"><ShieldCheck size={17} /> {selected.assigned_approver_name ? `${selected.assigned_approver_name} owns this decision. Your current scope is view only.` : 'This decision is routed by role and organisation scope. Your current scope is view only.'}</div>
              )}
            </>
          )}
        </aside>
      </div>
      </>}

      {decision && selected && (
        <div className="approvals-dialog-backdrop">
          <form className="approvals-dialog" onSubmit={submitDecision} role="dialog" aria-modal="true" aria-labelledby="decision-title">
            <div className="approvals-panel-heading"><div><span>Governed decision</span><h2 id="decision-title">{decision === 'approve' ? 'Approve action' : 'Reject action'}</h2></div><button type="button" onClick={() => setDecision(null)}><X size={18} /><span className="sr-only">Close</span></button></div>
            <div className="approvals-decision-target"><strong>{formatActionType(selected.action_type)}</strong><span>{selected.org_name ?? 'Unknown organisation'} · {selected.context_table ?? 'No target specified'}</span></div>
            <label><span>Decision reasoning</span><textarea required rows={4} value={reasoning} onChange={(event) => setReasoning(event.target.value)} placeholder={decision === 'approve' ? 'Why is this action appropriate and safe to approve?' : 'Why should this action not proceed?'} /></label>
            {decision === 'approve' && <label className="approvals-apply-option"><input type="checkbox" checked={applyAfterApprove} onChange={(event) => setApplyAfterApprove(event.target.checked)} /><span><strong>Approve and apply immediately</strong><small>Approval and execution remain separate audited steps. Leave off to approve without applying.</small></span></label>}
            <div className="approvals-dialog-actions"><button type="button" onClick={() => setDecision(null)}>Cancel</button><button type="submit" className={decision === 'approve' ? 'is-approve' : 'is-reject'} disabled={busyId === selected.id || !reasoning.trim()}>{busyId === selected.id ? 'Recording decision' : decision === 'approve' ? applyAfterApprove ? 'Approve and apply' : 'Approve' : 'Reject'}</button></div>
          </form>
        </div>
      )}
      {planDecision && selectedPlanId && (
        <div className="approvals-dialog-backdrop"><form className="approvals-dialog" onSubmit={submitPlanDecision} role="dialog" aria-modal="true" aria-labelledby="plan-decision-title"><div className="approvals-panel-heading"><div><span>Whole-plan decision</span><h2 id="plan-decision-title">{planDecision === 'approve' ? 'Approve job plan' : 'Reject job plan'}</h2></div><button type="button" onClick={() => { setPlanDecision(null); setSelectedPlanId(null); }}><X size={18} /><span className="sr-only">Close</span></button></div><label><span>Decision reasoning</span><textarea required rows={4} value={reasoning} onChange={(event) => setReasoning(event.target.value)} placeholder="Record why this whole plan should proceed or stop." /></label><div className="approvals-dialog-actions"><button type="button" onClick={() => { setPlanDecision(null); setSelectedPlanId(null); }}>Cancel</button><button type="submit" className={planDecision === 'approve' ? 'is-approve' : 'is-reject'} disabled={busyId === selectedPlanId || !reasoning.trim()}>{busyId === selectedPlanId ? 'Recording decision' : planDecision === 'approve' ? 'Approve plan' : 'Reject plan'}</button></div></form></div>
      )}
      {executionProposal && <div className="approvals-dialog-backdrop"><form className="approvals-dialog" onSubmit={applyCrmAgreementProposal} role="dialog" aria-modal="true" aria-labelledby="crm-proposal-apply-title"><div className="approvals-panel-heading"><div><span>Authoritative CRM action</span><h2 id="crm-proposal-apply-title">Apply approved agreement</h2></div><button type="button" onClick={() => setExecutionProposal(null)}><X size={18} /><span className="sr-only">Close</span></button></div><p className="approvals-context">Explicit party and date confirmation is required before a service agreement is created.</p><label><span>Client organisation</span><select required value={executionForm.clientOrganizationId} onChange={(event) => setExecutionForm({ ...executionForm, clientOrganizationId: event.target.value })}><option value="">Select client organisation</option>{clientOrganizations.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label><label><span>Agreement name</span><input required value={executionForm.name} onChange={(event) => setExecutionForm({ ...executionForm, name: event.target.value })} /></label><div className="approvals-review-checks"><label><span>Starts</span><input type="date" value={executionForm.startsOn} onChange={(event) => setExecutionForm({ ...executionForm, startsOn: event.target.value })} /></label><label><span>Ends</span><input type="date" value={executionForm.endsOn} onChange={(event) => setExecutionForm({ ...executionForm, endsOn: event.target.value })} /></label></div><div className="approvals-dialog-actions"><button type="button" onClick={() => setExecutionProposal(null)}>Cancel</button><button type="submit" className="is-approve" disabled={busyId === executionProposal.id || !executionForm.clientOrganizationId || !executionForm.name.trim()}>{busyId === executionProposal.id ? 'Creating agreement...' : 'Create service agreement'}</button></div></form></div>}
      {financeProposal && <div className="approvals-dialog-backdrop"><form className="approvals-dialog" onSubmit={applyFinanceProposal} role="dialog" aria-modal="true" aria-labelledby="finance-proposal-apply-title"><div className="approvals-panel-heading"><div><span>Finance action</span><h2 id="finance-proposal-apply-title">Create draft invoice</h2></div><button type="button" onClick={() => setFinanceProposal(null)}><X size={18} /><span className="sr-only">Close</span></button></div><p className="approvals-context">Enter and reconcile the financial values explicitly. This creates a draft only.</p><label><span>Client organisation</span><select required value={financeForm.clientOrganizationId} onChange={(event) => setFinanceForm({ ...financeForm, clientOrganizationId: event.target.value })}><option value="">Select client organisation</option>{clientOrganizations.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label><label><span>Service agreement ID (optional)</span><input value={financeForm.serviceAgreementId} onChange={(event) => setFinanceForm({ ...financeForm, serviceAgreementId: event.target.value })} /></label><div className="approvals-review-checks"><label><span>Invoice number</span><input required value={financeForm.invoiceNumber} onChange={(event) => setFinanceForm({ ...financeForm, invoiceNumber: event.target.value })} /></label><label><span>Invoice date</span><input required type="date" value={financeForm.invoiceDate} onChange={(event) => setFinanceForm({ ...financeForm, invoiceDate: event.target.value })} /></label><label><span>Due date</span><input type="date" value={financeForm.dueDate} onChange={(event) => setFinanceForm({ ...financeForm, dueDate: event.target.value })} /></label><label><span>Subtotal</span><input required type="number" min="0" step="0.01" value={financeForm.subtotal} onChange={(event) => setFinanceForm({ ...financeForm, subtotal: event.target.value })} /></label><label><span>GST</span><input type="number" min="0" step="0.01" value={financeForm.gstAmount} onChange={(event) => setFinanceForm({ ...financeForm, gstAmount: event.target.value })} /></label><label><span>Total</span><input required type="number" min="0.01" step="0.01" value={financeForm.totalAmount} onChange={(event) => setFinanceForm({ ...financeForm, totalAmount: event.target.value })} /></label></div><label><span>Notes</span><textarea rows={3} value={financeForm.notes} onChange={(event) => setFinanceForm({ ...financeForm, notes: event.target.value })} /></label><div className="approvals-dialog-actions"><button type="button" onClick={() => setFinanceProposal(null)}>Cancel</button><button type="submit" className="is-approve" disabled={busyId === financeProposal.id || !financeForm.clientOrganizationId || !financeForm.invoiceNumber.trim() || !financeForm.invoiceDate || !financeForm.subtotal || !financeForm.totalAmount}>{busyId === financeProposal.id ? 'Creating draft invoice...' : 'Create draft invoice'}</button></div></form></div>}
      </div>
    </ShellLayout>
    </>
  );
};

function formatActionType(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function selectedPayload(row: ApprovalRow | null): Record<string, any> | null {
  return (row?.amended_payload ?? row?.proposed_payload ?? null) as Record<string, any> | null;
}

function HumanPatrolAssignmentSummary({ payload, labels }: { payload: Record<string, any> | null; labels: Record<string, string> }) {
  if (!payload) return null;
  const days = Array.isArray(payload.active_days) ? payload.active_days.map((day: number) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][day - 1] ?? day).join(', ') : 'Not specified';
  return <section className="approvals-human-summary" aria-label="Human-readable patrol assignment"><div><span>Site</span><strong>{labels.site_id ?? 'Site name unavailable'}</strong></div><div><span>Patrol route / bucket</span><strong>{labels.patrol_route_id ?? 'Route name unavailable'}</strong></div><div><span>Service</span><strong>{String(payload.module_key ?? 'Not specified').replaceAll('_', ' ')}</strong></div><div><span>Visit window</span><strong>{payload.window_start && payload.window_end ? `${payload.window_start} to ${payload.window_end}` : 'Not specified'}</strong></div><div><span>Visits per shift</span><strong>{payload.visits_per_shift ?? 'Not specified'}</strong></div><div><span>Active days</span><strong>{days}</strong></div><div><span>Dwell time</span><strong>{payload.dwell_minutes != null ? `${payload.dwell_minutes} minutes` : 'Not specified'}</strong></div><div><span>Arrival / departure SLA</span><strong>{payload.sla_arrive_within_minutes != null ? `${payload.sla_arrive_within_minutes} / ${payload.sla_depart_within_minutes ?? 'not set'} minutes` : 'Not specified'}</strong></div><div><span>Stop order</span><strong>{payload.preferred_stop_order ?? 'Not specified'}</strong></div><div className="is-wide"><span>Instructions</span><strong>{payload.officer_instructions ?? 'None recorded'}</strong></div></section>;
}

function formatAge(value: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default ApprovalsActivityPage;