import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, CheckCircle2, ChevronDown, ChevronRight, Loader2, Lock, MessageSquarePlus, Wrench, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import './BuilderChatPanel.css';
import { BuilderResearchComposer } from './BuilderResearchComposer';

export interface BuilderChatProposal {
  title: string;
  task_description: string;
  frontend_required: boolean;
  backend_required: boolean;
  rationale?: string;
  handoff_kind?: 'investigation';
  source_message_id?: string;
}

export interface BuilderChatMessage {
  id: string;
  seq: number;
  thread_id: string;
  role: 'owner' | 'bob' | 'system' | 'tool';
  kind: 'message' | 'thinking' | 'tool' | 'proposal' | 'error' | 'status';
  content: string;
  payload: Record<string, unknown>;
  status: 'queued' | 'claimed' | 'done' | 'failed' | null;
  created_at: string;
}

interface BuilderChatPanelProps {
  context: Record<string, unknown>;
  onClose?: () => void;
  /** Creates the Builder job through the control room and returns its id. */
  onCreateJob: (proposal: BuilderChatProposal) => Promise<string | null>;
  onOpenJob?: (jobId: string) => void;
  /** Plain-language summary of the settings a confirmed proposal will be created with. */
  jobSettings?: string;
}

type Access = 'checking' | 'allowed' | 'denied';
type ThreadItem = { type: 'message'; message: BuilderChatMessage } | { type: 'steps'; key: string; steps: BuilderChatMessage[] };

const MESSAGE_FIELDS = 'id, seq, thread_id, role, kind, content, payload, status, created_at';
const STARTERS = [
  'How should we investigate an issue before handing it to a builder?',
  'Help me assess the reported blocker in my evidence summary.',
  'Send this reported issue to Bob Builder for investigation and a fix.',
];

function errorText(error: unknown): string {
  const message = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : String(error ?? 'Something went wrong');
  return /platform owner|42501|permission/i.test(message) ? 'Bob Builder chat is limited to the platform owner (grand master).' : message;
}

function requestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function ResearchReceipt({ value }: { value: unknown }) {
  if (!value || typeof value !== 'object' || !('provider' in value) || value.provider !== 'ollama_cloud' || !('sources' in value) || !Array.isArray(value.sources)) return null;
  return <details className="bchat-research-receipt">
    <summary>Research sources and transfer receipt</summary>
    {'purpose' in value && typeof value.purpose === 'string' && <p>Purpose: {value.purpose} · Model: {'model' in value && typeof value.model === 'string' ? value.model : 'not recorded'} · No automatic fallback</p>}
    <p>Only the approved current question/files were eligible. Images use cloud vision; documents use bounded extracted text, never raw document files. Research is advisory, not approval to change the system.</p>
    <ul>{value.sources.map((source: unknown, index: number) => {
      if (!source || typeof source !== 'object') return null;
      const title = 'title' in source && typeof source.title === 'string' ? source.title : `Source ${index + 1}`;
      const url = 'url' in source && typeof source.url === 'string' && /^https:\/\/[^/@?#]+\/[^?#]*$/.test(source.url) ? source.url : null;
      return <li key={index}>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{title}</a> : title}
        {'retrieved_at' in source && typeof source.retrieved_at === 'string' && <small> · Retrieved {source.retrieved_at}</small>}
        {'sha256' in source && typeof source.sha256 === 'string' && <small> · SHA-256 {source.sha256}</small>}
      </li>;
    })}</ul>
  </details>;
}

/** Only short scalar page context travels with a message (the lane caps it at 4 KB). */
export function chatContext(context: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(context)) {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string') out[key] = value.slice(0, 300);
  }
  return out;
}

export function proposalFrom(message: BuilderChatMessage): BuilderChatProposal | null {
  const raw = message.payload.proposal as Partial<BuilderChatProposal> | undefined;
  if (!raw || typeof raw.title !== 'string' || typeof raw.task_description !== 'string') return null;
  return {
    title: raw.title, task_description: raw.task_description, frontend_required: raw.frontend_required === true, backend_required: raw.backend_required === true, rationale: typeof raw.rationale === 'string' ? raw.rationale : undefined,
    ...(raw.handoff_kind === 'investigation' ? { handoff_kind: raw.handoff_kind, source_message_id: typeof raw.source_message_id === 'string' ? raw.source_message_id : undefined } : {}),
  };
}

