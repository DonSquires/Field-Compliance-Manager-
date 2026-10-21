import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Bot, CheckCircle2, ChevronRight, CircleStop, Clock3, Database, FileCode2, FolderTree, MessageSquareText, Play, Plus, RefreshCw, Search, ShieldCheck, Sparkles, TerminalSquare, Workflow, X } from 'lucide-react';
import { BobPanel } from '../components/BobPanel';
import { ChangeRequestQueue } from '../components/ChangeRequestQueue';
import { BuilderApprovalBrief } from '../components/BuilderApprovalBrief';
import { jobMatchesSearch } from '../lib/builderJobSearch';
import { builderRequestError } from '../lib/builderRequestError';
import { BuilderLiveActivity, builderSuccessorId, deriveLiveActivity, isLiveJob, type LiveChangedFile, type LiveEvent, type LiveModelRun, type LivePollState } from '../components/BuilderLiveActivity';
import { supabase } from '../lib/supabase';
import './BuilderControlRoomPage.css';

type ReviewMode = 'none' | 'human' | 'independent_ai';
type RequestedAction = 'prepare_change' | 'prepare_release';
type TargetEnvironment = 'development' | 'staging' | 'production';
type WorkspaceView = 'task' | 'evidence' | 'execution' | 'context';
type JobFilterTab = 'all' | 'issues' | 'active' | 'awaiting' | 'completed' | 'failed' | 'cancelled';
type ScopeFilter = 'all' | 'frontend' | 'backend' | 'fullstack';
type MobileWorkspaceView = 'queue' | 'workbench' | 'agent';

interface BuilderProject {
  id: string;
  organization_id: string;
  gitea_owner: string;
  gitea_repo: string;
  name: string;
}

interface BuilderJob {
  id: string;
  organization_id: string;
  project_id: string;
  title: string;
  task_description?: string;
  status: string;
  current_step_name: string | null;
  target_sha: string;
  workspace_branch: string | null;
  workspace_head_sha: string | null;
  workspace_published_at: string | null;
  workspace_published_head_sha: string | null;
  workspace_pull_request_url: string | null;
  workspace_pull_request_head_sha: string | null;
  requested_action?: RequestedAction | null;
  target_environment?: TargetEnvironment | null;
  frontend_required: boolean;
  backend_required: boolean;
  code_review_mode?: ReviewMode | null;
  code_review_status: string;
  last_error: string | null;
  autopilot_requested_by?: string | null;
  autopilot_state?: string | null;
  autopilot_report?: Record<string, unknown> | null;
  autopilot_updated_at?: string | null;
  created_at: string;
  updated_at: string;
}

interface BuilderStep {
  id: string;
  step_id: string;
  ordinal_position: number;
  builder_mode: string;
  status: string;
  attempt_count: number;
  result_summary: string | null;
  error: string | null;
  retryable: boolean;
  started_at?: string | null;
  completed_at?: string | null;
}

interface BuilderArtifact {
  id: string;
  step_id: string | null;
  artifact_type: string;
  status: string;
  checksum: string | null;
  content_size_bytes: number | null;
}

interface BuilderWorkerRun {
  id: string;
  step_id: string;
  profile: string;
  status: string;
  target_sha: string | null;
  exit_code: number | null;
  started_at?: string | null;
  completed_at?: string | null;
  heartbeat_at?: string | null;
}
interface BuilderApproval {
  id: string;
  approval_type: string;
  triggered_at_status: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  requested_at: string;
  requested_target_sha: string | null;
  reviewed_artifact_ids: string[];
  approval_comment: string | null;
  responded_at: string | null;
}

interface BuilderSnapshot {
  job: BuilderJob;
  steps: BuilderStep[];
  artifacts: BuilderArtifact[];
  workerRuns: BuilderWorkerRun[];
  approvals: BuilderApproval[];
  modelRuns?: LiveModelRun[];
  events?: LiveEvent[];
  telemetry?: { model_runs_available: boolean; events_available: boolean; observed_at: string };
}

const LIVE_POLL_MS = 4000;
const LIVE_POLL_MAX_BACKOFF_MS = 60000;

interface BuilderContextSnapshot {
  build_map: { file_count: number; schema: { tables: string[] } };
  live_context: { atlas: { capability_count: number; edge_count: number; wired_capability_count: number; exercised_capability_count: number; capability_last_refreshed_at: string | null }; live_data: { tables: Array<{ table: string; count: number | null; available: boolean }> } };
}

const plainWords = (value: unknown, fallback = 'Not recorded') => typeof value === 'string' && value.trim() ? value.replaceAll('_', ' ') : fallback;
const NON_ACTIONABLE_ISSUE_STATUSES = new Set(['release_ready', 'deployed', 'failed', 'cancelled']);
const isActionableIssue = (job: BuilderJob) => !NON_ACTIONABLE_ISSUE_STATUSES.has(job.status)
  && !builderSuccessorId(job)
  && (String(job.title).toLowerCase().startsWith('repair') || Boolean(job.last_error));
const asRecord = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const asText = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;

function builderDeliveryTruth(job: BuilderJob) {
  const report = asRecord(job.autopilot_report);
  const deployment = asRecord(report?.deployment);
  const mergeSha = asText(report?.merge_sha);
  const sourceSha = asText(deployment?.source_sha);
  const exactReceipt = report?.merged === true
    && deployment?.status === 'success'
    && deployment?.live_verified === true
    && Boolean(mergeSha && sourceSha === mergeSha);
  if (exactReceipt) return { label: 'Live verified', detail: `Production ${sourceSha!.slice(0, 12)} matches the merged commit.`, tone: 'complete' };
  if (job.status === 'release_ready') return { label: 'Ready, not live', detail: 'Verification passed, but merge and Production receipts are still separate.', tone: 'waiting' };
  if (job.workspace_pull_request_url) return { label: 'Review opened', detail: 'A pull request exists; that is not deployment proof.', tone: 'working' };
  return { label: 'Not deployed', detail: 'No exact merge and Production receipt is recorded for this job.', tone: 'idle' };
}

function autopilotNotice(data: { autopilot?: unknown; autopilot_error?: unknown } | null, created: string) {
  if (data?.autopilot === true) return `${created} Bob is driving it to the next human gate.`;
  if (typeof data?.autopilot_error === 'string') return `${created} Bob could not take it (${data.autopilot_error}); use Let Bob drive or run it yourself.`;
  return created;
}

function builderNextAction(job: BuilderJob, snapshot: BuilderSnapshot) {
  if (builderSuccessorId(job)) return 'Open the newer job to inspect its current outcome. Do not rerun this historical attempt.';
  if (job.status === 'cancelled') return 'This job was cancelled. No approval or retry is required; its steps and errors are historical.';
  if (snapshot.approvals.some(approval => approval.status === 'pending')) return 'Review the immutable evidence and decide the pending approval.';
  if (job.last_error || snapshot.steps.some(step => step.status === 'failed')) return 'Inspect the failed step and its exact error before proposing an evidence-backed recovery.';
  if (job.status === 'deployed') return 'Review the exact deployment receipt and start a follow-up only if more work is needed.';
  if (job.status === 'release_ready') return 'Verify the pull request, merge decision, and separate Production receipt.';
  if (job.autopilot_state === 'blocked') return 'Bob is blocked. Inspect the latest recorded outcome before choosing a recovery.';
  if (job.autopilot_state === 'awaiting_human') return 'Bob is waiting for a human decision. Review the recorded gate before continuing.';
  if (job.autopilot_state === 'done') return 'Autopilot stopped on this record. Review its outcome before starting another attempt.';
  const activity = deriveLiveActivity(job, snapshot, Date.now());
  if (activity.tone === 'stalled') return 'No recent execution activity is recorded. Inspect the last model heartbeat and step error before retrying.';
  if (activity.runningModel || activity.runningWorker || snapshot.steps.some(step => step.status === 'running')) return 'Execution is recorded on this job. Follow its activity and resulting evidence; do not start a duplicate run.';
  if (job.autopilot_state === 'driving') return 'Bob autopilot is assigned to drive this job. Follow live activity for progress; assignment is not completion.';
  if (!job.autopilot_requested_by && !['deployed', 'failed', 'cancelled'].includes(job.status)) return 'Nobody is driving this job yet. Select Let Bob drive, or run it to the next gate yourself.';
  if (!job.workspace_branch) return 'Let Bob advance the plan, or create the isolated workspace when implementation is ready.';
  return 'Run to the next governed gate and review the resulting files, tests, and findings.';
}

