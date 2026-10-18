import React from 'react';
import { Activity, AlertTriangle, CheckCircle2, Cpu, FileDiff, Hourglass, Loader2, PauseCircle, Radio, ServerCog, WifiOff } from 'lucide-react';
import './BuilderLiveActivity.css';

export type LiveTone = 'working' | 'waiting' | 'stalled' | 'blocked' | 'idle' | 'complete' | 'failed';
export type LivePollState = 'live' | 'paused' | 'retrying' | 'idle';

export interface LiveJob {
  id: string;
  status: string;
  current_step_name: string | null;
  autopilot_state?: string | null;
  autopilot_updated_at?: string | null;
  autopilot_requested_by?: string | null;
  autopilot_report?: Record<string, unknown> | null;
  last_error?: string | null;
  updated_at: string;
}

export interface LiveStep {
  id: string;
  step_id: string;
  ordinal_position: number;
  status: string;
  attempt_count: number;
  started_at?: string | null;
  completed_at?: string | null;
  error?: string | null;
  retryable?: boolean;
}

export interface LiveModelRun {
  id: string;
  step_id: string | null;
  provider: string;
  model_name: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at?: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  turns: number | null;
  phase: string | null;
  failure_kind?: string | null;
  output_validated?: boolean | null;
  output_tokens_per_second?: number | null;
  load_ms?: number | null;
}

export interface LiveWorkerRun {
  id: string;
  profile: string;
  status: string;
  exit_code: number | null;
  started_at?: string | null;
  completed_at?: string | null;
  heartbeat_at?: string | null;
}

export interface LiveEvent {
  id: string;
  event_type: string;
  actor_type: string | null;
  change_summary: string | null;
  detail: { step: string | null; step_status: string | null; status: string | null; artifact_type: string | null; outcome: string | null; retryable: boolean | null; failed_files: string[] };
  created_at: string;
}

export interface LiveChangedFile {
  path: string;
  change: 'added' | 'modified' | 'deleted';
}

export interface LiveSnapshot {
  steps: LiveStep[];
  workerRuns: LiveWorkerRun[];
  modelRuns?: LiveModelRun[];
  events?: LiveEvent[];
  approvals: Array<{ status: string }>;
}

export const STALL_AFTER_MS = 10 * 60 * 1000;
const ACTIVE_RUN = new Set(['pending', 'queued', 'running', 'in_progress', 'started']);
const TERMINAL_JOB = new Set(['release_ready', 'deployed', 'failed', 'cancelled']);

const words = (value: string | null | undefined, fallback = 'Not recorded') => value && value.trim() ? value.replaceAll('_', ' ') : fallback;
const time = (value: string | null | undefined) => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

