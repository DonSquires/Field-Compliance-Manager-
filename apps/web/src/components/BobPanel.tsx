/**
 * BobPanel.tsx
 *
 * Real Bob AI chat panel. Canonical schema: bob_conversations (one ongoing
 * session per user+org — verified against live production data that
 * module_key is null throughout, i.e. Bob is not scoped per page) +
 * bob_messages (role: user|assistant|system, confidence, flagged). Sends
 * turns to the onspace-ai-chat edge function, which persists both the user
 * and assistant messages itself — this panel does not write assistant
 * replies directly.
 *
 * Bob is confirmed operational in production right now (live conversations
 * observed seconds/minutes old via service-role query). onspace-ai-chat
 * authenticates the CALLING HUMAN via their own Supabase Auth JWT (not
 * Bob's system user, which is a separate identity used for Bob-originated
 * proposals). The app shell supplies a real Supabase Auth session, so the
 * edge function receives the caller's JWT rather than a page-level identity.
 */

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { AlertTriangle, Bot, CheckCircle2, FileSearch, Maximize2, Minimize2, PanelRightClose, Send, ShieldCheck, Sparkles, TerminalSquare, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './BobPanel.css';

interface BobMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  confidence: number | null;
  flagged: boolean;
  created_at: string;
  metadata: Record<string, unknown>;
}

interface BobPanelProps {
  open: boolean;
  onClose: () => void;
  context?: Record<string, unknown>;
  mode?: 'operations' | 'builder';
}

type WorkStateTone = 'idle' | 'drafting' | 'processing' | 'waiting' | 'proposal' | 'completed' | 'failed';

interface WorkState {
  tone: WorkStateTone;
  label: string;
  detail: string;
}