const PROMPT_TEMPLATES = [
  {
    label: '🚀 New Feature',
    title: 'Build feature: [Feature name]',
    prompt: 'Goal: Build a new feature for [Feature name].\n\nUser intent: [Describe what the user wants to accomplish in plain English].\n\nRequirements:\n- Create UI components following FCM enterprise design\n- Connect to Supabase schema / RPCs\n- Include empty, loading, error, and permission states\n\nVerification:\n- Add unit and guard tests ensuring 100% test pass rate',
    frontend: true,
    backend: false,
  },
  {
    label: '🐛 Fix Defect',
    title: 'Fix issue: [Issue summary]',
    prompt: 'Goal: Fix the issue observed in [Component or page name].\n\nSymptom: [Describe the unexpected behavior or error message].\nExpected: [Describe the expected behavior].\n\nRoot cause diagnosis: [Identify which files/functions are implicated].\n\nVerification: Run relevant tests and verify the fix does not regress related surfaces.',
    frontend: true,
    backend: true,
  },
  {
    label: '🎨 UI/UX Vibe',
    title: 'Enhance UX: [Page or workflow name]',
    prompt: 'Goal: Enhance the UI/UX for [Page or workflow name] using natural language design.\n\nImprovements:\n- Add intuitive filtering, search, and state transitions\n- Improve accessibility, contrast, and responsive layout\n- Follow FCM design tokens and enterprise SaaS UX training standards',
    frontend: true,
    backend: false,
  },
  {
    label: '🛡️ Self-Heal',
    title: 'Repair tests: [Test file or area]',
    prompt: 'Goal: Repair failing test or guard assertions in [test file].\n\nDiagnosis: Check if the test expectation is stale vs current implementation or if code regressed.\nAction: Update the assertion or fix code to match canonical schema/Atlas truth.\nVerification: Confirm all tests pass.',
    frontend: true,
    backend: false,
  },
];

const TEMPLATE_PLACEHOLDER = /\[[^\]\n]{3,}\]/;
const hasTemplatePlaceholders = (value: string) => TEMPLATE_PLACEHOLDER.test(String(value || ''));