export function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d`;
}

const ago = (value: string | null | undefined, now: number) => {
  const at = time(value);
  return at == null ? 'never' : `${formatDuration(now - at)} ago`;
};

export function providerLabel(provider: string) {
  if (provider === 'gpu_workstation') return 'Local GPU';
  if (provider === 'ollama') return 'Local Ollama';
  if (provider === 'ollama_cloud') return 'Ollama Cloud';
  if (provider === 'openai') return 'OpenAI (paid)';
  return words(provider, 'Unknown provider');
}

export function modelRunExplanation(run: Pick<LiveModelRun, 'status' | 'failure_kind' | 'output_validated'>) {
  const failures: Record<string, string> = {
    validation: 'Response received, but rejected by validation. Not a connection or billing failure.',
    connection: 'Provider connection failed.',
    timeout: 'No completed response within the time limit.',
    capacity: 'Model excluded by the memory budget.',
    busy: 'Local provider already serving another request; parallel loading avoided.',
    interrupted: 'Run interrupted by a restart or lost worker.',
    evidence: 'Conflicting evidence; corrected intake required.',
    quota: 'Provider reported an account quota or credit error on this run.',
    rate_limit: 'Provider rate limit reached.',
    budget: 'Turn or time allocation exhausted.',
    tool_format: 'Response did not contain a usable tool call.',
  };
  if (run.failure_kind) return failures[run.failure_kind] || 'Failure cause not classified. Inspect the step error.';
  if (run.output_validated === true) return 'Output passed model validation; this is not deployment proof.';
  if (run.status === 'completed') return 'Completed run; validation outcome was not separately recorded.';
  if (['failed', 'timeout'].includes(run.status)) return 'Failure cause not recorded. Inspect the step error.';
  return 'Awaiting the model result.';
}

export function builderSuccessorId(job: LiveJob) {
  const id = job.autopilot_report?.resumed_as_job_id;
  return typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) && id !== job.id ? id : null;
}

export function deriveLiveActivity(job: LiveJob, snapshot: LiveSnapshot, now: number) {
  const steps = [...snapshot.steps].sort((left, right) => left.ordinal_position - right.ordinal_position);
  const modelRuns = snapshot.modelRuns ?? [];
  const events = snapshot.events ?? [];
  const runningStep = steps.find(step => step.status === 'running') ?? null;
  const runningModel = modelRuns.find(run => ACTIVE_RUN.has(run.status) && !run.completed_at) ?? null;
  const runningWorker = snapshot.workerRuns.find(run => ACTIVE_RUN.has(run.status) && !run.completed_at) ?? null;
  const failedStep = steps.find(step => step.status === 'failed') ?? null;
  const modelStep = runningModel?.step_id ? steps.find(step => step.id === runningModel.step_id) : null;
  const currentStep = runningStep ?? modelStep ?? failedStep ?? steps.find(step => step.step_id === job.current_step_name) ?? null;
  const successorId = builderSuccessorId(job);
  const blocker = job.last_error || failedStep?.error;
  const countable = steps.filter(step => step.status !== 'skipped');
  const doneCount = countable.filter(step => step.status === 'completed').length;
  const lastActivity = Math.max(
    ...[job.updated_at, job.autopilot_updated_at, runningStep?.started_at, runningModel?.updated_at, runningModel?.started_at ?? runningModel?.created_at,
      runningWorker?.heartbeat_at ?? runningWorker?.started_at, events[0]?.created_at, modelRuns[0]?.completed_at ?? modelRuns[0]?.created_at]
      .map(time).filter((value): value is number => value != null),
    0,
  );
  const base = {
    stepLabel: words(currentStep?.step_id ?? job.current_step_name, 'Awaiting first step'),
    stepPosition: currentStep ? countable.findIndex(step => step.id === currentStep.id) + 1 : 0,
    stepTotal: countable.length,
    doneCount,
    stepStartedAt: runningStep?.started_at ?? runningModel?.started_at ?? null,
    lastActivityAt: lastActivity ? new Date(lastActivity).toISOString() : null,
    runningModel,
    runningWorker,
  };
  const pendingApprovals = snapshot.approvals.filter(approval => approval.status === 'pending').length;

  if (successorId) return {
    ...base, tone: 'idle' as LiveTone, headline: 'Continued in a newer job',
    detail: `This historical attempt will not resume. Open job ${successorId.slice(0, 8)} to see its current outcome; continuation is not proof of success.`,
  };
  if (job.status === 'deployed') return { ...base, tone: 'complete' as LiveTone, headline: 'Delivered', detail: 'This job has a recorded deployment. Bob is not working on it.' };
  if (job.status === 'release_ready') return { ...base, tone: 'waiting' as LiveTone, headline: 'Ready for your release decision', detail: 'Verification is complete. Merge and Production stay with you.' };
  if (job.status === 'failed') return { ...base, tone: 'failed' as LiveTone, headline: 'Stopped: job failed', detail: blocker || 'Bob is not working on this job. Inspect the blocker or start a follow-up.' };
  if (job.status === 'cancelled') return { ...base, tone: 'idle' as LiveTone, headline: 'Cancelled', detail: 'This job was cancelled. Bob is not working on it.' };
  if (job.autopilot_state === 'done') return { ...base, tone: 'idle' as LiveTone, headline: 'Autopilot stopped on this record', detail: 'No automatic resume is scheduled. Review the recorded outcome before starting another attempt.' };
  if (pendingApprovals || job.autopilot_state === 'awaiting_human') {
    return { ...base, tone: 'waiting' as LiveTone, headline: 'Waiting for you', detail: pendingApprovals ? `${pendingApprovals} approval${pendingApprovals === 1 ? '' : 's'} must be decided before Bob can continue.` : 'Bob reached a human gate and is waiting for your direction.' };
  }
  if (job.autopilot_state === 'blocked') return { ...base, tone: 'blocked' as LiveTone, headline: 'Bob is blocked', detail: blocker || 'Autopilot stopped at a blocker. Review the latest events and ask Bob for the smallest recovery.' };

  const signalOfWork = Boolean(runningStep || runningModel || runningWorker || job.autopilot_state === 'driving');
  if (signalOfWork) {
    const quietFor = lastActivity ? now - lastActivity : Number.POSITIVE_INFINITY;
    if (quietFor > STALL_AFTER_MS) {
      return { ...base, tone: 'stalled' as LiveTone, headline: 'No recorded progress', detail: `Bob was last recorded working ${lastActivity ? formatDuration(quietFor) : 'an unknown time'} ago. He may be stalled; this is not shown as working.` };
    }
    const doing = runningModel ? `${providerLabel(runningModel.provider)} · ${runningModel.model_name}` : runningWorker ? `Worker · ${words(runningWorker.profile)}` : job.autopilot_state === 'driving' ? 'Autopilot is driving' : 'The recorded step is running';
    return { ...base, tone: 'working' as LiveTone, headline: `Working on ${base.stepLabel}`, detail: doing };
  }
  if (failedStep) return { ...base, tone: 'blocked' as LiveTone, headline: `${words(failedStep.step_id)} failed`, detail: blocker || 'No run is active. Review the failed step before retrying.' };
  if (TERMINAL_JOB.has(job.status)) return { ...base, tone: 'idle' as LiveTone, headline: 'Idle', detail: 'Bob is not working on this job.' };
  return {
    ...base, tone: 'idle' as LiveTone, headline: 'Not running',
    detail: 'No active run or driving autopilot is recorded. Review the job outcome before selecting Let Bob drive or running the next step.',
  };
}

export function isLiveJob(job: LiveJob | null, snapshot: LiveSnapshot | null) {
  if (!job || TERMINAL_JOB.has(job.status) || builderSuccessorId(job) || job.autopilot_state === 'done') return false;
  if (job.autopilot_state === 'driving') return true;
  if (!snapshot) return true;
  return snapshot.steps.some(step => step.status === 'running')
    || snapshot.workerRuns.some(run => ACTIVE_RUN.has(run.status) && !run.completed_at)
    || (snapshot.modelRuns ?? []).some(run => ACTIVE_RUN.has(run.status) && !run.completed_at);
}

const TONE_ICON: Record<LiveTone, React.ReactNode> = {
  working: <Loader2 size={16} className="is-spinning" aria-hidden="true" />,
  waiting: <Hourglass size={16} aria-hidden="true" />,
  stalled: <AlertTriangle size={16} aria-hidden="true" />,
  blocked: <AlertTriangle size={16} aria-hidden="true" />,
  idle: <PauseCircle size={16} aria-hidden="true" />,
  complete: <CheckCircle2 size={16} aria-hidden="true" />,
  failed: <AlertTriangle size={16} aria-hidden="true" />,
};

interface Props {
  job: LiveJob;
  snapshot: LiveSnapshot;
  now: number;
  pollState: LivePollState;
  observedAt: string | null;
  retryInMs?: number | null;
  changedFiles: LiveChangedFile[] | null;
  changedFilesTotal?: number | null;
  changedFilesError?: string | null;
  telemetryAvailable?: boolean;
}

export const BuilderLiveActivity: React.FC<Props> = ({ job, snapshot, now, pollState, observedAt, retryInMs, changedFiles, changedFilesTotal, changedFilesError, telemetryAvailable = true }) => {
  const live = deriveLiveActivity(job, snapshot, now);
  const steps = [...snapshot.steps].sort((left, right) => left.ordinal_position - right.ordinal_position);
  const modelRuns = snapshot.modelRuns ?? [];
  const events = (snapshot.events ?? []).slice(0, 8);
  const tokenTotal = modelRuns.reduce((sum, run) => sum + (run.total_tokens ?? 0), 0);
  const localRuns = modelRuns.filter(run => run.provider === 'ollama' || run.provider === 'gpu_workstation').length;
  const cloudRuns = modelRuns.filter(run => run.provider === 'ollama_cloud').length;
  const paidRuns = modelRuns.length - localRuns - cloudRuns;
  const latestModel = modelRuns[0] ?? null;
  const eventFiles = [...new Set((snapshot.events ?? []).flatMap(event => event.detail.failed_files))].slice(0, 12);

  return (
    <section className={`builder-live tone-${live.tone}`} aria-label="Bob live activity">
      <header className="builder-live-head">
        <span className="builder-live-pulse" aria-hidden="true" />
        <div className="builder-live-headline" role="status" aria-live="polite">
          <span>{TONE_ICON[live.tone]} Bob live activity</span>
          <strong>{live.headline}</strong>
          <small>{live.detail}</small>
        </div>
        <div className={`builder-live-poll poll-${pollState}`}>
          {pollState === 'live' && <><Radio size={13} aria-hidden="true" /> Live · updated {ago(observedAt, now)}</>}
          {pollState === 'paused' && <><PauseCircle size={13} aria-hidden="true" /> Paused while this tab is hidden</>}
          {pollState === 'retrying' && <><WifiOff size={13} aria-hidden="true" /> Connection lost{retryInMs ? ` · retrying in ${formatDuration(retryInMs)}` : ''}</>}
          {pollState === 'idle' && <><Activity size={13} aria-hidden="true" /> Not polling · updated {ago(observedAt, now)}</>}
        </div>
      </header>

      <div className="builder-live-progress" aria-label={`Step ${live.stepPosition || '-'} of ${live.stepTotal}: ${live.stepLabel}`}>
        <div className="builder-live-progress-meta">
          <span>{live.stepPosition ? `Step ${live.stepPosition} of ${live.stepTotal}` : `${live.doneCount} of ${live.stepTotal} steps complete`}</span>
          <strong>{live.stepLabel}</strong>
          {live.stepStartedAt && <time dateTime={live.stepStartedAt}>running {formatDuration(now - (time(live.stepStartedAt) ?? now))}</time>}
          {!live.stepStartedAt && live.lastActivityAt && <time dateTime={live.lastActivityAt}>last activity {ago(live.lastActivityAt, now)}</time>}
        </div>
        <ol className="builder-live-track">
          {steps.map(step => (
            <li key={step.id} className={`is-${step.status}`} title={`${words(step.step_id)}: ${words(step.status)}${step.attempt_count > 1 ? ` (${step.attempt_count} attempts)` : ''}`}>
              <span className="sr-only">{words(step.step_id)}: {words(step.status)}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="builder-live-grid">
        <section aria-label="Sub-agents and model runs">
          <h3><Cpu size={14} aria-hidden="true" /> Sub-agents &amp; models</h3>
          {!telemetryAvailable ? <p className="builder-live-empty">Model telemetry is unavailable right now.</p> : modelRuns.length === 0 ? <p className="builder-live-empty">No model run recorded yet.</p> : <>
            <div className="builder-live-stats">
              <span><b>{modelRuns.length}</b> recent runs</span>
              <span><b>{modelRuns.filter(run => run.output_validated === true).length}</b> validation accepted</span>
              <span><b>{modelRuns.filter(run => run.failure_kind === 'validation').length}</b> validation rejected</span>
              <span><b>{localRuns}</b> local</span>
              {cloudRuns > 0 && <span><b>{cloudRuns}</b> Ollama Cloud</span>}
              <span className={paidRuns ? 'is-paid' : ''}><b>{paidRuns}</b> paid</span>
              <span><b>{tokenTotal.toLocaleString()}</b> tokens</span>
            </div>
            <ul className="builder-live-list">
              {modelRuns.slice(0, 5).map(run => (
                <li key={run.id}>
                  <span className={`builder-live-pill pill-${ACTIVE_RUN.has(run.status) && !run.completed_at ? 'running' : run.status}`}>{words(run.status)}</span>
                  <div><strong>{providerLabel(run.provider)}</strong><small>{run.model_name}</small><small className="builder-live-run-detail">{modelRunExplanation(run)}</small>
                    {run.output_tokens_per_second != null && <small className="builder-live-run-detail">{run.output_tokens_per_second.toFixed(1)} output tokens/s{run.load_ms != null ? ` · ${(run.load_ms / 1000).toFixed(1)}s model load` : ''} · generation speed, not task success</small>}
                  </div>
                  <code title="Input / output tokens">{run.total_tokens == null ? 'usage not recorded' : `${(run.input_tokens ?? 0).toLocaleString()} in · ${(run.output_tokens ?? 0).toLocaleString()} out`}</code>
                </li>
              ))}
            </ul>
            <p className="builder-live-note">
              {latestModel?.phase ? `Last recorded model phase: ${words(latestModel.phase)}${latestModel.turns ? ` after ${latestModel.turns} turns` : ''}. ` : ''}
              Bob's reasoning is not streamed; this shows recorded runs and token usage only.
            </p>
          </>}
        </section>

        <section aria-label="Worker runs">
          <h3><ServerCog size={14} aria-hidden="true" /> Workers</h3>
          {snapshot.workerRuns.length === 0 ? <p className="builder-live-empty">No worker has started.</p> : (
            <ul className="builder-live-list">
              {[...snapshot.workerRuns].reverse().slice(0, 4).map(run => {
                const active = ACTIVE_RUN.has(run.status) && !run.completed_at;
                return (
                  <li key={run.id}>
                    <span className={`builder-live-pill pill-${active ? 'running' : run.status}`}>{words(run.status)}</span>
                    <div><strong>{words(run.profile, 'Worker')}</strong><small>{active ? `heartbeat ${ago(run.heartbeat_at ?? run.started_at, now)}` : run.exit_code == null ? 'no exit code' : `exit ${run.exit_code}`}</small></div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-label="Files touched">
          <h3><FileDiff size={14} aria-hidden="true" /> Files touched</h3>
          {changedFilesError ? <p className="builder-live-empty">{changedFilesError}</p> : changedFiles && changedFiles.length > 0 ? <>
            <ul className="builder-live-files">
              {changedFiles.slice(0, 12).map(file => <li key={file.path}><span className={`change-${file.change}`}>{file.change === 'added' ? 'A' : file.change === 'deleted' ? 'D' : 'M'}</span><code>{file.path}</code></li>)}
            </ul>
            <p className="builder-live-note">From the verified changed-file manifest{changedFilesTotal && changedFilesTotal > 12 ? ` · ${changedFilesTotal - 12} more in Files & changes` : ''}.</p>
          </> : eventFiles.length > 0 ? <>
            <ul className="builder-live-files">{eventFiles.map(path => <li key={path}><span className="change-failed">!</span><code>{path}</code></li>)}</ul>
            <p className="builder-live-note">Files named in failed-step events; no verified manifest yet.</p>
          </> : <p className="builder-live-empty">No changed-file manifest recorded yet.</p>}
        </section>
      </div>

      <section className="builder-live-ticker" aria-label="Recent Builder events">
        <h3><Activity size={14} aria-hidden="true" /> Recent events</h3>
        {!telemetryAvailable ? <p className="builder-live-empty">Event history is unavailable right now.</p> : events.length === 0 ? <p className="builder-live-empty">No events recorded yet.</p> : (
          <ol>
            {events.map(event => (
              <li key={event.id}>
                <time dateTime={event.created_at}>{ago(event.created_at, now)}</time>
                <strong>{words(event.event_type)}</strong>
                <span>{[event.detail.step && words(event.detail.step), event.detail.step_status && words(event.detail.step_status), event.detail.artifact_type && words(event.detail.artifact_type), event.detail.outcome && words(event.detail.outcome)].filter(Boolean).join(' · ') || event.change_summary || ''}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
};