export const BobPanel: React.FC<BobPanelProps> = ({ open, onClose, context, mode = 'operations' }) => {
  const { profile } = useAuth();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<BobMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspaceExpanded, setWorkspaceExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contextEntries = useMemo(() => Object.entries(context ?? {})
    .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
    .slice(0, 4), [context]);
  const workState = derivePanelWorkState({ loading, sending, error, input });

  // ATLAS READS: bob_conversations, bob_messages
  // Operations and Builder retain separate durable threads. Builder context
  // must not pollute operational decisions, and operational history must not
  // be treated as repository/build evidence.
  const loadConversation = useCallback(async () => {
    if (!profile?.organizationId || !profile?.id) return;

    try {
      setLoading(true);
      setError(null);

      const { data: existing, error: findErr } = await supabase
        .from('bob_conversations')
        .select('id')
        .eq('organization_id', profile.organizationId)
        .eq('user_id', profile.id)
        .eq('module_key', mode)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (findErr) throw findErr;

      let convId = existing?.id ?? null;

      if (!convId) {
        // ATLAS WRITES: bob_conversations
        const { data: created, error: createErr } = await supabase
          .from('bob_conversations')
          .insert([{ organization_id: profile.organizationId, user_id: profile.id, module_key: mode, title: mode === 'builder' ? 'Bob Builder' : 'Bob Operations' }])
          .select('id')
          .single();

        if (createErr) throw createErr;
        convId = created.id;
      }

      setConversationId(convId);

      const { data: history, error: historyErr } = await supabase
        .from('bob_messages')
        .select('id, role, content, confidence, flagged, created_at, metadata')
        .eq('conversation_id', convId)
        .order('created_at', { ascending: true });

      if (historyErr) throw historyErr;
      setMessages((history as BobMessage[]) || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Bob conversation');
    } finally {
      setLoading(false);
    }
  }, [mode, profile?.organizationId, profile?.id]);

  useEffect(() => {
    if (open) loadConversation();
  }, [open, loadConversation]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node || typeof node.scrollTo !== 'function') return;
    node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const message = input.trim();
    if (!message || !conversationId) return;

    const optimisticId = `optimistic-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: optimisticId, role: 'user', content: message, confidence: null, flagged: false, created_at: new Date().toISOString(), metadata: {} },
    ]);
    setInput('');
    setSending(true);
    setError(null);

    try {
      // ATLAS CALLS: onspace-ai-chat (persists both user + assistant messages server-side)
      const { data, error: fnError } = await supabase.functions.invoke('onspace-ai-chat', {
        body: {
          message,
          conversation_id: conversationId,
          context: { ...(context ?? {}), agent_mode: mode },
        },
      });

      if (fnError) throw fnError;

      // Refresh from bob_messages so we show the server-persisted, canonical thread
      const { data: history, error: historyErr } = await supabase
        .from('bob_messages')
        .select('id, role, content, confidence, flagged, created_at, metadata')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true });

      if (historyErr) throw historyErr;

      if (history && history.length > 0) {
        setMessages(history as BobMessage[]);
      } else if (data?.reply) {
        // Fallback: function replied but history read didn't return rows yet
        setMessages((prev) => [
          ...prev.filter((m) => m.id !== optimisticId),
          { id: optimisticId, role: 'user', content: message, confidence: null, flagged: false, created_at: new Date().toISOString(), metadata: {} },
          {
            id: `reply-${Date.now()}`,
            role: 'assistant',
            content: String(data.reply),
            confidence: null,
            flagged: false,
            created_at: new Date().toISOString(),
            metadata: {},
          },
        ]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bob could not respond. Try again.');
    } finally {
      setSending(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className={`bob-panel ${workspaceExpanded ? 'is-expanded' : ''}`}
      aria-label="Bob agent workspace"
    >
      <header className="bob-panel-header">
        <div className="bob-panel-identity"><span><Bot size={18} /></span><div><strong>{mode === 'builder' ? 'Bob Builder' : 'Bob Operations'}</strong><small><ShieldCheck size={12} /> Governed session</small></div></div>
        <div className="bob-panel-header-actions">
          <button type="button" onClick={() => setWorkspaceExpanded(current => !current)} title={workspaceExpanded ? 'Use compact panel' : 'Open full workspace'} aria-label={workspaceExpanded ? 'Use compact panel' : 'Open full workspace'}>{workspaceExpanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>
          <button type="button" onClick={onClose} title="Close Bob" aria-label="Close Bob"><PanelRightClose size={18} /></button>
        </div>
      </header>

      {contextEntries.length > 0 && <div className="bob-context" aria-label="Active context"><FileSearch size={15} /><div>{contextEntries.map(([key, value]) => <span key={key}><b>{key.replaceAll('_', ' ')}</b>{String(value)}</span>)}</div></div>}

      <div className={`bob-work-state state-${workState.tone}`} role="status" aria-live="polite"><span>{workState.label}</span><p>{workState.detail}</p></div>

      {error && (
        <div className="bob-panel-error" role="alert"><AlertTriangle size={15} /> {error}</div>
      )}

      <div ref={scrollRef} className="bob-message-stream" aria-live="polite">
        {loading ? (
          <div className="bob-agent-status"><Sparkles size={16} /> Loading conversation</div>
        ) : messages.length === 0 ? (
          <div className="bob-empty-state"><Bot size={24} /><strong>{mode === 'builder' ? 'What should we build?' : 'What should we work through?'}</strong><div>{mode === 'builder' ? <><button type="button" onClick={() => setInput('Inspect the selected Builder job and propose the next implementation step.')}>Inspect job</button><button type="button" onClick={() => setInput('Create an implementation plan with affected files, verification steps, and unknowns.')}>Plan implementation</button><button type="button" onClick={() => setInput('Review the current artifacts and explain the next safe repair or build action.')}>Review evidence</button></> : <><button type="button" onClick={() => setInput('Summarize the current context and identify the next safe action.')}>Summarize context</button><button type="button" onClick={() => setInput('Create a step-by-step plan with unknowns and approval gates.')}>Plan work</button><button type="button" onClick={() => setInput('Check this surface for risks, missing evidence, and tests.')}>Review risk</button></>}</div></div>
        ) : (
          messages.map((m) => (
            <article key={m.id} className={`bob-message role-${m.role}`}>
              {m.role !== 'user' && <span className="bob-message-avatar"><Bot size={14} /></span>}
              <div className="bob-message-body">
                {m.role === 'assistant' && <AgentMetadata message={m} />}
                <div className="bob-message-content">{m.content}</div>
                {m.role === 'assistant' && <OperationalCards message={m} />}
                <footer><time dateTime={m.created_at}>{new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>{m.flagged && <span className="bob-flagged"><AlertTriangle size={12} /> Review required</span>}</footer>
              </div>
            </article>
          ))
        )}
      </div>

      <form onSubmit={handleSend} className="bob-composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={mode === 'builder' ? 'Describe what you want to build, change, or fix' : 'Ask Bob to plan, inspect, explain, or prepare a proposal'}
          disabled={sending || !conversationId}
          rows={3}
        />
        <button
          type="submit"
          disabled={sending || !input.trim() || !conversationId}
          title="Send request to Bob"
        >
          {sending ? <Sparkles size={17} className="is-spinning" /> : <Send size={17} />}
          <span className="sr-only">Send</span>
        </button>
      </form>
    </div>
  );
};

function derivePanelWorkState(input: { loading: boolean; sending: boolean; error: string | null; input: string }): WorkState {
  if (input.error) return { tone: 'failed', label: 'Failed', detail: 'The last operation did not complete. The transcript is still available; retry after checking the message.' };
  if (input.sending) return { tone: 'processing', label: 'Processing', detail: 'Bob is working on the request and may be waiting on live data or tool results.' };
  if (input.loading) return { tone: 'waiting', label: 'Waiting on conversation', detail: 'Loading the durable Bob thread before accepting work.' };
  if (input.input.trim()) return { tone: 'drafting', label: 'Drafting', detail: 'No request has been sent yet. Edit the instruction or send it to start work.' };
  return { tone: 'idle', label: 'Ready', detail: 'No work is running. Ask Bob a question or prepare a governed task.' };
}

function asString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function classifyMessageState(message: BobMessage): WorkState {
  const metadata = message.metadata ?? {};
  const outcome = asString(metadata.outcome);
  const plannedTool = asString(metadata.planned_tool) ?? asString(metadata.tool);
  const suggestedAction = asString(metadata.suggested_action);
  const hasProposal = Boolean(suggestedAction || asString(metadata.action_id) || asString(metadata.org_action_id) || asArray(metadata.site_action_ids).length || asArray(metadata.proposed_entities).length || plannedTool?.startsWith('propose_'));
  const hasEvidence = Boolean(metadata.document_qa || asArray(metadata.reasoning_steps).length || asArray(metadata.files).length || asArray(metadata.sources).length || asArray(metadata.results).length);

  if (message.flagged || outcome === 'error' || outcome === 'failed') return { tone: 'failed', label: 'Failed', detail: 'Bob recorded a failed or flagged operation for review.' };
  if (hasProposal) return { tone: 'proposal', label: 'Proposal prepared', detail: 'Nothing has changed yet. Review the governed action and approve it in the approval surface.' };
  if (outcome === 'need_clarification' || outcome === 'clarifying_questions') return { tone: 'waiting', label: 'Waiting for human input', detail: 'Bob needs a decision or missing detail before work can continue.' };
  if (hasEvidence) return { tone: 'completed', label: 'Evidence reviewed', detail: 'Bob attached structured evidence or reasoning metadata to this turn.' };
  if (plannedTool) return { tone: 'completed', label: 'Completed', detail: `Bob completed ${plannedTool.replaceAll('_', ' ')} for this turn.` };
  return { tone: 'completed', label: 'Answered', detail: 'Bob returned assistant prose only; no governed action was prepared.' };
}

function OperationalCards({ message }: { message: BobMessage }) {
  const metadata = message.metadata ?? {};
  const state = classifyMessageState(message);
  const suggestedAction = asString(metadata.suggested_action);
  const proposalIds = [asString(metadata.action_id), asString(metadata.org_action_id), ...asArray(metadata.site_action_ids).map(asString)].filter(Boolean) as string[];
  const reasoningSteps = asArray(metadata.reasoning_steps);
  const files = asArray(metadata.files);
  const sources = asArray(metadata.sources);
  const results = asArray(metadata.results);
  const evidenceCount = reasoningSteps.length + files.length + sources.length + results.length + (metadata.document_qa ? 1 : 0);

  return (
    <div className="bob-operational-stack" aria-label="Operational state for this Bob response">
      <section className={`bob-operational-card state-${state.tone}`}>
        <span>{state.label}</span>
        <p>{state.detail}</p>
      </section>
      {evidenceCount > 0 && (
        <section className="bob-operational-card is-evidence">
          <span>Evidence</span>
          <p>{evidenceCount} evidence signal{evidenceCount === 1 ? '' : 's'} recorded for this turn.</p>
        </section>
      )}
      {proposalIds.length > 0 && (
        <section className="bob-operational-card is-proposal">
          <span>Governed proposal</span>
          <p>{proposalIds.length} approval item{proposalIds.length === 1 ? '' : 's'} prepared. No live record changes occur until a human approves them.</p>
        </section>
      )}
      {suggestedAction && (
        <section className="bob-operational-card is-primary-action">
          <span>Next action</span>
          <p>{suggestedAction}</p>
        </section>
      )}
    </div>
  );
}

function AgentMetadata({ message }: { message: BobMessage }) {
  const metadata = message.metadata ?? {};
  const plannedTool = typeof metadata.planned_tool === 'string' ? metadata.planned_tool : null;
  const suggestedAction = typeof metadata.suggested_action === 'string' ? metadata.suggested_action : null;
  const confidence = typeof metadata.confidence === 'number' ? metadata.confidence : message.confidence;
  if (!plannedTool && confidence == null) return null;
  return <div className="bob-agent-metadata">{plannedTool && <span><TerminalSquare size={12} /> {plannedTool.replaceAll('_', ' ')}</span>}{confidence != null && <span><CheckCircle2 size={12} /> {Math.round(confidence * 100)}% confidence</span>}</div>;
}

export default BobPanel;