const BuilderControlRoomPage: React.FC<{ onOpenBob?: (prompt: string) => void; onOpenVibe?: () => void }> = ({ onOpenBob, onOpenVibe }) => {
  const [projects, setProjects] = useState<BuilderProject[]>([]);
  const [jobs, setJobs] = useState<BuilderJob[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<BuilderSnapshot | null>(null);
  const [contextSnapshot, setContextSnapshot] = useState<BuilderContextSnapshot | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [approvalComment, setApprovalComment] = useState('');
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('task');
  const [bobOpen, setBobOpen] = useState(true);
  const [mobileWorkspaceView, setMobileWorkspaceView] = useState<MobileWorkspaceView>('queue');
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [artifactContent, setArtifactContent] = useState<{ id: string; content: string; checksum: string | null } | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [followupTask, setFollowupTask] = useState('');
  const [cancellationReason, setCancellationReason] = useState('');
  const [activeTab, setActiveTab] = useState<JobFilterTab>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  const [pollState, setPollState] = useState<LivePollState>('idle');
  const [observedAt, setObservedAt] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [changedFiles, setChangedFiles] = useState<{ manifestId: string | null; files: LiveChangedFile[]; total: number | null; error: string | null } | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  const [form, setForm] = useState({
    projectId: '', title: '', taskDescription: '', targetSha: '', branchName: 'main',
    frontendRequired: true, backendRequired: false, codeReviewMode: 'human' as ReviewMode,
    requestedAction: 'prepare_change' as RequestedAction, targetEnvironment: 'development' as TargetEnvironment,
    autopilot: true,
  });

  const invoke = useCallback(async (body: Record<string, unknown>) => {
    const { data, error: invokeError } = await supabase.functions.invoke('bob-builder-control-room', { body });
    if (invokeError) {
      throw await builderRequestError(invokeError, body.action);
    }
    if (data?.error) throw new Error(typeof data.detail === 'string' && data.detail ? `${data.error}: ${data.detail}` : data.error);
    return data;
  }, []);

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await invoke({ action: 'list' });
      const nextProjects = (data?.projects ?? []) as BuilderProject[];
      const nextJobs = (data?.jobs ?? []) as BuilderJob[];
      setProjects(nextProjects);
      setJobs(nextJobs);
      setForm(current => ({ ...current, projectId: current.projectId || nextProjects[0]?.id || '' }));
      setSelectedId(current => current && nextJobs.some(job => job.id === current) ? current : nextJobs[0]?.id ?? null);
      return nextJobs;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Builder activity could not be loaded.');
      return null;
    } finally {
      setLoading(false);
    }
  }, [invoke]);

  const loadSnapshot = useCallback(async (jobId: string, options: { live?: boolean } = {}) => {
    try {
      const data = await invoke({ action: 'get', job_id: jobId, ...(options.live ? { live_poll: true } : {}) });
      // A slower response for a previously selected job must not overwrite the current selection.
      if (selectedIdRef.current !== jobId) return false;
      const next = data as BuilderSnapshot;
      setSnapshot(next);
      setObservedAt(next.telemetry?.observed_at ?? new Date().toISOString());
      if (next.job) setJobs(current => current.map(job => job.id === jobId ? { ...job, ...next.job } : job));
      return true;
    } catch (loadError) {
      if (options.live) throw loadError;
      if (selectedIdRef.current !== jobId) return false;
      setSnapshot(null);
      setError(loadError instanceof Error ? loadError.message : 'Builder job could not be loaded.');
      return false;
    }
  }, [invoke]);

  const loadContext = useCallback(async (jobId: string) => {
    setContextLoading(true);
    try {
      const data = await invoke({ action: 'context_snapshot', job_id: jobId });
      setContextSnapshot(data?.context as BuilderContextSnapshot);
    } catch (contextError) {
      setContextSnapshot(null);
    } finally { setContextLoading(false); }
  }, [invoke]);

  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => { setCancellationReason(''); }, [selectedId]);
  useEffect(() => { if (selectedId) { void loadSnapshot(selectedId); void loadContext(selectedId); } else { setSnapshot(null); setContextSnapshot(null); } }, [selectedId, loadSnapshot, loadContext]);

  const liveSnapshot = snapshot?.job?.id === selectedId ? snapshot : null;
  const shouldPoll = isLiveJob(liveSnapshot?.job ?? null, liveSnapshot);

  // Builder tables are service-role only and not on the realtime publication, so live state is polled
  // through the authorised edge function: only while work is active and the tab is visible, with backoff.
  useEffect(() => {
    if (!selectedId || !shouldPoll) { setPollState('idle'); setRetryAt(null); return undefined; }
    let cancelled = false;
    let timer: number | undefined;
    let failures = 0;
    const schedule = (delay: number) => { window.clearTimeout(timer); timer = window.setTimeout(tick, delay); };
    const tick = async () => {
      if (cancelled) return;
      if (document.hidden) { setPollState('paused'); return; }
      try {
        await loadSnapshot(selectedId, { live: true });
        if (cancelled) return;
        failures = 0;
        setPollState('live');
        setRetryAt(null);
        schedule(LIVE_POLL_MS);
      } catch {
        if (cancelled) return;
        failures += 1;
        const delay = Math.min(LIVE_POLL_MS * 2 ** failures, LIVE_POLL_MAX_BACKOFF_MS);
        setPollState('retrying');
        setRetryAt(Date.now() + delay);
        schedule(delay);
      }
    };
    const onVisibility = () => { if (!document.hidden && !cancelled) schedule(0); else setPollState('paused'); };
    document.addEventListener('visibilitychange', onVisibility);
    setPollState(document.hidden ? 'paused' : 'live');
    schedule(LIVE_POLL_MS);
    return () => { cancelled = true; window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [selectedId, shouldPoll, loadSnapshot]);

  useEffect(() => {
    if (!selectedId) return undefined;
    const interval = window.setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 1000);
    return () => window.clearInterval(interval);
  }, [selectedId]);

  const latestManifestId = liveSnapshot?.artifacts.filter(artifact => artifact.artifact_type === 'changed_file_manifest' && artifact.status === 'final').at(-1)?.id ?? null;
  useEffect(() => {
    if (!selectedId || !latestManifestId) { setChangedFiles(null); return undefined; }
    let cancelled = false;
    invoke({ action: 'changed_files', job_id: selectedId })
      .then(data => { if (!cancelled) setChangedFiles({ manifestId: latestManifestId, files: (data?.files ?? []) as LiveChangedFile[], total: typeof data?.manifest?.total === 'number' ? data.manifest.total : null, error: null }); })
      .catch(filesError => { if (!cancelled) setChangedFiles({ manifestId: latestManifestId, files: [], total: null, error: filesError instanceof Error ? filesError.message : 'Changed files could not be loaded.' }); });
    return () => { cancelled = true; };
  }, [selectedId, latestManifestId, invoke]);

  const selectedProject = projects.find(project => project.id === form.projectId) ?? null;
  const pendingJobs = jobs.filter(job => !builderSuccessorId(job) && !['release_ready', 'deployed', 'failed', 'cancelled'].includes(job.status)).length;
  const approvalJobs = jobs.filter(job => !builderSuccessorId(job) && !['deployed', 'failed', 'cancelled'].includes(job.status) && (['specification_ready', 'approval_pending'].includes(job.status) || (job.status === 'testing' && job.code_review_mode === 'human' && job.code_review_status === 'pending'))).length;
  const completedJobs = jobs.filter(job => ['deployed', 'release_ready'].includes(job.status)).length;
  const failedJobs = jobs.filter(job => job.status === 'failed').length;
  const cancelledJobs = jobs.filter(job => job.status === 'cancelled').length;
  const issueJobs = jobs.filter(isActionableIssue).length;

  const filteredJobs = useMemo(() => {
    return jobs.filter(job => {
      // 1. Tab filter
      if (activeTab === 'issues') {
        if (!isActionableIssue(job)) return false;
      } else if (activeTab === 'active') {
        if (builderSuccessorId(job) || ['release_ready', 'deployed', 'failed', 'cancelled'].includes(job.status)) return false;
      } else if (activeTab === 'awaiting') {
        const isAwaiting = !builderSuccessorId(job) && !['deployed', 'failed', 'cancelled'].includes(job.status) &&
          (['specification_ready', 'approval_pending'].includes(job.status) ||
          (job.status === 'testing' && job.code_review_mode === 'human' && job.code_review_status === 'pending'));
        if (!isAwaiting) return false;
      } else if (activeTab === 'completed') {
        if (!['deployed', 'release_ready'].includes(job.status)) return false;
      } else if (activeTab === 'failed') {
        if (job.status !== 'failed') return false;
      } else if (activeTab === 'cancelled') {
        if (job.status !== 'cancelled') return false;
      }

      // 2. Scope filter
      if (scopeFilter === 'frontend' && (!job.frontend_required || job.backend_required)) return false;
      if (scopeFilter === 'backend' && (!job.backend_required || job.frontend_required)) return false;
      if (scopeFilter === 'fullstack' && (!job.frontend_required || !job.backend_required)) return false;

      // 3. Search query
      if (searchQuery.trim() && !jobMatchesSearch(job, searchQuery)) return false;

      return true;
    });
  }, [jobs, activeTab, scopeFilter, searchQuery]);
  // A pasted job ID often belongs to a failed or release-ready job hidden by the active tab.
  const searchMatchesElsewhere = useMemo(() => {
    if (!searchQuery.trim()) return 0;
    const visible = new Set(filteredJobs.map(job => job.id));
    return jobs.filter(job => !visible.has(job.id) && jobMatchesSearch(job, searchQuery)).length;
  }, [jobs, filteredJobs, searchQuery]);

  const completedSteps = snapshot?.steps.filter(step => ['completed', 'skipped'].includes(step.status)).length ?? 0;

  const applyTemplate = (tpl: typeof PROMPT_TEMPLATES[number]) => {
    setForm(current => ({
      ...current,
      title: tpl.title,
      taskDescription: tpl.prompt,
      frontendRequired: tpl.frontend,
      backendRequired: tpl.backend,
    }));
  };

  const createJob = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedProject || !form.title.trim() || !form.taskDescription.trim()) return;
    if (hasTemplatePlaceholders(form.title) || hasTemplatePlaceholders(form.taskDescription)) {
      setError('Fill in template placeholders before creating the Builder job.');
      return;
    }
    if (!form.frontendRequired && !form.backendRequired) {
      setError('Select at least one implementation scope.');
      return;
    }
    setBusy('create');
    setError(null);
    try {
      const data = await invoke({
        action: 'create', organization_id: selectedProject.organization_id, project_id: selectedProject.id,
        title: form.title.trim(), task_description: form.taskDescription.trim(),
        target_sha: form.targetSha.trim().toLowerCase() || 'main',
        branch_name: form.branchName.trim() || 'main', frontend_required: form.frontendRequired,
        backend_required: form.backendRequired, code_review_mode: form.codeReviewMode,
        requested_action: form.requestedAction, target_environment: form.targetEnvironment,
        autopilot: form.autopilot,
      });
      setShowCreate(false);
      setNotice(autopilotNotice(data, 'Builder job created at the pinned commit.'));
      await loadList();
      if (data?.job?.id) setSelectedId(data.job.id);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Builder job could not be created.');
    } finally {
      setBusy(null);
    }
  };

  const advance = async (action: 'advance' | 'run') => {
    if (!selectedId) return;
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      // Bob finds source files and the control plane selects the independent reviewer model.
      const data = await invoke({ action, job_id: selectedId, max_actions: 8 });
      setNotice(data?.accepted
        ? data.already_running
          ? 'Bob is already working on this job. No duplicate run was started.'
          : `Builder ${action === 'run' ? 'run' : 'step'} accepted. Bob will work in the background; follow live activity for the outcome. This is not completion.`
        : data?.reason === 'waiting_for_human'
          ? 'Builder paused at a human approval gate.'
          : data?.reason === 'error'
            ? 'Builder stopped with an execution error. Review the recorded activity before retrying.'
            : `Builder ${action === 'run' ? 'run' : 'step'} returned. Review the recorded outcome.`);
      await Promise.all([loadList(), loadSnapshot(selectedId)]);
    } catch (advanceError) {
      setError(advanceError instanceof Error ? advanceError.message : 'Builder could not advance.');
    } finally {
      setBusy(null);
    }
  };

  const decideApproval = async (approval: BuilderApproval, decision: 'approved' | 'rejected') => {
    const note = approvalComment.trim();
    if (!selectedId || (decision === 'rejected' && !note)) return;
    setBusy(`approval-${approval.id}`);
    setError(null);
    setNotice(null);
    try {
      await invoke({ action: 'decide_approval', job_id: selectedId, approval_id: approval.id, decision, comment: note || 'Approved after reviewing the plain-language plan summary.' });
      setApprovalComment('');
      setNotice(decision === 'approved' ? 'Human approval recorded.' : 'Human rejection recorded and the Builder job was stopped.');
      await loadList();
      await loadSnapshot(selectedId);
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : 'Builder approval could not be recorded.');
    } finally {
      setBusy(null);
    }
  };

  const createWorkspace = async () => {
    if (!selectedId) return;
    setBusy('workspace');
    setError(null);
    try {
      const data = await invoke({ action: 'create_workspace', job_id: selectedId });
      setNotice(`Builder workspace ready on ${data?.workspace?.branch ?? 'its dedicated branch'}.`);
      await Promise.all([loadList(), loadSnapshot(selectedId)]);
    } catch (workspaceError) {
      setError(workspaceError instanceof Error ? workspaceError.message : 'Builder workspace could not be created.');
    } finally { setBusy(null); }
  };

  const commitVerifiedPatch = async (artifact: BuilderArtifact) => {
    if (!selectedId) return;
    setBusy(`commit-${artifact.id}`);
    setError(null);
    try {
      const data = await invoke({ action: 'commit_verified_patch', job_id: selectedId, artifact_id: artifact.id });
      setNotice(`Verified patch committed to ${data?.commit?.branch ?? 'the Builder workspace branch'}.`);
      await Promise.all([loadList(), loadSnapshot(selectedId)]);
    } catch (commitError) {
      setError(commitError instanceof Error ? commitError.message : 'Verified Builder patch could not be committed.');
    } finally { setBusy(null); }
  };

  const publishWorkspace = async () => {
    if (!selectedId) return;
    setBusy('publish');
    setError(null);
    try {
      const data = await invoke({ action: 'publish_workspace', job_id: selectedId });
      setNotice(`Builder branch ${data?.publication?.branch ?? 'is'} published for review.`);
      await Promise.all([loadList(), loadSnapshot(selectedId)]);
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : 'Builder branch could not be published.');
    } finally { setBusy(null); }
  };

  const createPullRequest = async () => {
    if (!selectedId) return;
    setBusy('pull-request');
    setError(null);
    try {
      const data = await invoke({ action: 'create_pull_request', job_id: selectedId });
      setNotice('Builder pull request created for human review.');
      await Promise.all([loadList(), loadSnapshot(selectedId)]);
      if (data?.pull_request?.url) window.open(data.pull_request.url, '_blank', 'noopener,noreferrer');
    } catch (pullRequestError) {
      setError(pullRequestError instanceof Error ? pullRequestError.message : 'Builder pull request could not be created.');
    } finally { setBusy(null); }
  };

  const createFollowup = async () => {
    if (!selectedId || !selectedJob || !followupTask.trim()) return;
    setBusy('followup');
    setError(null);
    try {
      const data = await invoke({ action: 'create_followup', job_id: selectedId, title: `Follow-up: ${selectedJob.title}`, task_description: followupTask.trim(), frontend_required: selectedJob.frontend_required, backend_required: selectedJob.backend_required, code_review_mode: selectedJob.code_review_mode, autopilot: true });
      setFollowupTask('');
      setNotice(autopilotNotice(data, 'Builder follow-up created from the verified workspace commit.'));
      await loadList();
      if (data?.job?.id) setSelectedId(data.job.id);
    } catch (followupError) {
      setError(followupError instanceof Error ? followupError.message : 'Builder follow-up could not be created.');
    } finally { setBusy(null); }
  };

  const driveJob = async () => {
    if (!selectedId || busy) return;
    setBusy('drive');
    setError(null);
    setNotice(null);
    try {
      await invoke({ action: 'drive', job_id: selectedId });
      setNotice('Bob is driving this job. He works to the next human gate and reports back; merge and deployment stay with you.');
      await Promise.all([loadList(), loadSnapshot(selectedId)]);
    } catch (driveError) {
      setError(driveError instanceof Error ? driveError.message : 'Bob could not take this job.');
    } finally { setBusy(null); }
  };

  const cancelJob = async () => {
    if (!selectedId || !selectedJob || selectedJob.id !== selectedId || ['deployed', 'failed', 'cancelled'].includes(selectedJob.status) || busy || !cancellationReason.trim()) return;
    const jobId = selectedId;
    const reason = cancellationReason.trim();
    if (!window.confirm(`Cancel Builder job "${selectedJob.title}" (${jobId})? This will stop the job. Select OK to cancel it.`)) return;
    setBusy('cancel');
    setError(null);
    setNotice(null);
    try {
      await invoke({ action: 'cancel', job_id: jobId, reason });
      const refreshedJobs = await loadList();
      if (!refreshedJobs) return;
      if (refreshedJobs.some(job => job.id === jobId) && !await loadSnapshot(jobId)) return;
      setCancellationReason('');
      setNotice('Builder job cancelled.');
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : 'Builder job could not be cancelled.');
    } finally { setBusy(null); }
  };

  const refreshAtlas = async () => {
    setBusy('atlas-refresh');
    setError(null);
    try {
      await invoke({ action: 'refresh_atlas' });
      setNotice('Atlas refreshed from the protected Builder host.');
      if (selectedId) await loadContext(selectedId);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Atlas refresh could not be completed.');
    } finally { setBusy(null); }
  };

  const readArtifactContent = useCallback(async (jobId: string, artifactId: string) => {
    const data = await invoke({ action: 'read_artifact', job_id: jobId, artifact_id: artifactId });
    const content = (data?.artifact as { content?: unknown } | undefined)?.content;
    if (typeof content !== 'string') throw new Error('The plan could not be loaded.');
    return content;
  }, [invoke]);

  const openArtifact = async (artifact: BuilderArtifact) => {
    if (!selectedId || artifactLoading) return;
    setSelectedArtifactId(artifact.id);
    setArtifactLoading(true);
    setError(null);
    try {
      const data = await invoke({ action: 'read_artifact', job_id: selectedId, artifact_id: artifact.id });
      const preview = data?.artifact as { id: string; content: string; checksum: string | null } | undefined;
      if (!preview) throw new Error('Artifact preview could not be loaded.');
      setArtifactContent(preview);
    } catch (artifactError) {
      setArtifactContent(null);
      setError(artifactError instanceof Error ? artifactError.message : 'Artifact preview could not be loaded.');
    } finally {
      setArtifactLoading(false);
    }
  };

  const selectedJob = useMemo(() => snapshot?.job?.id === selectedId ? snapshot.job : jobs.find(job => job.id === selectedId) ?? null, [jobs, selectedId, snapshot]);
  const successorId = selectedJob ? builderSuccessorId(selectedJob) : null;
  const cancelled = selectedJob?.status === 'cancelled';
  const deliveryTruth = selectedJob ? builderDeliveryTruth(selectedJob) : null;
  const nextSafeAction = selectedJob && snapshot ? builderNextAction(selectedJob, snapshot) : 'Select a job or describe new work to Bob Builder.';
  const pendingApprovalCount = snapshot?.approvals.filter(approval => approval.status === 'pending').length ?? 0;
  const failedStepCount = snapshot?.steps.filter(step => step.status === 'failed' || step.status === 'blocked').length ?? 0;

  return (
    <div className={`builder-page ${bobOpen ? 'has-agent-dock' : 'is-agent-hidden'}`}>
      <header className="builder-heading">
        <div><span>Bob build system</span><h1>Builder control room</h1><p>Run governed implementation work to the next evidence or approval boundary.</p></div>
        <div className="builder-heading-actions">
          {onOpenVibe && <button type="button" onClick={onOpenVibe} title="Back to the Vibe Builder chat"><Sparkles size={16} /> Vibe Builder</button>}
          <button type="button" onClick={() => void loadList()} disabled={loading}><RefreshCw size={16} className={loading ? 'is-spinning' : ''} /> Refresh</button>
          <button type="button" onClick={() => { setBobOpen(current => !current); setMobileWorkspaceView('agent'); }} title={bobOpen ? 'Hide the docked Bob Builder agent' : 'Open the docked Bob Builder agent'} aria-pressed={bobOpen}><MessageSquareText size={16} /> {bobOpen ? 'Hide agent' : 'Open agent'}</button>
          <button type="button" className="is-primary" onClick={() => setShowCreate(true)}><Plus size={16} /> New job</button>
        </div>
      </header>

      <ChangeRequestQueue onOpenBob={onOpenBob} />
      <section className="builder-summary" aria-label="Builder summary">
        <div><Workflow size={18} /><span>Jobs</span><strong>{jobs.length}</strong></div>
        <div><Play size={18} /><span>Active</span><strong>{pendingJobs}</strong></div>
        <div><ShieldCheck size={18} /><span>Awaiting humans</span><strong>{approvalJobs}</strong></div>
        <div><FileCode2 size={18} /><span>Projects</span><strong>{projects.length}</strong></div>
      </section>

      {error && <div className="builder-message is-error" role="alert"><AlertTriangle size={17} /><span>{error}</span><button type="button" onClick={() => setError(null)}><X size={15} /></button></div>}
      {notice && <div className="builder-message" role="status"><CheckCircle2 size={17} /><span>{notice}</span><button type="button" onClick={() => setNotice(null)}><X size={15} /></button></div>}

      <nav className="builder-mobile-switcher" aria-label="Builder workspace panels">
        <button type="button" className={mobileWorkspaceView === 'queue' ? 'is-active' : ''} onClick={() => setMobileWorkspaceView('queue')} aria-pressed={mobileWorkspaceView === 'queue'}><Workflow size={15} /> Jobs</button>
        <button type="button" className={mobileWorkspaceView === 'workbench' ? 'is-active' : ''} onClick={() => setMobileWorkspaceView('workbench')} aria-pressed={mobileWorkspaceView === 'workbench'}><FileCode2 size={15} /> Workbench</button>
        <button type="button" className={mobileWorkspaceView === 'agent' ? 'is-active' : ''} onClick={() => { setBobOpen(true); setMobileWorkspaceView('agent'); }} aria-pressed={mobileWorkspaceView === 'agent'}><MessageSquareText size={15} /> Bob Builder</button>
      </nav>

      <div className="builder-layout">
        <section className={`builder-queue ${mobileWorkspaceView === 'queue' ? 'is-mobile-active' : ''}`}>
          <div className="builder-panel-heading"><div><span>Queue</span><h2>Build jobs</h2></div><Bot size={18} /></div>

          <nav className="builder-tabs-nav" aria-label="Job filter tabs">
            <button type="button" className={`builder-tab-btn ${activeTab === 'all' ? 'is-active' : ''}`} onClick={() => setActiveTab('all')}>
              All <span className="builder-tab-count">{jobs.length}</span>
            </button>
            <button type="button" className={`builder-tab-btn ${activeTab === 'issues' ? 'is-active' : ''}`} onClick={() => setActiveTab('issues')} title="Unresolved repair work and errors only">
              Issues <span className="builder-tab-count">{issueJobs}</span>
            </button>
            <button type="button" className={`builder-tab-btn ${activeTab === 'active' ? 'is-active' : ''}`} onClick={() => setActiveTab('active')}>
              Active <span className="builder-tab-count">{pendingJobs}</span>
            </button>
            <button type="button" className={`builder-tab-btn ${activeTab === 'awaiting' ? 'is-active' : ''}`} onClick={() => setActiveTab('awaiting')}>
              Awaiting <span className="builder-tab-count">{approvalJobs}</span>
            </button>
            <button type="button" className={`builder-tab-btn ${activeTab === 'completed' ? 'is-active' : ''}`} onClick={() => setActiveTab('completed')}>
              Completed <span className="builder-tab-count">{completedJobs}</span>
            </button>
            <button type="button" className={`builder-tab-btn ${activeTab === 'failed' ? 'is-active' : ''}`} onClick={() => setActiveTab('failed')}>
              Failed <span className="builder-tab-count">{failedJobs}</span>
            </button>
            <button type="button" className={`builder-tab-btn ${activeTab === 'cancelled' ? 'is-active' : ''}`} onClick={() => setActiveTab('cancelled')}>
              Cancelled <span className="builder-tab-count">{cancelledJobs}</span>
            </button>
          </nav>

          <div className="builder-toolbar">
            <div className="builder-search-box">
              <Search size={14} aria-hidden="true" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Job ID, branch, title, commit or error…"
                aria-label="Filter jobs"
              />
              {searchQuery && (
                <button type="button" className="builder-clear-btn" onClick={() => setSearchQuery('')} aria-label="Clear filter">
                  <X size={12} />
                </button>
              )}
            </div>
            <select
              className="builder-scope-select"
              value={scopeFilter}
              onChange={e => setScopeFilter(e.target.value as ScopeFilter)}
              aria-label="Filter by implementation scope"
            >
              <option value="all">All scopes</option>
              <option value="frontend">Frontend only</option>
              <option value="backend">Backend only</option>
              <option value="fullstack">Fullstack</option>
            </select>
          </div>

          <div className="builder-list-summary">
            Showing {filteredJobs.length} of {jobs.length} jobs
            {searchMatchesElsewhere > 0 && (
              <button type="button" className="builder-search-elsewhere" onClick={() => { setActiveTab('all'); setScopeFilter('all'); }}>
                {searchMatchesElsewhere} more match{searchMatchesElsewhere === 1 ? '' : 'es'} outside this tab · Show all
              </button>
            )}
          </div>

          {loading ? <div className="builder-empty"><RefreshCw size={18} className="is-spinning" /> Loading jobs</div> : filteredJobs.length === 0 ? <div className="builder-empty"><Workflow size={19} /> {jobs.length === 0 ? 'No Builder jobs' : activeTab === 'issues' ? 'No actionable issues' : 'No jobs matching filter'}</div> : (
            <div className="builder-list">{filteredJobs.map(job => {
              const jobIndex = jobs.length - jobs.findIndex(j => j.id === job.id);
              return (
              <button type="button" key={job.id} className={selectedId === job.id ? 'is-selected' : ''} onClick={() => { setSelectedId(job.id); setMobileWorkspaceView('workbench'); }}>
                <span className={`builder-state state-${job.status}`} />
                <div>
                  <strong><span className="builder-job-num">#{jobIndex}</span>{job.title}</strong>
                  <div className="builder-job-tags">
                    {String(job.title).toLowerCase().startsWith('repair') && (
                      <span className="builder-tag tag-self-heal">Self-heal</span>
                    )}
                    {Boolean(job.last_error) && job.status === 'failed' && (
                      <span className="builder-tag tag-issue">Issue</span>
                    )}
                    {job.frontend_required && job.backend_required ? (
                      <span className="builder-tag tag-build">Fullstack</span>
                    ) : job.frontend_required ? (
                      <span className="builder-tag tag-build">Frontend</span>
                    ) : (
                      <span className="builder-tag tag-build">Backend</span>
                    )}
                  </div>
                  <small>{job.current_step_name ?? 'Awaiting first step'}</small>
                </div>
                <div><span>{builderSuccessorId(job) ? 'Continued' : plainWords(job.status, 'Unknown status')}</span><time>{new Date(job.updated_at).toLocaleDateString()}</time></div>
                <ChevronRight size={16} />
              </button>
            );})}</div>
          )}
        </section>

        <section className={`builder-detail ${mobileWorkspaceView === 'workbench' ? 'is-mobile-active' : ''}`}>
          {!selectedJob || !snapshot || snapshot.job.id !== selectedJob.id ? <div className="builder-empty"><FileCode2 size={20} /> Select a job to inspect</div> : <>
            <div className="builder-panel-heading"><div><span>Execution</span><h2>{selectedJob.title}</h2></div><span className={`builder-status state-${selectedJob.status}`}>{successorId ? 'Continued' : plainWords(selectedJob.status, 'Unknown status')}</span></div>
            <div className="builder-job-meta">
              <span>Commit <code>{selectedJob.target_sha.slice(0, 12)}</code></span>
              <span>{selectedJob.workspace_branch ?? 'Workspace not created'}</span>
              <span>{selectedJob.frontend_required ? 'Frontend' : null}{selectedJob.frontend_required && selectedJob.backend_required ? ' + ' : null}{selectedJob.backend_required ? 'Backend' : null}</span>
              <span>Review: {plainWords(selectedJob.code_review_mode)}</span>
              <span>{plainWords(selectedJob.requested_action)} for {plainWords(selectedJob.target_environment)}</span>
              <span>{completedSteps}/{snapshot.steps.length} steps satisfied</span>
            </div>
            {successorId && <div className="builder-notice" role="status">
              <span>This attempt continued as <code>{successorId.slice(0, 8)}</code>. Its outcome is recorded on the newer job.</span>
              <button type="button" onClick={() => { setActiveTab('all'); setScopeFilter('all'); setSearchQuery(''); setSelectedId(successorId); }}>Open newer job</button>
            </div>}
            <BuilderLiveActivity
              job={selectedJob}
              snapshot={snapshot}
              now={now}
              pollState={pollState}
              observedAt={observedAt}
              retryInMs={retryAt ? Math.max(0, retryAt - now) : null}
              changedFiles={changedFiles?.manifestId === latestManifestId ? changedFiles.files : null}
              changedFilesTotal={changedFiles?.total ?? null}
              changedFilesError={changedFiles?.error ?? null}
              telemetryAvailable={snapshot.telemetry ? snapshot.telemetry.model_runs_available && snapshot.telemetry.events_available : true}
            />
            {snapshot && (
              <div className="builder-pipeline-bar" aria-label="Autonomous agent pipeline">
                <span className={`builder-pipeline-node ${snapshot.steps.find(s => s.step_id === 'product_analysis')?.status === 'completed' ? 'is-complete' : selectedJob.current_step_name === 'product_analysis' ? 'is-active' : ''}`}>1. Analyst</span>
                <span className="builder-pipeline-arrow">→</span>
                <span className={`builder-pipeline-node ${snapshot.steps.find(s => s.step_id === 'ui_design')?.status === 'completed' ? 'is-complete' : selectedJob.current_step_name === 'ui_design' ? 'is-active' : ''}`}>2. Design</span>
                <span className="builder-pipeline-arrow">→</span>
                <span className={`builder-pipeline-node ${snapshot.steps.some(s => ['frontend_implementation', 'backend_implementation'].includes(s.step_id) && s.status === 'completed') ? 'is-complete' : ['frontend_implementation', 'backend_implementation'].includes(selectedJob.current_step_name || '') ? 'is-active' : ''}`}>3. Engineer</span>
                <span className="builder-pipeline-arrow">→</span>
                <span className={`builder-pipeline-node ${snapshot.steps.find(s => s.step_id === 'test_suite')?.status === 'completed' ? 'is-complete' : selectedJob.current_step_name === 'test_suite' ? 'is-active' : ''}`}>4. Verify</span>
                <span className="builder-pipeline-arrow">→</span>
                <span className={`builder-pipeline-node ${snapshot.steps.find(s => s.step_id === 'security_review')?.status === 'completed' ? 'is-complete' : selectedJob.current_step_name === 'security_review' ? 'is-active' : ''}`}>5. Security</span>
                <span className="builder-pipeline-arrow">→</span>
                <span className={`builder-pipeline-node ${snapshot.steps.find(s => s.step_id === 'code_review')?.status === 'completed' ? 'is-complete' : selectedJob.current_step_name === 'code_review' ? 'is-active' : ''}`}>6. Review</span>
                <span className="builder-pipeline-arrow">→</span>
                <span className={`builder-pipeline-node ${['release_ready', 'deployed'].includes(selectedJob.status) ? 'is-complete' : selectedJob.current_step_name === 'release_prep' ? 'is-active' : ''}`}>7. Release</span>
              </div>
            )}
            <section className="builder-truth-grid" aria-label="Current build truth">
              <div>
                <span>Current activity</span>
                <strong>{deriveLiveActivity(selectedJob, snapshot, now).stepLabel}</strong>
                <small>{completedSteps}/{snapshot.steps.length} governed steps satisfied</small>
              </div>
              <div className={selectedJob.status !== 'cancelled' && (pendingApprovalCount || failedStepCount || selectedJob.last_error) ? 'is-attention' : ''}>
                <span>Questions and blockers</span>
                <strong>{selectedJob.status === 'cancelled' ? 'Cancelled - no action required' : pendingApprovalCount ? `${pendingApprovalCount} approval${pendingApprovalCount === 1 ? '' : 's'} waiting` : failedStepCount ? `${failedStepCount} blocked step${failedStepCount === 1 ? '' : 's'}` : selectedJob.last_error ? 'Recovery needed' : 'No open blocker'}</strong>
                <small>{selectedJob.status === 'cancelled' ? 'Earlier failures remain in the history; they are not requests to restart this job.' : snapshot.steps.find(step => step.status === 'failed')?.error || selectedJob.last_error || (selectedJob.code_review_status === 'pending' ? 'Code review has not completed; this is not a review finding.' : `Code review: ${plainWords(selectedJob.code_review_status)}`)}</small>
              </div>
              <div className={`is-${deliveryTruth?.tone ?? 'idle'}`}>
                <span>Deployment truth</span>
                <strong>{deliveryTruth?.label}</strong>
                <small>{deliveryTruth?.detail}</small>
              </div>
              <div>
                <span>Next safe action</span>
                <strong>{nextSafeAction}</strong>
                <small>Bob may prepare and verify; protected decisions stay visible here.</small>
              </div>
            </section>
            {selectedJob.last_error && <div className="builder-inline-error"><AlertTriangle size={15} /> {selectedJob.last_error}</div>}
            <section className="builder-workbench" aria-label="Builder job workspace">
              <nav className="builder-workbench-tabs" aria-label="Builder workspace views">
                <button type="button" className={workspaceView === 'task' ? 'is-active' : ''} aria-current={workspaceView === 'task' ? 'page' : undefined} onClick={() => setWorkspaceView('task')}><FileCode2 size={15} /> Plan</button>
                <button type="button" className={workspaceView === 'evidence' ? 'is-active' : ''} aria-current={workspaceView === 'evidence' ? 'page' : undefined} onClick={() => setWorkspaceView('evidence')}><FolderTree size={15} /> Files &amp; changes</button>
                <button type="button" className={workspaceView === 'execution' ? 'is-active' : ''} aria-current={workspaceView === 'execution' ? 'page' : undefined} onClick={() => setWorkspaceView('execution')}><TerminalSquare size={15} /> Terminal &amp; tests</button>
                <button type="button" className={workspaceView === 'context' ? 'is-active' : ''} aria-current={workspaceView === 'context' ? 'page' : undefined} onClick={() => setWorkspaceView('context')}><Database size={15} /> Preview &amp; release</button>
              </nav>
              {workspaceView === 'task' && <div className="builder-workbench-content"><span>Plan and immutable task brief</span><pre>{selectedJob.task_description || 'No task description was retained for this job.'}</pre></div>}
              {workspaceView === 'evidence' && <div className="builder-workbench-content"><span>Verified files, changes, and review artifacts</span>{snapshot.artifacts.length === 0 ? <p>No artifacts have been produced yet.</p> : <><ul className="builder-workbench-artifacts">{snapshot.artifacts.map(artifact => <li key={artifact.id}><button type="button" className={selectedArtifactId === artifact.id ? 'is-selected' : ''} onClick={() => void openArtifact(artifact)} disabled={artifactLoading}><FileCode2 size={15} /><div><strong>{plainWords(artifact.artifact_type)}</strong><small>{artifact.status} · {artifact.content_size_bytes ?? 0} bytes</small></div><code>{artifact.checksum?.slice(0, 12) ?? 'No checksum'}</code></button>{!successorId && !cancelled && selectedJob.workspace_branch && artifact.status === 'final' && artifact.artifact_type === 'code_implementation' && <button type="button" className="builder-commit-patch" onClick={() => void commitVerifiedPatch(artifact)} disabled={Boolean(busy)}>Commit verified patch</button>}</li>)}</ul>{artifactLoading && <p>Loading verified artifact...</p>}{artifactContent && <pre className="builder-artifact-preview" aria-label="Selected artifact content">{artifactContent.content}</pre>}</>}</div>}
              {workspaceView === 'execution' && <div className="builder-workbench-content"><span>Terminal, tests, and durable worker output</span><ol className="builder-workbench-runs">{snapshot.workerRuns.length === 0 ? <li>No worker run has started.</li> : snapshot.workerRuns.map(run => <li key={run.id}><TerminalSquare size={15} /><div><strong>{run.profile}</strong><small>{run.status}{run.exit_code == null ? '' : ` · exit ${run.exit_code}`}</small></div><code>{run.target_sha?.slice(0, 12) ?? 'No commit'}</code></li>)}</ol></div>}
              {workspaceView === 'context' && <div className="builder-workbench-content"><span>Preview, workspace context, and exact release truth</span><p><strong>{deliveryTruth?.label}.</strong> {deliveryTruth?.detail}</p>{selectedJob.workspace_pull_request_url && <p><a href={selectedJob.workspace_pull_request_url} target="_blank" rel="noreferrer noopener">Open the recorded pull request</a></p>}{contextLoading ? <p>Loading Builder context...</p> : !contextSnapshot ? <p>Context is unavailable.</p> : <><p>{contextSnapshot.build_map.file_count} tracked files and {contextSnapshot.build_map.schema.tables.length} schema tables. Atlas has {contextSnapshot.live_context.atlas.capability_count} capabilities and {contextSnapshot.live_context.atlas.edge_count} live edges; {contextSnapshot.live_context.atlas.wired_capability_count} are wired and {contextSnapshot.live_context.atlas.exercised_capability_count} are exercised.</p><ul className="builder-workbench-runs">{contextSnapshot.live_context.live_data.tables.map(row => <li key={row.table}><Database size={15} /><div><strong>{row.table.replaceAll('_', ' ')}</strong><small>Aggregate live row count</small></div><code>{row.available ? row.count ?? 0 : 'Unavailable'}</code></li>)}</ul><button type="button" onClick={() => void refreshAtlas()} disabled={Boolean(busy)}><RefreshCw size={15} className={busy === 'atlas-refresh' ? 'is-spinning' : ''} /> Refresh Atlas</button></>}</div>}
            </section>
            <div className="builder-steps">{snapshot.steps.map(step => (
              <div key={step.id} className={`builder-step state-${step.status}`}>
                <span>{step.ordinal_position}</span>
                <div><strong>{step.step_id.replaceAll('_', ' ')}</strong><small>{step.builder_mode.replaceAll('_', ' ')}</small></div>
                <div><b>{step.status}</b>{step.attempt_count > 0 && <small>{step.attempt_count} attempt{step.attempt_count === 1 ? '' : 's'}</small>}</div>
              </div>
            ))}</div>
            <p className="builder-execution-inputs">Bob finds the source files himself and picks the independent reviewer model. You only decide at the approval gates.</p>
            <div className="builder-evidence"><span>{snapshot.artifacts.length} artifacts</span><span>{snapshot.workerRuns.length} worker runs</span></div>
            {snapshot.approvals.filter(approval => !successorId && !cancelled && approval.status === 'pending').map(approval => {
              const reviewedArtifacts = snapshot.artifacts.filter(artifact => approval.reviewed_artifact_ids.includes(artifact.id));
              const evidenceComplete = approval.reviewed_artifact_ids.length > 0 && reviewedArtifacts.length === approval.reviewed_artifact_ids.length;
              return (
              <section className="builder-approval" key={approval.id}>
                <div><span>Human approval required</span><strong>{approval.approval_type.replaceAll('_', ' ')}</strong><small>Requested for {approval.triggered_at_status.replaceAll('_', ' ')} at commit {approval.requested_target_sha?.slice(0, 12) ?? 'unavailable'}.</small></div>
                <BuilderApprovalBrief jobId={selectedJob.id} approvalType={approval.approval_type} artifacts={[...reviewedArtifacts, ...snapshot.artifacts.filter(artifact => artifact.status === 'final')]} readArtifact={readArtifactContent} />
                <ul className="builder-approval-artifacts" aria-label="Immutable evidence under review">{reviewedArtifacts.map(artifact => <li key={artifact.id}><strong>{artifact.artifact_type.replaceAll('_', ' ')}</strong><span>{artifact.checksum?.slice(0, 12) ?? 'Checksum unavailable'}</span></li>)}{!evidenceComplete && <li className="is-incomplete"><strong>Evidence unavailable</strong><span>Refresh before deciding</span></li>}</ul>
                <label>Note for Bob <small>(optional to approve; required to reject: say what should change)</small><textarea value={approvalComment} onChange={event => setApprovalComment(event.target.value)} rows={3} maxLength={2000} /></label>
                <div><button type="button" className="is-danger" onClick={() => void decideApproval(approval, 'rejected')} disabled={!evidenceComplete || Boolean(busy) || !approvalComment.trim()}>Reject</button><button type="button" className="is-primary" onClick={() => void decideApproval(approval, 'approved')} disabled={!evidenceComplete || Boolean(busy)}>{busy === `approval-${approval.id}` ? 'Recording…' : 'Approve'}</button></div>
              </section>
              );
            })}
            {!successorId && !cancelled && <div className="builder-actions">
              <button type="button" onClick={() => void createWorkspace()} disabled={Boolean(busy) || Boolean(selectedJob.workspace_branch)}><FolderTree size={15} /> {selectedJob.workspace_branch ? 'Workspace ready' : 'Create workspace'}</button>
              <button type="button" onClick={() => void publishWorkspace()} disabled={Boolean(busy) || !selectedJob.workspace_branch || selectedJob.workspace_published_head_sha === selectedJob.workspace_head_sha}><Workflow size={15} /> {selectedJob.workspace_published_head_sha === selectedJob.workspace_head_sha ? 'Published for review' : 'Publish for review'}</button>
              <button type="button" onClick={() => void createPullRequest()} disabled={Boolean(busy) || selectedJob.workspace_published_head_sha !== selectedJob.workspace_head_sha || selectedJob.workspace_pull_request_head_sha === selectedJob.workspace_head_sha}>{selectedJob.workspace_pull_request_head_sha === selectedJob.workspace_head_sha ? 'Pull request ready' : 'Create pull request'}</button>
              {!selectedJob.autopilot_requested_by && !['deployed', 'failed', 'cancelled'].includes(selectedJob.status) && <button type="button" className="is-primary" onClick={() => void driveJob()} disabled={Boolean(busy)}>{busy === 'drive' ? <RefreshCw size={15} className="is-spinning" /> : <Bot size={15} />} Let Bob drive</button>}
              <button type="button" onClick={() => void advance('advance')} disabled={Boolean(busy)}><Play size={15} /> Run next step</button>
              <button type="button" className="is-primary" onClick={() => void advance('run')} disabled={Boolean(busy)}>{busy === 'run' ? <RefreshCw size={15} className="is-spinning" /> : <Workflow size={15} />} Run to gate</button>
            </div>}
            {!successorId && !cancelled && selectedJob.workspace_branch && <section className="builder-followup"><label>Continue on this branch<textarea value={followupTask} onChange={event => setFollowupTask(event.target.value)} rows={3} placeholder="Describe the next change, refinement, or repair for Bob Builder" /></label><button type="button" onClick={() => void createFollowup()} disabled={Boolean(busy) || !followupTask.trim()}><Bot size={15} /> {busy === 'followup' ? 'Starting...' : 'Continue build'}</button></section>}
            {!['deployed', 'failed', 'cancelled'].includes(selectedJob.status) && <section className="builder-followup builder-cancel" aria-label="Cancel Builder job"><label>Cancellation reason<textarea value={cancellationReason} onChange={event => setCancellationReason(event.target.value)} rows={3} required disabled={Boolean(busy)} /></label><button type="button" className="is-danger" onClick={() => void cancelJob()} disabled={Boolean(busy) || !cancellationReason.trim()}><CircleStop size={15} /> {busy === 'cancel' ? 'Cancelling…' : 'Cancel job'}</button></section>}
          </>}
        </section>
        {bobOpen && (
          <aside className={`builder-agent-dock ${mobileWorkspaceView === 'agent' ? 'is-mobile-active' : ''}`} aria-label="Dedicated Bob Builder agent">
            <BobPanel
              open
              presentation="docked"
              onClose={() => { setBobOpen(false); setMobileWorkspaceView(selectedJob ? 'workbench' : 'queue'); }}
              mode="builder"
              context={{
                surface: 'builder_control_room',
                job_id: selectedJob?.id ?? null,
                job_title: selectedJob?.title ?? null,
                target_sha: selectedJob?.target_sha ?? null,
                requested_action: selectedJob?.requested_action ?? null,
                target_environment: selectedJob?.target_environment ?? null,
                job_status: selectedJob?.status ?? null,
                workspace_view: workspaceView,
              }}
            />
          </aside>
        )}
      </div>

      {showCreate && <div className="builder-modal-backdrop" role="presentation"><form className="builder-modal" onSubmit={createJob}>
        <div className="builder-panel-heading"><div><span>New build</span><h2>Create Builder job</h2></div><button type="button" onClick={() => setShowCreate(false)}><X size={16} /></button></div>
        <label>Project<select value={form.projectId} onChange={event => setForm({ ...form, projectId: event.target.value })} required>{projects.map(project => <option value={project.id} key={project.id}>{project.name} · {project.gitea_owner}/{project.gitea_repo}</option>)}</select></label>
        <div className="builder-templates-header"><span>Prompt Starters (Natural Language)</span></div>
        <div className="builder-templates">
          {PROMPT_TEMPLATES.map(tpl => (
            <button
              type="button"
              key={tpl.label}
              className="builder-template-chip"
              onClick={() => applyTemplate(tpl)}
            >
              {tpl.label}
            </button>
          ))}
        </div>
        <label>Title<input value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} maxLength={200} placeholder="e.g. Build feature: Custom report builder" required /></label>
        <label>Task description<textarea value={form.taskDescription} onChange={event => setForm({ ...form, taskDescription: event.target.value })} maxLength={12000} rows={5} placeholder="Describe the desired feature, bug fix, or UI change in plain English..." required /></label>
        <div className="builder-prompt-guide">
          <strong>Natural Language Coding:</strong> Describe what you want in plain English. Bob plans the specification, designs the interface, writes code, verifies in an isolated worker, and runs independent security and code reviews.
        </div>
        <div className="builder-field-row"><label>Branch<input value={form.branchName} onChange={event => setForm({ ...form, branchName: event.target.value })} /></label><label>Target commit SHA<input value={form.targetSha} onChange={event => setForm({ ...form, targetSha: event.target.value })} placeholder="Auto (HEAD of main)" /></label></div>
        <div className="builder-field-row"><label>Requested action<select value={form.requestedAction} onChange={event => setForm({ ...form, requestedAction: event.target.value as RequestedAction })}><option value="prepare_change">Prepare change</option><option value="prepare_release">Prepare release</option></select></label><label>Target environment<select value={form.targetEnvironment} onChange={event => { const targetEnvironment = event.target.value as TargetEnvironment; setForm({ ...form, targetEnvironment, requestedAction: targetEnvironment === 'production' ? 'prepare_release' : form.requestedAction, codeReviewMode: targetEnvironment === 'production' ? 'human' : form.codeReviewMode }); }}><option value="development">Development</option><option value="staging">Staging</option><option value="production">Production</option></select></label></div>
        <fieldset><legend>Implementation scope</legend><label><input type="checkbox" checked={form.frontendRequired} onChange={event => setForm({ ...form, frontendRequired: event.target.checked })} /> Frontend</label><label><input type="checkbox" checked={form.backendRequired} onChange={event => setForm({ ...form, backendRequired: event.target.checked })} /> Backend</label></fieldset>
        <label>Optional code review<select value={form.codeReviewMode} onChange={event => setForm({ ...form, codeReviewMode: event.target.value as ReviewMode })} disabled={form.targetEnvironment === 'production'}><option value="none">None</option><option value="human">Human reviewer</option><option value="independent_ai">Independent AI reviewer</option></select></label>
        <label className="builder-autopilot-option"><input type="checkbox" checked={form.autopilot} onChange={event => setForm({ ...form, autopilot: event.target.checked })} /> Bob drives this job to the next human gate and reports back (merge and deployment stay with you)</label>
        <div className="builder-modal-actions"><button type="button" onClick={() => setShowCreate(false)}>Cancel</button><button type="submit" className="is-primary" disabled={busy === 'create' || projects.length === 0}>{busy === 'create' ? 'Creating…' : 'Create job'}</button></div>
      </form></div>}
    </div>
  );
};

export default BuilderControlRoomPage;
