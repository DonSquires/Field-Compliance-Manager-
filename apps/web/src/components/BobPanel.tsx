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

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';

interface BobMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  confidence: number | null;
  flagged: boolean;
  created_at: string;
}

interface BobPanelProps {
  open: boolean;
  onClose: () => void;
  context?: Record<string, unknown>;
}

export const BobPanel: React.FC<BobPanelProps> = ({ open, onClose, context }) => {
  const { profile } = useAuth();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<BobMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ATLAS READS: bob_conversations, bob_messages
  // Verified against live production data: bob_conversations.module_key is
  // null in every real conversation observed (Bob is one continuous
  // assistant, not scoped per page/module) — so this continues the user's
  // most recent conversation rather than forking a new one per screen.
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
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (findErr) throw findErr;

      let convId = existing?.id ?? null;

      if (!convId) {
        // ATLAS WRITES: bob_conversations
        const { data: created, error: createErr } = await supabase
          .from('bob_conversations')
          .insert([{ organization_id: profile.organizationId, user_id: profile.id }])
          .select('id')
          .single();

        if (createErr) throw createErr;
        convId = created.id;
      }

      setConversationId(convId);

      const { data: history, error: historyErr } = await supabase
        .from('bob_messages')
        .select('id, role, content, confidence, flagged, created_at')
        .eq('conversation_id', convId)
        .order('created_at', { ascending: true });

      if (historyErr) throw historyErr;
      setMessages((history as BobMessage[]) || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Bob conversation');
    } finally {
      setLoading(false);
    }
  }, [profile?.organizationId, profile?.id]);

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
      { id: optimisticId, role: 'user', content: message, confidence: null, flagged: false, created_at: new Date().toISOString() },
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
          context: context ?? {},
        },
      });

      if (fnError) throw fnError;

      // Refresh from bob_messages so we show the server-persisted, canonical thread
      const { data: history, error: historyErr } = await supabase
        .from('bob_messages')
        .select('id, role, content, confidence, flagged, created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true });

      if (historyErr) throw historyErr;

      if (history && history.length > 0) {
        setMessages(history as BobMessage[]);
      } else if (data?.reply) {
        // Fallback: function replied but history read didn't return rows yet
        setMessages((prev) => [
          ...prev.filter((m) => m.id !== optimisticId),
          { id: optimisticId, role: 'user', content: message, confidence: null, flagged: false, created_at: new Date().toISOString() },
          {
            id: `reply-${Date.now()}`,
            role: 'assistant',
            content: String(data.reply),
            confidence: null,
            flagged: false,
            created_at: new Date().toISOString(),
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
      style={{
        position: 'fixed',
        bottom: 0,
        right: 0,
        width: '360px',
        maxWidth: '100vw',
        height: '480px',
        maxHeight: '80vh',
        backgroundColor: 'var(--color-bg-secondary)',
        border: '1px solid var(--color-border)',
        borderRadius: '12px 12px 0 0',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 -4px 24px rgba(0, 0, 0, 0.2)',
        zIndex: 200,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '12px 16px',
          borderBottom: '1px solid var(--color-border)',
        }}
      >
        <strong>🤖 Bob</strong>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px' }}>
          ×
        </button>
      </div>

      {error && (
        <div style={{ padding: '8px 16px', color: '#EF5350', fontSize: '12px' }}>{error}</div>
      )}

      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {loading ? (
          <div style={{ color: 'var(--color-text-secondary)', fontSize: '13px' }}>Loading conversation…</div>
        ) : messages.length === 0 ? (
          <div style={{ color: 'var(--color-text-secondary)', fontSize: '13px' }}>
            Ask Bob about what you're looking at.
          </div>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              style={{
                alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '85%',
                padding: '8px 12px',
                borderRadius: '10px',
                fontSize: '13px',
                backgroundColor: m.role === 'user' ? 'var(--color-primary)' : 'var(--color-bg-primary)',
                color: m.role === 'user' ? 'white' : 'var(--color-text-primary)',
              }}
            >
              {m.content}
              {m.flagged && <div style={{ fontSize: '11px', opacity: 0.8, marginTop: '4px' }}>⚠ flagged for review</div>}
            </div>
          ))
        )}
      </div>

      <form onSubmit={handleSend} style={{ display: 'flex', gap: '8px', padding: '12px', borderTop: '1px solid var(--color-border)' }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message Bob…"
          disabled={sending || !conversationId}
          style={{ flex: 1, padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--color-border)' }}
        />
        <button
          type="submit"
          disabled={sending || !input.trim() || !conversationId}
          style={{
            padding: '8px 16px',
            borderRadius: '6px',
            border: 'none',
            backgroundColor: 'var(--color-primary)',
            color: 'white',
            cursor: sending ? 'not-allowed' : 'pointer',
          }}
        >
          {sending ? '…' : 'Send'}
        </button>
      </form>
    </div>
  );
};

export default BobPanel;
