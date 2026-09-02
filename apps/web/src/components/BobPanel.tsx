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
import { AlertTriangle, Bot, CheckCircle2, FileSearch, PanelRightClose, Send, ShieldCheck, Sparkles, TerminalSquare, X } from 'lucide-react';
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

export const BobPanel: React.FC<BobPanelProps> = ({ open, onClose, context, mode = 'operations' }) => {
  const { profile } = useAuth();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<BobMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contextEntries = useMemo(() => Object.entries(context ?? {})
    .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
    .slice(0, 4), [context]);

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
        .eq('agent_mode', mode)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (findErr) throw findErr;

      let convId = existing?.id ?? null;

      if (!convId) {
        // ATLAS WRITES: bob_conversations
        const { data: created, error: createErr } = await supabase
          .from('bob_conversations')
          .insert([{ organization_id: profile.organizationId, user_id: profile.id, agent_mode: mode, title: mode === 'builder' ? 'Bob Builder' : 'Bob Operations' }])
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
      className="bob-panel"
      aria-label="Bob agent workspace"
    >
      <header className="bob-panel-header">
        <div className="bob-panel-identity"><span><Bot size={18} /></span><div><strong>{mode === 'builder' ? 'Bob Builder' : 'Bob Operations'}</strong><small><ShieldCheck size={12} /> Governed session</small></div></div>
        <button type="button" onClick={onClose} title="Close Bob" aria-label="Close Bob"><PanelRightClose size={18} /></button>
      </header>

      {contextEntries.length > 0 && <div className="bob-context" aria-label="Active context"><FileSearch size={15} /><div>{contextEntries.map(([key, value]) => <span key={key}><b>{key.replaceAll('_', ' ')}</b>{String(value)}</span>)}</div></div>}

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

function AgentMetadata({ message }: { message: BobMessage }) {
  const metadata = message.metadata ?? {};
  const plannedTool = typeof metadata.planned_tool === 'string' ? metadata.planned_tool : null;
  const suggestedAction = typeof metadata.suggested_action === 'string' ? metadata.suggested_action : null;
  const confidence = typeof metadata.confidence === 'number' ? metadata.confidence : message.confidence;
  if (!plannedTool && !suggestedAction && confidence == null) return null;
  return <div className="bob-agent-metadata">{plannedTool && <span><TerminalSquare size={12} /> {plannedTool.replaceAll('_', ' ')}</span>}{confidence != null && <span><CheckCircle2 size={12} /> {Math.round(confidence * 100)}% confidence</span>}{suggestedAction && <span className="bob-suggested-action">{suggestedAction}</span>}</div>;
}

export default BobPanel;