/**
 * Merges a persisted snapshot into the live list without losing rows that arrived during the fetch:
 * a row updated by Realtime after the snapshot started keeps its live version.
 */
export function mergeSnapshot(current: BuilderChatMessage[], snapshot: BuilderChatMessage[], liveAfterStart: Set<string>): BuilderChatMessage[] {
  const byId = new Map(current.map(message => [message.id, message]));
  for (const row of snapshot) {
    if (liveAfterStart.has(row.id) && byId.has(row.id)) continue;
    byId.set(row.id, row);
  }
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

/** Tool rows between two conversational messages collapse into one steps group; thinking rows are hidden. */
export function groupChat(messages: BuilderChatMessage[]): ThreadItem[] {
  const out: ThreadItem[] = [];
  for (const message of messages) {
    if (message.kind === 'thinking') continue;
    if (message.role === 'tool') {
      const last = out[out.length - 1];
      if (last && last.type === 'steps') last.steps.push(message);
      else out.push({ type: 'steps', key: message.id, steps: [message] });
    } else {
      out.push({ type: 'message', message });
    }
  }
  return out;
}

function Steps({ steps }: { steps: BuilderChatMessage[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bchat-steps">
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<Wrench size={13} />
        <span>{steps.length} step{steps.length === 1 ? '' : 's'}</span>
      </button>
      {open && <ol>{steps.map(step => <li key={step.id} className={step.payload.ok === false ? 'is-failed' : undefined}>{step.content}</li>)}</ol>}
    </div>
  );
}

function RevisionCard({ message, busy, sourceStatus, onRequest, onOpenJob }: {
  message: BuilderChatMessage; busy: boolean; sourceStatus?: BuilderChatMessage['status']; onRequest: () => void; onOpenJob?: (jobId: string) => void;
}) {
  const revision = message.payload.revision;
  if (!revision || typeof revision !== 'object' || !('job_id' in revision) || typeof revision.job_id !== 'string'
      || !('feedback' in revision) || typeof revision.feedback !== 'string') return null;
  const jobId = revision.job_id;
  const implementation = 'kind' in revision && revision.kind === 'implementation';
  const sourceComplete = sourceStatus === 'done';
  const receipt = typeof message.payload.revision_receipt === 'string' ? message.payload.revision_receipt : null;
  return <article className="bchat-proposal" aria-label={`${implementation ? 'Implementation corrections' : 'Specification revision'} for job ${jobId}`}>
    <header><span>Review feedback · existing Bob Builder job</span><h3>{implementation ? 'Correct implementation before a fresh human review' : 'Revise specification before implementation'}</h3></header>
    <p>Job: {jobId}</p>
    <p className="bchat-proposal__task">{revision.feedback}</p>
    {'review_quote' in revision && typeof revision.review_quote === 'string' && <details><summary>Original human review report</summary><p>{revision.review_quote}</p></details>}
    <p>{implementation
      ? 'No duplicate job or specification rewind. Confirmation cancels the old code review and returns this same job to implementation. Prior evidence is retained; verification and security run again before fresh human review. Nothing is approved or deployed.'
      : 'No duplicate job. Confirmation supersedes the current specification review and returns this same job to analysis. No implementation is approved.'}</p>
    {receipt
      ? <div className="bchat-proposal__done"><CheckCircle2 size={15} /><span>Revision requested · Receipt: {receipt}</span>{onOpenJob && <button type="button" onClick={() => onOpenJob(jobId)}>Open job</button>}</div>
      : <><button type="button" disabled={busy || !sourceComplete} onClick={onRequest}>{busy ? 'Recording revision…' : implementation ? 'Request implementation changes' : 'Request specification revision'}</button>
        {!sourceComplete && <p role="status">{sourceStatus === 'failed'
          ? 'The originating PM turn failed. Ask Bob for a fresh revision card before confirming.'
          : 'Waiting for the originating PM turn to complete before confirmation.'}</p>}</>}
  </article>;
}

function ProposalCard({ message, onCreate, onOpenJob, busy, settings, creatingElsewhere }: { message: BuilderChatMessage; onCreate: () => void; onOpenJob?: (jobId: string) => void; busy: boolean; settings?: string; creatingElsewhere: boolean }) {
  const proposal = proposalFrom(message);
  if (!proposal) return null;
  const jobId = typeof message.payload.job_id === 'string' ? message.payload.job_id : null;
  const scope = [proposal.frontend_required && 'Frontend', proposal.backend_required && 'Backend'].filter(Boolean).join(' + ');
  return (
    <article className="bchat-proposal" aria-label={`Proposed Builder job: ${proposal.title}`}>
      <header><span>{proposal.handoff_kind === 'investigation' ? 'Investigation handoff · Bob Builder' : 'Proposed job'} · {scope}</span><h3>{proposal.title}</h3></header>
      {proposal.handoff_kind === 'investigation' && <p>Reported issue, not a verified repair plan. Builder must investigate and pass normal gates before implementing a fix.</p>}
      <p className="bchat-proposal__task">{proposal.task_description}</p>
      {proposal.rationale && <p className="bchat-proposal__why">{proposal.rationale}</p>}
      {jobId
        ? <div className="bchat-proposal__done"><CheckCircle2 size={15} /><span>Job created</span><span>Receipt: {jobId}</span>{onOpenJob && <button type="button" onClick={() => onOpenJob(jobId)}>Open job</button>}</div>
        : <div className="bchat-proposal__actions"><span>{settings ? `Creates with: ${settings}. ` : ''}Nothing runs until you create it.</span><button type="button" onClick={onCreate} disabled={busy || creatingElsewhere} title={creatingElsewhere ? 'This job is being created from another tab or window' : undefined}>{busy || creatingElsewhere ? <Loader2 size={14} className="bchat-spin" /> : <Bot size={14} />} {creatingElsewhere ? 'Creating…' : 'Create job'}</button></div>}
    </article>
  );
}

export function BuilderChatPanel({ context, onClose, onCreateJob, onOpenJob, jobSettings }: BuilderChatPanelProps) {
  const [access, setAccess] = useState<Access>('checking');
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<BuilderChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const threadEnd = useRef<HTMLDivElement | null>(null);
  // Per-tab reservation tokens, so this tab can retry its own create but another tab cannot duplicate it.
  const reservations = useRef(new Map<string, string>());
  const reconcileRef = useRef<(() => Promise<void>) | null>(null);

  const working = messages.some(message => message.role === 'owner' && (message.status === 'queued' || message.status === 'claimed'));
  const items = useMemo(() => groupChat(messages), [messages]);

  const openThread = useCallback(async (fresh: boolean) => {
    if (!fresh) {
      const { data, error: loadError } = await supabase.from('builder_chat_threads').select('id').neq('status', 'closed').order('updated_at', { ascending: false }).limit(1);
      if (loadError) throw loadError;
      if (data?.[0]?.id) return data[0].id as string;
    }
    const { data, error: openError } = await supabase.rpc('builder_chat_thread_open', { p_title: 'Bob Builder chat' });
    if (openError) throw openError;
    return data as string;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error: roleError } = await supabase.rpc('is_grand_master');
      if (cancelled) return;
      if (roleError || data !== true) { setAccess('denied'); setLoading(false); return; }
      setAccess('allowed');
      try {
        const id = await openThread(false);
        if (!cancelled) setThreadId(id);
      } catch (openError) {
        if (!cancelled) { setError(errorText(openError)); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [openThread]);

  useEffect(() => {
    if (!threadId) return undefined;
    let cancelled = false;
    const liveAt = new Map<string, number>();
    let tick = 0;
    setLoading(true);
    setMessages([]);
    // Newest 400 rows (the conversation tail), shown oldest first. Re-run on subscribe and reconnect,
    // because Realtime does not replay rows written while the socket was not listening.
    const reconcile = async () => {
      const started = ++tick;
      const { data, error: loadError } = await supabase.from('builder_chat_messages').select(MESSAGE_FIELDS).eq('thread_id', threadId).order('seq', { ascending: false }).limit(400);
      if (cancelled) return;
      setLoading(false);
      if (loadError) { setError(errorText(loadError)); return; }
      const snapshot = ((data ?? []) as BuilderChatMessage[]).slice().reverse();
      const liveAfterStart = new Set([...liveAt].filter(([, at]) => at > started).map(([id]) => id));
      setMessages(current => mergeSnapshot(current, snapshot, liveAfterStart));
    };
    reconcileRef.current = reconcile;
    void reconcile();
    const channel = supabase.channel(`builder-chat-${threadId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'builder_chat_messages', filter: `thread_id=eq.${threadId}` }, change => {
        const row = change.new as BuilderChatMessage | undefined;
        if (!row?.id) return;
        liveAt.set(row.id, ++tick);
        setMessages(current => {
          const index = current.findIndex(message => message.id === row.id);
          if (index === -1) return [...current, row].sort((a, b) => a.seq - b.seq);
          const next = current.slice();
          next[index] = { ...current[index], ...row };
          return next;
        });
      })
      .subscribe((status: string) => { if (status === 'SUBSCRIBED' && !cancelled) void reconcile(); });
    return () => { cancelled = true; reconcileRef.current = null; void supabase.removeChannel(channel); };
  }, [threadId]);

  // Safety net while a turn is in flight: a dropped Realtime event must not leave the panel stuck.
  useEffect(() => {
    if (!working) return undefined;
    const timer = window.setInterval(() => { void reconcileRef.current?.(); }, 8000);
    return () => window.clearInterval(timer);
  }, [working]);

  useEffect(() => { threadEnd.current?.scrollIntoView?.({ block: 'end' }); }, [messages.length]);

  const newChat = async () => {
    if (busy) return;
    setBusy('new');
    setError(null);
    try {
      if (threadId) {
        const { error: closeError } = await supabase.rpc('builder_chat_thread_close', { p_thread_id: threadId });
        if (closeError) throw closeError;
      }
      setMessages([]);
      setThreadId(await openThread(true));
    } catch (newError) {
      setError(errorText(newError));
    } finally {
      setBusy(null);
    }
  };

  const createFromProposal = async (message: BuilderChatMessage) => {
    const proposal = proposalFrom(message);
    if (!proposal || busy) return;
    setBusy(`proposal:${message.id}`);
    setError(null);
    const token = reservations.current.get(message.id) ?? requestId();
    reservations.current.set(message.id, token);
    let jobId: string | null = null;
    try {
      const { data: reserved, error: reserveError } = await supabase.rpc('builder_chat_reserve_proposal', { p_message_id: message.id, p_token: token });
      if (reserveError) throw reserveError;
      if (reserved !== true) throw new Error('This proposal is already being created from another tab or window, or was already created.');
      jobId = await onCreateJob(proposal);
      if (!jobId) throw new Error('The Builder job was not created.');
      const { error: recordError } = await supabase.rpc('builder_chat_record_job', { p_message_id: message.id, p_job_id: jobId });
      if (recordError) throw recordError;
      reservations.current.delete(message.id);
    } catch (createError) {
      // Release only when no job exists; once created, keep the reservation so a retry links the same job.
      if (!jobId) await supabase.rpc('builder_chat_release_proposal', { p_message_id: message.id, p_token: token });
      setError(errorText(createError));
    } finally {
      setBusy(null);
    }
  };

  const requestRevision = async (message: BuilderChatMessage) => {
    if (busy) return;
    setBusy(`revision:${message.id}`);
    setError(null);
    try {
      const revision = message.payload.revision;
      const implementation = revision && typeof revision === 'object' && 'kind' in revision && revision.kind === 'implementation';
      const { data, error: revisionError } = await supabase.rpc(implementation ? 'builder_chat_request_code_changes' : 'builder_chat_request_spec_revision', { p_message_id: message.id });
      if (revisionError) throw revisionError;
      if (typeof data !== 'string' || !data) throw new Error('Review feedback was not confirmed; refresh before retrying.');
      setMessages(current => current.map(row => row.id === message.id ? { ...row, payload: { ...row.payload, revision_receipt: data } } : row));
    } catch (revisionError) {
      setError(errorText(revisionError));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="bchat" aria-label="Bob Builder chat">
      <header className="bchat__head">
        <div>
          <h2><Bot size={16} /> Bob Builder</h2>
          <p>Build lane chat · separate from in-app Bob</p>
        </div>
        <div className="bchat__head-actions">
          <button type="button" onClick={() => void newChat()} disabled={access !== 'allowed' || Boolean(busy) || working} title="Start a new Builder chat"><MessageSquarePlus size={15} /><span>New</span></button>
          {onClose && <button type="button" onClick={onClose} aria-label="Close Bob Builder chat"><X size={15} /></button>}
        </div>
      </header>

      {access === 'denied' ? (
        <div className="bchat__state" role="status"><Lock size={18} /><p>Bob Builder chat is limited to the platform owner (grand master).</p></div>
      ) : (
        <>
          <div className="bchat__thread" aria-live="polite" aria-busy={loading || working}>
            {(access === 'checking' || loading) && <div className="bchat__state" role="status"><Loader2 size={16} className="bchat-spin" /> Loading Builder chat…</div>}
            {!loading && access === 'allowed' && items.length === 0 && (
              <div className="bchat__empty">
                <p>Bob is your technical PM and QA lead. He can assess your report and prepare a Bob Builder investigation handoff for you to confirm here. Builder investigates and implements through its normal gates; Vibe dispatch and automatic private collection are not connected here. Private history and selected-job context are not sent to cloud.</p>
                <ul>{STARTERS.map(starter => <li key={starter}><button type="button" onClick={() => setDraft(starter)}>{starter}</button></li>)}</ul>
              </div>
            )}
            {items.map(item => item.type === 'steps'
              ? <Steps key={item.key} steps={item.steps} />
              : item.message.kind === 'proposal' && item.message.payload.revision
                ? <RevisionCard key={item.message.id} message={item.message} busy={Boolean(busy)}
                  sourceStatus={messages.find(row => row.id === item.message.payload.message_id && row.role === 'owner')?.status}
                  onRequest={() => void requestRevision(item.message)} onOpenJob={onOpenJob} />
              : item.message.kind === 'proposal'
                ? <ProposalCard key={item.message.id} message={item.message} settings={jobSettings} busy={busy === `proposal:${item.message.id}`}
                  creatingElsewhere={typeof item.message.payload.creating_token === 'string' && item.message.payload.creating_token !== reservations.current.get(item.message.id) && Date.now() - Date.parse(String(item.message.payload.creating_at ?? '')) < 5 * 60_000} onCreate={() => void createFromProposal(item.message)} onOpenJob={onOpenJob} />
                : <div key={item.message.id} className={`bchat-msg bchat-msg--${item.message.role}${item.message.kind === 'error' ? ' is-error' : ''}${item.message.kind === 'status' ? ' is-status' : ''}`}>
                    <p>{item.message.content}</p>
                    {item.message.payload.research_mode === 'public_cloud' && <small>Owner-approved public cloud research · previous chat excluded</small>}
                    <ResearchReceipt value={item.message.payload.research} />
                    {item.message.role === 'owner' && item.message.status === 'failed' && <span className="bchat-msg__meta">Not answered</span>}
                  </div>)}
            {working && <div className="bchat__state" role="status"><Loader2 size={15} className="bchat-spin" /> Bob Builder is working…</div>}
            <div ref={threadEnd} />
          </div>
          {error && <p className="bchat__error" role="alert">{error}</p>}
          <p className="bchat__context">{typeof context.job_title === 'string' && context.job_title ? <>Selected job (not transferred): <strong>{context.job_title}</strong></> : 'No job selected · cloud PM receives only your approved packet'}</p>
          <form className="bchat__composer" onSubmit={event => event.preventDefault()}>
            <label htmlFor="bchat-input" className="bchat__sr">Message Bob Builder</label>
            <textarea id="bchat-input" value={draft} onChange={event => setDraft(event.target.value)} rows={3} maxLength={2000} placeholder="Ask your PM a question, or describe the issue to investigate"
              disabled={access !== 'allowed' || !threadId || Boolean(busy)} />
            {threadId && <BuilderResearchComposer key={threadId} pmMode threadId={threadId} question={draft} disabled={access !== 'allowed' || Boolean(busy) || working} onSent={() => setDraft('')} onError={message => setError(message || null)} onBusy={value => setBusy(value ? 'research' : null)} />}
            <span className="bchat__hint">Review the packet and approve cloud transfer before sending · Enter adds a new line</span>
          </form>
        </>
      )}
    </section>
  );
}
