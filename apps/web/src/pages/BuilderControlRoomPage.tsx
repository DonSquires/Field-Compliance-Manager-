import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Bot, CheckCircle2, ChevronRight, CircleStop, Clock3, Database, FileCode2, FolderTree, MessageSquareText, Play, Plus, RefreshCw, ShieldCheck, TerminalSquare, Workflow, X } from 'lucide-react';
import { BobPanel } from '../components/BobPanel';
import { supabase } from '../lib/supabase';
import './BuilderControlRoomPage.css';

type ReviewMode = 'none' | 'human' | 'independent_ai';
type RequestedAction = 'prepare_change' | 'prepare_release';
type TargetEnvironment = 'development' | 'staging' | 'production';
type WorkspaceView = 'task' | 'evidence' | 'execution' | 'context';

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
}

interface BuilderContextSnapshot {
  build_map: { file_count: number; schema: { tables: string[] } };
  live_context: { atlas: { capability_count: number; edge_count: number; wired_capability_count: number; exercised_capability_count: number; capability_last_refreshed_at: string | null }; live_data: { tables: Array<{ table: string; count: number | null; available: boolean }> } };
}

const plainWords = (value: unknown, fallback = 'Not recorded') => typeof value === 'string' && value.trim() ? value.replaceAll('_', ' ') : fallback;

