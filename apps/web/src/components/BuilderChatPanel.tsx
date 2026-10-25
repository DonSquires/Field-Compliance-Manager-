import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, CheckCircle2, ChevronDown, ChevronRight, Loader2, Lock, MessageSquarePlus, Send, Wrench, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import './BuilderChatPanel.css';

export interface BuilderChatProposal {
  title: string;
  task_description: string;
  frontend_required: boolean;
  backend_required: boolean;
  rationale?: string;
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
  'What is waiting on me across Builder jobs?',
  'Explain why the selected job is blocked',
  'Propose a job to move the CCTV review page onto the shared dark tokens',
];

function errorText(error: unknown): string {
  const message = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : String(error ?? 'Something went wrong');
  return /platform owner|42501|permission/i.test(message) ? 'Bob Builder chat is limited to the platform owner (grand master).' : message;
}

function requestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
  return { title: raw.title, task_description: raw.task_description, frontend_required: raw.frontend_required === true, backend_required: raw.backend_required === true, rationale: typeof raw.rationale === 'string' ? raw.rationale : undefined };
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
        <span>{steps.length} read-only step{steps.length === 1 ? '' : 's'}</span>
      </button>
      {open && <ol>{steps.map(step => <li key={step.id} className={step.payload.ok === false ? 'is-failed' : undefined}>{step.content}</li>)}</ol>}
    </div>
  );
}

function ProposalCard({ message, onCreate, onOpenJob, busy, settings }: { message: BuilderChatMessage; onCreate: () => void; onOpenJob?: (jobId: string) => void; busy: boolean; settings?: string }) {
  const proposal = proposalFrom(message);
  if (!proposal) return null;
  const jobId = typeof message.payload.job_id === 'string' ? message.payload.job_id : null;
  const scope = [proposal.frontend_required && 'Frontend', proposal.backend_required && 'Backend'].filter(Boolean).join(' + ');
  return (
    <article className="bchat-proposal" aria-label={`Proposed Builder job: ${proposal.title}`}>
      <header><span>Proposed job · {scope}</span><h3>{proposal.title}</h3></header>
      <p className="bchat-proposal__task">{proposal.task_description}</p>
      {proposal.rationale && <p className="bchat-proposal__why">{proposal.rationale}</p>}
      {jobId
        ? <div className="bchat-proposal__done"><CheckCircle2 size={15} /> Job created{onOpenJob && <button type="button" onClick={() => onOpenJob(jobId)}>Open job</button>}</div>
        : <div className="bchat-proposal__actions"><span>{settings ? `Creates with: ${settings}. ` : ''}Nothing runs until you create it.</span><button type="button" onClick={onCreate} disabled={busy}>{busy ? <Loader2 size={14} className="bchat-spin" /> : <Bot size={14} />} Create job</button></div>}
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
    setLoading(true);
    void supabase.from('builder_chat_messages').select(MESSAGE_FIELDS).eq('thread_id', threadId).order('seq', { ascending: true }).limit(400).then(({ data, error: loadError }) => {
      if (cancelled) return;
      setLoading(false);
      if (loadError) setError(errorText(loadError));
      else setMessages((data ?? []) as BuilderChatMessage[]);
    });
    const channel = supabase.channel(`builder-chat-${threadId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'builder_chat_messages', filter: `thread_id=eq.${threadId}` }, change => {
        const row = change.new as BuilderChatMessage | undefined;
        if (!row?.id) return;
        setMessages(current => {
          const index = current.findIndex(message => message.id === row.id);
          if (index === -1) return [...current, row].sort((a, b) => a.seq - b.seq);
          const next = current.slice();
          next[index] = { ...current[index], ...row };
          return next;
        });
      })
      .subscribe();
    return () => { cancelled = true; void supabase.removeChannel(channel); };
  }, [threadId]);

  useEffect(() => { threadEnd.current?.scrollIntoView?.({ block: 'end' }); }, [messages.length]);

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || !threadId || busy) return;
    setBusy('send');
    setError(null);
    try {
      const { error: sendError } = await supabase.rpc('builder_chat_send', { p_thread_id: threadId, p_content: content, p_client_request_id: requestId(), p_context: chatContext(context) });
      if (sendError) throw sendError;
      setDraft('');
    } catch (sendError) {
      setError(errorText(sendError));
    } finally {
      setBusy(null);
    }
  };

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
    try {
      const jobId = await onCreateJob(proposal);
      if (!jobId) throw new Error('The Builder job was not created.');
      const { error: recordError } = await supabase.rpc('builder_chat_record_job', { p_message_id: message.id, p_job_id: jobId });
      if (recordError) throw recordError;
    } catch (createError) {
      setError(errorText(createError));
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
                <p>Ask about jobs, gates, code or the canon. Bob reads the build and can propose a job; you create it.</p>
                <ul>{STARTERS.map(starter => <li key={starter}><button type="button" onClick={() => setDraft(starter)}>{starter}</button></li>)}</ul>
              </div>
            )}
            {items.map(item => item.type === 'steps'
              ? <Steps key={item.key} steps={item.steps} />
              : item.message.kind === 'proposal'
                ? <ProposalCard key={item.message.id} message={item.message} settings={jobSettings} busy={busy === `proposal:${item.message.id}`} onCreate={() => void createFromProposal(item.message)} onOpenJob={onOpenJob} />
                : <div key={item.message.id} className={`bchat-msg bchat-msg--${item.message.role}${item.message.kind === 'error' ? ' is-error' : ''}${item.message.kind === 'status' ? ' is-status' : ''}`}>
                    <p>{item.message.content}</p>
                    {item.message.role === 'owner' && item.message.status === 'failed' && <span className="bchat-msg__meta">Not answered</span>}
                  </div>)}
            {working && <div className="bchat__state" role="status"><Loader2 size={15} className="bchat-spin" /> Bob Builder is working…</div>}
            <div ref={threadEnd} />
          </div>
          {error && <p className="bchat__error" role="alert">{error}</p>}
          <p className="bchat__context">{typeof context.job_title === 'string' && context.job_title ? <>Looking at job: <strong>{context.job_title}</strong></> : 'No job selected · Bob sees the whole Builder queue'}</p>
          <form className="bchat__composer" onSubmit={event => { event.preventDefault(); void send(draft); }}>
            <label htmlFor="bchat-input" className="bchat__sr">Message Bob Builder</label>
            <textarea id="bchat-input" value={draft} onChange={event => setDraft(event.target.value)} rows={3} maxLength={20000} placeholder="Ask Bob Builder about a job, or describe what to build"
              disabled={access !== 'allowed' || !threadId}
              onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(draft); } }} />
            <span className="bchat__hint">Enter to send · Shift+Enter for a new line</span>
            <button type="submit" disabled={access !== 'allowed' || !threadId || !draft.trim() || Boolean(busy)} aria-label="Send to Bob Builder">{busy === 'send' ? <Loader2 size={15} className="bchat-spin" /> : <Send size={15} />}</button>
          </form>
        </>
      )}
    </section>
  );
}