const BuilderControlRoomPage: React.FC = () => {
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
  const [frontendFiles, setFrontendFiles] = useState('');
  const [backendFiles, setBackendFiles] = useState('');
  const [reviewerModel, setReviewerModel] = useState('');
  const [approvalComment, setApprovalComment] = useState('');
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('task');
  const [bobOpen, setBobOpen] = useState(false);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [artifactContent, setArtifactContent] = useState<{ id: string; content: string; checksum: string | null } | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [followupTask, setFollowupTask] = useState('');
  const [cancellationReason, setCancellationReason] = useState('');
  const [form, setForm] = useState({
    projectId: '', title: '', taskDescription: '', targetSha: '', branchName: 'main',
    frontendRequired: true, backendRequired: false, codeReviewMode: 'human' as ReviewMode,
    requestedAction: 'prepare_change' as RequestedAction, targetEnvironment: 'development' as TargetEnvironment,
  });

  const invoke = useCallback(async (body: Record<string, unknown>) => {
    const { data, error: invokeError } = await supabase.functions.invoke('bob-builder-control-room', { body });
    if (invokeError) {
      const context = invokeError.context;
      if (context instanceof Response) {
        const payload = await context.json().catch(() => null);
        if (payload && typeof payload.error === 'string') {
          throw new Error(typeof payload.detail === 'string' && payload.detail ? `${payload.error}: ${payload.detail}` : payload.error);
        }
      }
      throw invokeError;
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

  const loadSnapshot = useCallback(async (jobId: string) => {
    try {
      const data = await invoke({ action: 'get', job_id: jobId });
      setSnapshot(data as BuilderSnapshot);
      return true;
    } catch (loadError) {
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

  const selectedProject = projects.find(project => project.id === form.projectId) ?? null;
  const pendingJobs = jobs.filter(job => !['release_ready', 'failed', 'cancelled'].includes(job.status)).length;
  const approvalJobs = jobs.filter(job => ['specification_ready', 'approval_pending'].includes(job.status) || job.code_review_status === 'pending').length;
  const completedSteps = snapshot?.steps.filter(step => ['completed', 'skipped'].includes(step.status)).length ?? 0;

  const createJob = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedProject || !form.title.trim() || !form.taskDescription.trim() || !form.targetSha.trim()) return;
    if (!form.frontendRequired && !form.backendRequired) {
      setError('Select at least one implementation scope.');
      return;
    }
    setBusy('create');
    setError(null);
    try {
      const data = await invoke({
        action: 'create', organization_id: selectedProject.organization_id, project_id: selectedProject.id,
        title: form.title.trim(), task_description: form.taskDescription.trim(), target_sha: form.targetSha.trim().toLowerCase(),
        branch_name: form.branchName.trim() || 'main', frontend_required: form.frontendRequired,
        backend_required: form.backendRequired, code_review_mode: form.codeReviewMode,
        requested_action: form.requestedAction, target_environment: form.targetEnvironment,
      });
      setShowCreate(false);
      setNotice('Builder job created at the pinned commit.');
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
      const fileList = (value: string) => value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
      const data = await invoke({
        action,
        job_id: selectedId,
        max_actions: 8,
        frontend_files: fileList(frontendFiles),
        backend_files: fileList(backendFiles),
        reviewer_model_name: reviewerModel.trim() || null,
      });
      setNotice(data?.reason === 'waiting_for_human' ? 'Builder paused at a human approval gate.' : `Builder ${action === 'run' ? 'run' : 'step'} completed.`);
      await Promise.all([loadList(), loadSnapshot(selectedId)]);
    } catch (advanceError) {
      setError(advanceError instanceof Error ? advanceError.message : 'Builder could not advance.');
    } finally {
      setBusy(null);
    }
  };

  const decideApproval = async (approval: BuilderApproval, decision: 'approved' | 'rejected') => {
    if (!selectedId || !approvalComment.trim()) return;
    setBusy(`approval-${approval.id}`);
    setError(null);
    setNotice(null);
    try {
      await invoke({ action: 'decide_approval', job_id: selectedId, approval_id: approval.id, decision, comment: approvalComment.trim() });
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
      const data = await invoke({ action: 'create_followup', job_id: selectedId, title: `Follow-up: ${selectedJob.title}`, task_description: followupTask.trim(), frontend_required: selectedJob.frontend_required, backend_required: selectedJob.backend_required, code_review_mode: selectedJob.code_review_mode });
      setFollowupTask('');
      setNotice('Builder follow-up created from the verified workspace commit.');
      await loadList();
      if (data?.job?.id) setSelectedId(data.job.id);
    } catch (followupError) {
      setError(followupError instanceof Error ? followupError.message : 'Builder follow-up could not be created.');
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

  return (
    <div className="builder-page">
      <header className="builder-heading">
        <div><span>Bob build system</span><h1>Builder control room</h1><p>Run governed implementation work to the next evidence or approval boundary.</p></div>
        <div className="builder-heading-actions">
          <button type="button" onClick={() => void loadList()} disabled={loading}><RefreshCw size={16} className={loading ? 'is-spinning' : ''} /> Refresh</button>
          <button type="button" onClick={() => setBobOpen(true)} title="Ask Bob about the selected Builder job"><MessageSquareText size={16} /> Ask Bob</button>
          <button type="button" className="is-primary" onClick={() => setShowCreate(true)}><Plus size={16} /> New job</button>
        </div>
      </header>

      <section className="builder-summary" aria-label="Builder summary">
        <div><Workflow size={18} /><span>Jobs</span><strong>{jobs.length}</strong></div>
        <div><Play size={18} /><span>Active</span><strong>{pendingJobs}</strong></div>
        <div><ShieldCheck size={18} /><span>Awaiting humans</span><strong>{approvalJobs}</strong></div>
        <div><FileCode2 size={18} /><span>Projects</span><strong>{projects.length}</strong></div>
      </section>

      {error && <div className="builder-message is-error" role="alert"><AlertTriangle size={17} /><span>{error}</span><button type="button" onClick={() => setError(null)}><X size={15} /></button></div>}
      {notice && <div className="builder-message" role="status"><CheckCircle2 size={17} /><span>{notice}</span><button type="button" onClick={() => setNotice(null)}><X size={15} /></button></div>}

      <div className="builder-layout">
        <section className="builder-queue">
          <div className="builder-panel-heading"><div><span>Queue</span><h2>Build jobs</h2></div><Bot size={18} /></div>
          {loading ? <div className="builder-empty"><RefreshCw size={18} className="is-spinning" /> Loading jobs</div> : jobs.length === 0 ? <div className="builder-empty"><Workflow size={19} /> No Builder jobs</div> : (
            <div className="builder-list">{jobs.map(job => (
              <button type="button" key={job.id} className={selectedId === job.id ? 'is-selected' : ''} onClick={() => setSelectedId(job.id)}>
                <span className={`builder-state state-${job.status}`} />
                <div><strong>{job.title}</strong><small>{job.current_step_name ?? 'Awaiting first step'}</small></div>
                <div><span>{plainWords(job.status, 'Unknown status')}</span><time>{new Date(job.updated_at).toLocaleDateString()}</time></div>
                <ChevronRight size={16} />
              </button>
            ))}</div>
          )}
        </section>

        <section className="builder-detail">
          {!selectedJob || !snapshot ? <div className="builder-empty"><FileCode2 size={20} /> Select a job to inspect</div> : <>
            <div className="builder-panel-heading"><div><span>Execution</span><h2>{selectedJob.title}</h2></div><span className={`builder-status state-${selectedJob.status}`}>{plainWords(selectedJob.status, 'Unknown status')}</span></div>
            <div className="builder-job-meta">
              <span>Commit <code>{selectedJob.target_sha.slice(0, 12)}</code></span>
              <span>{selectedJob.workspace_branch ?? 'Workspace not created'}</span>
              <span>{selectedJob.frontend_required ? 'Frontend' : null}{selectedJob.frontend_required && selectedJob.backend_required ? ' + ' : null}{selectedJob.backend_required ? 'Backend' : null}</span>
              <span>Review: {plainWords(selectedJob.code_review_mode)}</span>
              <span>{plainWords(selectedJob.requested_action)} for {plainWords(selectedJob.target_environment)}</span>
              <span>{completedSteps}/{snapshot.steps.length} steps satisfied</span>
            </div>
            {selectedJob.last_error && <div className="builder-inline-error"><AlertTriangle size={15} /> {selectedJob.last_error}</div>}
            <section className="builder-workbench" aria-label="Builder job workspace">
              <nav className="builder-workbench-tabs" aria-label="Builder workspace views">
                <button type="button" className={workspaceView === 'task' ? 'is-active' : ''} aria-current={workspaceView === 'task' ? 'page' : undefined} onClick={() => setWorkspaceView('task')}><FileCode2 size={15} /> Task</button>
                <button type="button" className={workspaceView === 'evidence' ? 'is-active' : ''} aria-current={workspaceView === 'evidence' ? 'page' : undefined} onClick={() => setWorkspaceView('evidence')}><FolderTree size={15} /> Evidence</button>
                <button type="button" className={workspaceView === 'execution' ? 'is-active' : ''} aria-current={workspaceView === 'execution' ? 'page' : undefined} onClick={() => setWorkspaceView('execution')}><TerminalSquare size={15} /> Execution</button>
                <button type="button" className={workspaceView === 'context' ? 'is-active' : ''} aria-current={workspaceView === 'context' ? 'page' : undefined} onClick={() => setWorkspaceView('context')}><Database size={15} /> Context</button>
              </nav>
              {workspaceView === 'task' && <div className="builder-workbench-content"><span>Immutable task brief</span><pre>{selectedJob.task_description || 'No task description was retained for this job.'}</pre></div>}
              {workspaceView === 'evidence' && <div className="builder-workbench-content"><span>Verified artifacts</span>{snapshot.artifacts.length === 0 ? <p>No artifacts have been produced yet.</p> : <><ul className="builder-workbench-artifacts">{snapshot.artifacts.map(artifact => <li key={artifact.id}><button type="button" className={selectedArtifactId === artifact.id ? 'is-selected' : ''} onClick={() => void openArtifact(artifact)} disabled={artifactLoading}><FileCode2 size={15} /><div><strong>{plainWords(artifact.artifact_type)}</strong><small>{artifact.status} · {artifact.content_size_bytes ?? 0} bytes</small></div><code>{artifact.checksum?.slice(0, 12) ?? 'No checksum'}</code></button>{selectedJob.workspace_branch && artifact.status === 'final' && artifact.artifact_type === 'code_implementation' && <button type="button" className="builder-commit-patch" onClick={() => void commitVerifiedPatch(artifact)} disabled={Boolean(busy)}>Commit verified patch</button>}</li>)}</ul>{artifactLoading && <p>Loading verified artifact...</p>}{artifactContent && <pre className="builder-artifact-preview" aria-label="Selected artifact content">{artifactContent.content}</pre>}</>}</div>}
              {workspaceView === 'execution' && <div className="builder-workbench-content"><span>Durable execution timeline</span><ol className="builder-workbench-runs">{snapshot.workerRuns.length === 0 ? <li>No worker run has started.</li> : snapshot.workerRuns.map(run => <li key={run.id}><TerminalSquare size={15} /><div><strong>{run.profile}</strong><small>{run.status}{run.exit_code == null ? '' : ` · exit ${run.exit_code}`}</small></div><code>{run.target_sha?.slice(0, 12) ?? 'No commit'}</code></li>)}</ol></div>}
              {workspaceView === 'context' && <div className="builder-workbench-content"><span>Commit-pinned build and live evidence</span>{contextLoading ? <p>Loading Builder context...</p> : !contextSnapshot ? <p>Context is unavailable.</p> : <><p>{contextSnapshot.build_map.file_count} tracked files and {contextSnapshot.build_map.schema.tables.length} schema tables. Atlas has {contextSnapshot.live_context.atlas.capability_count} capabilities and {contextSnapshot.live_context.atlas.edge_count} live edges; {contextSnapshot.live_context.atlas.wired_capability_count} are wired and {contextSnapshot.live_context.atlas.exercised_capability_count} are exercised.</p><ul className="builder-workbench-runs">{contextSnapshot.live_context.live_data.tables.map(row => <li key={row.table}><Database size={15} /><div><strong>{row.table.replaceAll('_', ' ')}</strong><small>Aggregate live row count</small></div><code>{row.available ? row.count ?? 0 : 'Unavailable'}</code></li>)}</ul><button type="button" onClick={() => void refreshAtlas()} disabled={Boolean(busy)}><RefreshCw size={15} className={busy === 'atlas-refresh' ? 'is-spinning' : ''} /> Refresh Atlas</button></>}</div>}
            </section>
            <div className="builder-steps">{snapshot.steps.map(step => (
              <div key={step.id} className={`builder-step state-${step.status}`}>
                <span>{step.ordinal_position}</span>
                <div><strong>{step.step_id.replaceAll('_', ' ')}</strong><small>{step.builder_mode.replaceAll('_', ' ')}</small></div>
                <div><b>{step.status}</b>{step.attempt_count > 0 && <small>{step.attempt_count} attempt{step.attempt_count === 1 ? '' : 's'}</small>}</div>
              </div>
            ))}</div>
            <div className="builder-execution-inputs">
              {selectedJob.frontend_required && <label>Frontend source files<textarea value={frontendFiles} onChange={event => setFrontendFiles(event.target.value)} rows={3} placeholder="apps/web/src/pages/ExamplePage.tsx" /></label>}
              {selectedJob.backend_required && <label>Backend source files<textarea value={backendFiles} onChange={event => setBackendFiles(event.target.value)} rows={3} placeholder="supabase/functions/example/index.ts" /></label>}
              {selectedJob.code_review_mode === 'independent_ai' && <label>Independent reviewer model<input value={reviewerModel} onChange={event => setReviewerModel(event.target.value)} maxLength={200} placeholder="Configured model identity" /></label>}
            </div>
            <div className="builder-evidence"><span>{snapshot.artifacts.length} artifacts</span><span>{snapshot.workerRuns.length} worker runs</span></div>
            {snapshot.approvals.filter(approval => approval.status === 'pending').map(approval => {
              const reviewedArtifacts = snapshot.artifacts.filter(artifact => approval.reviewed_artifact_ids.includes(artifact.id));
              const evidenceComplete = approval.reviewed_artifact_ids.length > 0 && reviewedArtifacts.length === approval.reviewed_artifact_ids.length;
              return (
              <section className="builder-approval" key={approval.id}>
                <div><span>Human approval required</span><strong>{approval.approval_type.replaceAll('_', ' ')}</strong><small>Requested for {approval.triggered_at_status.replaceAll('_', ' ')} at commit {approval.requested_target_sha?.slice(0, 12) ?? 'unavailable'}.</small></div>
                <ul className="builder-approval-artifacts" aria-label="Immutable evidence under review">{reviewedArtifacts.map(artifact => <li key={artifact.id}><strong>{artifact.artifact_type.replaceAll('_', ' ')}</strong><span>{artifact.checksum?.slice(0, 12) ?? 'Checksum unavailable'}</span></li>)}{!evidenceComplete && <li className="is-incomplete"><strong>Evidence unavailable</strong><span>Refresh before deciding</span></li>}</ul>
                <label>Review rationale<textarea value={approvalComment} onChange={event => setApprovalComment(event.target.value)} rows={3} maxLength={2000} required /></label>
                <div><button type="button" className="is-danger" onClick={() => void decideApproval(approval, 'rejected')} disabled={!evidenceComplete || Boolean(busy) || !approvalComment.trim()}>Reject</button><button type="button" className="is-primary" onClick={() => void decideApproval(approval, 'approved')} disabled={!evidenceComplete || Boolean(busy) || !approvalComment.trim()}>{busy === `approval-${approval.id}` ? 'Recording…' : 'Approve'}</button></div>
              </section>
              );
            })}
            <div className="builder-actions">
              <button type="button" onClick={() => void createWorkspace()} disabled={Boolean(busy) || Boolean(selectedJob.workspace_branch)}><FolderTree size={15} /> {selectedJob.workspace_branch ? 'Workspace ready' : 'Create workspace'}</button>
              <button type="button" onClick={() => void publishWorkspace()} disabled={Boolean(busy) || !selectedJob.workspace_branch || selectedJob.workspace_published_head_sha === selectedJob.workspace_head_sha}><Workflow size={15} /> {selectedJob.workspace_published_head_sha === selectedJob.workspace_head_sha ? 'Published for review' : 'Publish for review'}</button>
              <button type="button" onClick={() => void createPullRequest()} disabled={Boolean(busy) || selectedJob.workspace_published_head_sha !== selectedJob.workspace_head_sha || selectedJob.workspace_pull_request_head_sha === selectedJob.workspace_head_sha}>{selectedJob.workspace_pull_request_head_sha === selectedJob.workspace_head_sha ? 'Pull request ready' : 'Create pull request'}</button>
              <button type="button" onClick={() => void advance('advance')} disabled={Boolean(busy)}><Play size={15} /> Run next step</button>
              <button type="button" className="is-primary" onClick={() => void advance('run')} disabled={Boolean(busy)}>{busy === 'run' ? <RefreshCw size={15} className="is-spinning" /> : <Workflow size={15} />} Run to gate</button>
            </div>
            {selectedJob.workspace_branch && <section className="builder-followup"><label>Continue on this branch<textarea value={followupTask} onChange={event => setFollowupTask(event.target.value)} rows={3} placeholder="Describe the next change, refinement, or repair for Bob Builder" /></label><button type="button" onClick={() => void createFollowup()} disabled={Boolean(busy) || !followupTask.trim()}><Bot size={15} /> {busy === 'followup' ? 'Starting...' : 'Continue build'}</button></section>}
            {!['deployed', 'failed', 'cancelled'].includes(selectedJob.status) && <section className="builder-followup builder-cancel" aria-label="Cancel Builder job"><label>Cancellation reason<textarea value={cancellationReason} onChange={event => setCancellationReason(event.target.value)} rows={3} required disabled={Boolean(busy)} /></label><button type="button" className="is-danger" onClick={() => void cancelJob()} disabled={Boolean(busy) || !cancellationReason.trim()}><CircleStop size={15} /> {busy === 'cancel' ? 'Cancelling…' : 'Cancel job'}</button></section>}
          </>}
        </section>
      </div>

      {showCreate && <div className="builder-modal-backdrop" role="presentation"><form className="builder-modal" onSubmit={createJob}>
        <div className="builder-panel-heading"><div><span>New build</span><h2>Create Builder job</h2></div><button type="button" onClick={() => setShowCreate(false)}><X size={16} /></button></div>
        <label>Project<select value={form.projectId} onChange={event => setForm({ ...form, projectId: event.target.value })} required>{projects.map(project => <option value={project.id} key={project.id}>{project.name} · {project.gitea_owner}/{project.gitea_repo}</option>)}</select></label>
        <label>Title<input value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} maxLength={200} required /></label>
        <label>Task description<textarea value={form.taskDescription} onChange={event => setForm({ ...form, taskDescription: event.target.value })} maxLength={12000} rows={5} required /></label>
        <div className="builder-field-row"><label>Branch<input value={form.branchName} onChange={event => setForm({ ...form, branchName: event.target.value })} /></label><label>Target commit SHA<input value={form.targetSha} onChange={event => setForm({ ...form, targetSha: event.target.value })} pattern="[a-fA-F0-9]{40}" required /></label></div>
        <div className="builder-field-row"><label>Requested action<select value={form.requestedAction} onChange={event => setForm({ ...form, requestedAction: event.target.value as RequestedAction })}><option value="prepare_change">Prepare change</option><option value="prepare_release">Prepare release</option></select></label><label>Target environment<select value={form.targetEnvironment} onChange={event => { const targetEnvironment = event.target.value as TargetEnvironment; setForm({ ...form, targetEnvironment, requestedAction: targetEnvironment === 'production' ? 'prepare_release' : form.requestedAction, codeReviewMode: targetEnvironment === 'production' ? 'human' : form.codeReviewMode }); }}><option value="development">Development</option><option value="staging">Staging</option><option value="production">Production</option></select></label></div>
        <fieldset><legend>Implementation scope</legend><label><input type="checkbox" checked={form.frontendRequired} onChange={event => setForm({ ...form, frontendRequired: event.target.checked })} /> Frontend</label><label><input type="checkbox" checked={form.backendRequired} onChange={event => setForm({ ...form, backendRequired: event.target.checked })} /> Backend</label></fieldset>
        <label>Optional code review<select value={form.codeReviewMode} onChange={event => setForm({ ...form, codeReviewMode: event.target.value as ReviewMode })} disabled={form.targetEnvironment === 'production'}><option value="none">None</option><option value="human">Human reviewer</option><option value="independent_ai">Independent AI reviewer</option></select></label>
        <div className="builder-modal-actions"><button type="button" onClick={() => setShowCreate(false)}>Cancel</button><button type="submit" className="is-primary" disabled={busy === 'create' || projects.length === 0}>{busy === 'create' ? 'Creating…' : 'Create job'}</button></div>
      </form></div>}
      <BobPanel
        open={bobOpen}
        onClose={() => setBobOpen(false)}
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
    </div>
  );
};

export default BuilderControlRoomPage;
