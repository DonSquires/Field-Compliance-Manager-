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
import { AlertTriangle, Archive, ArchiveRestore, Bot, CheckCircle2, Clock3, FileSearch, FileUp, ListChecks, Maximize2, Mic, Minimize2, Paperclip, PanelLeft, PanelRight, PanelRightClose, Pencil, Pin, PinOff, Plus, Search, Send, ShieldCheck, Sparkles, TerminalSquare, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { BobMarkdown } from './BobMarkdown';
import './BobPanel.css';

const MAX_BOB_UPLOAD_BYTES = 48 * 1024 * 1024;
const ACCEPTED_BOB_UPLOADS = 'image/*,video/*,audio/*,.csv,.txt,.pdf,.doc,.docx,.xls,.xlsx,.json,.md';
const ACCEPTED_BOB_UPLOAD_LABEL = 'PDF, DOCX, CSV/XLSX, TXT, JSON, images, audio, and video up to 48 MB each';

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

interface PendingBobFile {
  id: string;
  file: File;
  status: 'queued' | 'uploading' | 'uploaded' | 'failed';
  error?: string;
  attachment?: BobAttachmentPayload;
}

interface BobAttachmentPayload {
  id: string;
  name: string;
  type: string;
  storage_bucket: string;
  storage_path: string;
}

interface BobAttachmentRecord {
  id: string;
  file_name: string;
  file_type: string;
  file_size_bytes: number;
  processing_state: 'pending' | 'processing' | 'extracted' | 'failed' | 'manual_review_required' | string;
  extraction_summary: string | null;
  confidence: number | null;
  created_at: string;
}

interface BobSessionSummary {
  id: string;
  title: string | null;
  pinned: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

type ContextTab = 'context' | 'files' | 'actions' | 'audit';
type SessionFilter = 'all' | 'pinned' | 'archived';
type SearchScope = 'chats' | 'files' | 'actions';

interface GlobalSearchResult {
  id: string;
  type: 'file' | 'action';
  title: string;
  detail: string;
  conversationId: string | null;
}

type WorkStateTone = 'idle' | 'working' | 'using-data' | 'waiting' | 'proposal' | 'completed' | 'failed';
type VoiceState = 'off' | 'recording';

interface WorkState {
  tone: WorkStateTone;
  label: string;
  detail: string;
}

type ActivityPhase = 'idle' | 'preparing' | 'uploading' | 'waiting' | 'refreshing' | 'recording';

export const BobPanel: React.FC<BobPanelProps> = ({ open, onClose, context, mode = 'operations' }) => {
  const { profile } = useAuth();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<BobMessage[]>([]);
  const [input, setInput] = useState('');
  const [pendingFiles, setPendingFiles] = useState<PendingBobFile[]>([]);
  const [attachments, setAttachments] = useState<BobAttachmentRecord[]>([]);
  const [sessions, setSessions] = useState<BobSessionSummary[]>([]);
  const [sessionSearch, setSessionSearch] = useState('');
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>('all');
  const [searchScope, setSearchScope] = useState<SearchScope>('chats');
  const [globalResults, setGlobalResults] = useState<GlobalSearchResult[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // Side panes are drawers on narrow screens, so they start closed there.
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window === 'undefined' ? true : window.innerWidth >= 1100);
  const [contextPanelOpen, setContextPanelOpen] = useState(() => typeof window === 'undefined' ? true : window.innerWidth >= 1100);
  const [sidebarWidth, setSidebarWidth] = useState(296);
  const [contextPanelWidth, setContextPanelWidth] = useState(344);
  const [contextTab, setContextTab] = useState<ContextTab>('context');
  const [activityPhase, setActivityPhase] = useState<ActivityPhase>('idle');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>('off');
  const [error, setError] = useState<string | null>(null);
  const [workspaceExpanded, setWorkspaceExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const contextEntries = useMemo(() => Object.entries(context ?? {})
    .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
    .slice(0, 4), [context]);
  const workState = derivePanelWorkState({ loading, sending, error, input, messages, pendingFiles, attachments });

  const loadAttachments = useCallback(async (convId: string) => {
    const { data, error: attachmentErr } = await supabase
      .from('bob_attachments')
      .select('id, file_name, file_type, file_size_bytes, processing_state, extraction_summary, confidence, created_at')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: true });

    if (attachmentErr) throw attachmentErr;
    setAttachments((data as BobAttachmentRecord[]) ?? []);
  }, []);

  const loadSessions = useCallback(async () => {
    if (!profile?.organizationId || !profile?.id) return;
    const { data, error: sessionErr } = await supabase
      .from('bob_conversations')
      .select('id, title, pinned, archived_at, created_at, updated_at')
      .eq('organization_id', profile.organizationId)
      .eq('user_id', profile.id)
      .eq('module_key', mode)
      .order('updated_at', { ascending: false })
      .limit(100);

    if (sessionErr) throw sessionErr;
    setSessions((data as BobSessionSummary[]) ?? []);
  }, [mode, profile?.organizationId, profile?.id]);

  const selectSession = useCallback(async (convId: string) => {
    try {
      setLoading(true);
      setActivityPhase('refreshing');
      setError(null);
      setConversationId(convId);
      setPendingFiles([]);

      const { data: history, error: historyErr } = await supabase
        .from('bob_messages')
        .select('id, role, content, confidence, flagged, created_at, metadata')
        .eq('conversation_id', convId)
        .order('created_at', { ascending: true });

      if (historyErr) throw historyErr;
      setMessages((history as BobMessage[]) || []);
      await loadAttachments(convId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That Bob session could not be opened.');
    } finally {
      setActivityPhase('idle');
      setLoading(false);
    }
  }, [loadAttachments]);

  const renameSession = useCallback(async (convId: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setSessions(current => current.map(item => item.id === convId ? { ...item, title: trimmed } : item));
    const { error: renameErr } = await supabase.from('bob_conversations').update({ title: trimmed }).eq('id', convId);
    if (renameErr) setError(renameErr.message);
  }, []);

  const searchWorkspace = useCallback(async (value: string, scope: SearchScope) => {
    setSessionSearch(value);
    if (scope === 'chats' || value.trim().length < 2 || !profile?.organizationId) {
      setGlobalResults([]);
      return;
    }
    const pattern = `%${value.trim().replace(/[%_,]/g, '')}%`;
    if (scope === 'files') {
      const { data, error: searchErr } = await supabase
        .from('bob_attachments')
        .select('id, file_name, processing_state, conversation_id')
        .eq('organization_id', profile.organizationId)
        .ilike('file_name', pattern)
        .order('created_at', { ascending: false })
        .limit(30);
      if (searchErr) {
        setError(searchErr.message);
        return;
      }
      setGlobalResults((data ?? []).map((item: { id: string; file_name: string; processing_state: string; conversation_id: string | null }) => ({ id: item.id, type: 'file', title: item.file_name, detail: attachmentStateLabel(item.processing_state), conversationId: item.conversation_id })));
      return;
    }
    const { data, error: searchErr } = await supabase
      .from('bob_agentic_actions')
      .select('id, action_type, status, context_summary, conversation_id')
      .eq('organization_id', profile.organizationId)
      .or(`action_type.ilike.${pattern},context_summary.ilike.${pattern}`)
      .order('created_at', { ascending: false })
      .limit(30);
    if (searchErr) {
      setError(searchErr.message);
      return;
    }
    setGlobalResults((data ?? []).map((item: { id: string; action_type: string; status: string; context_summary: string | null; conversation_id: string | null }) => ({ id: item.id, type: 'action', title: item.action_type.replaceAll('_', ' '), detail: item.context_summary || item.status, conversationId: item.conversation_id })));
  }, [profile?.organizationId]);

  const updateSession = useCallback(async (convId: string, patch: Partial<Pick<BobSessionSummary, 'pinned' | 'archived_at'>>) => {
    const previous = sessions;
    setSessions(current => current.map(item => item.id === convId ? { ...item, ...patch } : item));
    const { error: updateErr } = await supabase.from('bob_conversations').update(patch).eq('id', convId);
    if (updateErr) {
      setSessions(previous);
      setError(updateErr.message);
    }
  }, [sessions]);

  const beginPaneResize = (side: 'left' | 'right', event: React.PointerEvent<HTMLDivElement>) => {
    if (!workspaceExpanded || window.innerWidth < 1100) return;
    event.preventDefault();
    const move = (pointerEvent: PointerEvent) => {
      const clientX = Number(pointerEvent.clientX);
      if (!Number.isFinite(clientX)) return;
      if (side === 'left') setSidebarWidth(Math.min(420, Math.max(240, clientX - 18)));
      else setContextPanelWidth(Math.min(460, Math.max(280, window.innerWidth - clientX - 18)));
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
  };

  // ATLAS READS: bob_conversations, bob_messages
  // Operations and Builder retain separate durable threads. Builder context
  // must not pollute operational decisions, and operational history must not
  // be treated as repository/build evidence.
  const loadConversation = useCallback(async () => {
    if (!profile?.organizationId || !profile?.id) return;

    try {
      setLoading(true);
      setActivityPhase('refreshing');
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
      await loadAttachments(convId);
      await loadSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Bob conversation');
    } finally {
      setActivityPhase('idle');
      setLoading(false);
    }
  }, [mode, profile?.organizationId, profile?.id, loadAttachments, loadSessions]);

  useEffect(() => {
    if (open) loadConversation();
  }, [open, loadConversation]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node || typeof node.scrollTo !== 'function') return;
    node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  useEffect(() => () => {
    mediaRecorderRef.current?.state === 'recording' && mediaRecorderRef.current.stop();
    mediaStreamRef.current?.getTracks().forEach(track => track.stop());
  }, []);

  const startNewConversation = useCallback(async () => {
    if (!profile?.organizationId || !profile?.id) return;
    try {
      setLoading(true);
      setActivityPhase('preparing');
      setError(null);
      const { data: created, error: createErr } = await supabase
        .from('bob_conversations')
        .insert([{ organization_id: profile.organizationId, user_id: profile.id, module_key: mode, title: mode === 'builder' ? 'Bob Builder' : 'Bob Operations' }])
        .select('id')
        .single();
      if (createErr) throw createErr;
      setConversationId(created.id);
      setMessages([]);
      setPendingFiles([]);
      setAttachments([]);
      await loadSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'New Bob conversation could not be created.');
    } finally {
      setActivityPhase('idle');
      setLoading(false);
    }
  }, [mode, profile?.organizationId, profile?.id, loadSessions]);

  const addFiles = (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    const rejected = files.filter(file => file.size <= 0 || file.size > MAX_BOB_UPLOAD_BYTES);
    const accepted = files.filter(file => file.size > 0 && file.size <= MAX_BOB_UPLOAD_BYTES).map(file => ({
      id: `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`,
      file,
      status: 'queued' as const,
    }));
    if (rejected.length) setError('One or more files are empty or larger than the 48 MB upload limit.');
    setPendingFiles(current => [...current, ...accepted].slice(0, 8));
  };

  const uploadPendingFiles = async (convId: string) => {
    if (!profile?.organizationId || !profile?.id) return [];
    const uploaded: BobAttachmentPayload[] = [];
    for (const pending of pendingFiles) {
      if (pending.attachment) {
        uploaded.push(pending.attachment);
        continue;
      }
      setActivityPhase('uploading');
      setPendingFiles(current => current.map(item => item.id === pending.id ? { ...item, status: 'uploading' } : item));
      const safeName = pending.file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-180) || 'upload.bin';
      const attachmentId = crypto.randomUUID();
      const storagePath = `org/${profile.organizationId}/bob/${convId}/${attachmentId}-${safeName}`;
      const { error: uploadError } = await supabase.storage.from('bob-uploads').upload(storagePath, pending.file, {
        contentType: pending.file.type || 'application/octet-stream',
        upsert: false,
      });
      if (uploadError) {
        setPendingFiles(current => current.map(item => item.id === pending.id ? { ...item, status: 'failed', error: uploadError.message } : item));
        throw uploadError;
      }
      const { error: metadataError } = await supabase.from('bob_attachments').insert([{
        id: attachmentId,
        organization_id: profile.organizationId,
        conversation_id: convId,
        uploaded_by: profile.id,
        file_name: pending.file.name,
        file_type: pending.file.type || 'application/octet-stream',
        file_size_bytes: pending.file.size,
        storage_bucket: 'bob-uploads',
        storage_path: storagePath,
        purpose: pending.file.type.startsWith('image/') ? 'photo_intake' : 'document_intake',
        processing_state: 'pending',
      }]);
      if (metadataError) {
        await supabase.storage.from('bob-uploads').remove([storagePath]);
        setPendingFiles(current => current.map(item => item.id === pending.id ? { ...item, status: 'failed', error: metadataError.message } : item));
        throw metadataError;
      }
      const attachment = { id: attachmentId, name: pending.file.name, type: pending.file.type || 'application/octet-stream', storage_bucket: 'bob-uploads', storage_path: storagePath };
      uploaded.push(attachment);
      setPendingFiles(current => current.map(item => item.id === pending.id ? { ...item, status: 'uploaded', attachment } : item));
    }
    return uploaded;
  };

  const startVoiceCapture = async () => {
    if (voiceState !== 'off') return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Voice capture is not available in this browser.');
      return;
    }
    try {
      setError(null);
      audioChunksRef.current = [];
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = event => {
        if (event.data?.size) audioChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach(track => track.stop());
        mediaStreamRef.current = null;
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        audioChunksRef.current = [];
        setVoiceState('off');
        if (blob.size <= 0) {
          setError('Voice note was empty. Try recording again.');
          return;
        }
        const file = new File([blob], `voice-note-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`, { type: blob.type || 'audio/webm' });
        addFiles([file]);
        setActivityPhase('idle');
      };
      recorder.start();
      setVoiceState('recording');
      setActivityPhase('recording');
    } catch (err) {
      mediaStreamRef.current?.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
      setVoiceState('off');
      setActivityPhase('idle');
      setError(err instanceof Error ? err.message : 'Voice capture could not start.');
    }
  };

  const stopVoiceCapture = () => {
    if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop();
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const message = input.trim();
    if ((!message && pendingFiles.length === 0) || !conversationId) return;

    const optimisticId = `optimistic-${Date.now()}`;
    const attachmentNames = pendingFiles.map(item => item.file.name);
    setMessages((prev) => [
      ...prev,
      { id: optimisticId, role: 'user', content: attachmentNames.length ? `${message || 'Please review the attached file(s).'}\n\nAttached: ${attachmentNames.join(', ')}` : message, confidence: null, flagged: false, created_at: new Date().toISOString(), metadata: {} },
    ]);
    setInput('');
    setSending(true);
    setActivityPhase('preparing');
    setError(null);

    try {
      const attachments = await uploadPendingFiles(conversationId);
      setActivityPhase('waiting');
      // ATLAS CALLS: onspace-ai-chat (persists both user + assistant messages server-side)
      const { data, error: fnError } = await supabase.functions.invoke('onspace-ai-chat', {
        body: {
          message: message || 'Please review the attached file(s).',
          conversation_id: conversationId,
          attachments,
          context: { ...(context ?? {}), agent_mode: mode },
        },
      });

      if (fnError) throw fnError;

  setActivityPhase('refreshing');
      // Refresh from bob_messages so we show the server-persisted, canonical thread
      const { data: history, error: historyErr } = await supabase
        .from('bob_messages')
        .select('id, role, content, confidence, flagged, created_at, metadata')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true });

      if (historyErr) throw historyErr;

      if (history && history.length > 0) {
        setMessages(history as BobMessage[]);
        await loadAttachments(conversationId);
        setPendingFiles([]);
      } else if (data?.reply) {
        // Fallback: function replied but history read didn't return rows yet
        setMessages((prev) => [
          ...prev.filter((m) => m.id !== optimisticId),
          { id: optimisticId, role: 'user', content: attachmentNames.length ? `${message || 'Please review the attached file(s).'}\n\nAttached: ${attachmentNames.join(', ')}` : message, confidence: null, flagged: false, created_at: new Date().toISOString(), metadata: {} },
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
        await loadAttachments(conversationId);
        setPendingFiles([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bob could not respond. Try again.');
    } finally {
      setActivityPhase('idle');
      setSending(false);
    }
  };

  if (!open) return null;

  const quickActions = mode === 'builder'
    ? [
      { label: 'Inspect job', prompt: 'Inspect the selected Builder job and propose the next implementation step.' },
      { label: 'Plan implementation', prompt: 'Create an implementation plan with affected files, verification steps, and unknowns.' },
      { label: 'Review evidence', prompt: 'Review the current artifacts and explain the next safe repair or build action.' },
    ]
    : [
      { label: 'Summarize context', prompt: 'Summarize the current context and identify the next safe action.' },
      { label: 'Plan work', prompt: 'Create a step-by-step plan with unknowns and approval gates.' },
      { label: 'Review risk', prompt: 'Check this surface for risks, missing evidence, and tests.' },
    ];

  return (
    <div
      className={`bob-panel ${workspaceExpanded ? 'is-expanded' : ''} ${dragging ? 'is-dragging' : ''}`}
      aria-label="Bob agent workspace"
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
      onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }}
    >
      <header className="bob-panel-header">
        <div className="bob-panel-identity"><span><Bot size={18} /></span><div><strong>{mode === 'builder' ? 'Bob Builder' : 'Bob Operations'}</strong><small><ShieldCheck size={12} /> Governed session</small></div></div>
        <div className="bob-panel-header-actions">
          <button type="button" onClick={() => setSidebarOpen(current => !current)} title={sidebarOpen ? 'Hide sessions' : 'Show sessions'} aria-label={sidebarOpen ? 'Hide sessions' : 'Show sessions'} aria-expanded={sidebarOpen}><PanelLeft size={17} /></button>
          <button type="button" onClick={() => setContextPanelOpen(current => !current)} title={contextPanelOpen ? 'Hide context panel' : 'Show context panel'} aria-label={contextPanelOpen ? 'Hide context panel' : 'Show context panel'} aria-expanded={contextPanelOpen}><PanelRight size={17} /></button>
          <button type="button" onClick={() => setWorkspaceExpanded(current => !current)} title={workspaceExpanded ? 'Use compact panel' : 'Open full workspace'} aria-label={workspaceExpanded ? 'Use compact panel' : 'Open full workspace'}>{workspaceExpanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>
          <button type="button" onClick={onClose} title="Close Bob" aria-label="Close Bob"><PanelRightClose size={18} /></button>
        </div>
      </header>

      <div className="bob-workspace">
        {sidebarOpen && (
          <SessionSidebar
            sessions={sessions}
            activeId={conversationId}
            search={sessionSearch}
            searchScope={searchScope}
            onScope={(scope) => { setSearchScope(scope); void searchWorkspace(sessionSearch, scope); }}
            onSearch={(value) => void searchWorkspace(value, searchScope)}
            results={globalResults}
            onResult={(result) => { if (result.conversationId) void selectSession(result.conversationId); }}
            onSelect={(id) => void selectSession(id)}
            onNew={() => void startNewConversation()}
            renamingId={renamingId}
            renameValue={renameValue}
            onRenameStart={(id, title) => { setRenamingId(id); setRenameValue(title); }}
            onRenameChange={setRenameValue}
            onRenameCommit={(id) => { void renameSession(id, renameValue); setRenamingId(null); }}
            onRenameCancel={() => setRenamingId(null)}
            filter={sessionFilter}
            onFilter={setSessionFilter}
            onTogglePin={(session) => void updateSession(session.id, { pinned: !session.pinned })}
            onArchive={(session) => void updateSession(session.id, { archived_at: session.archived_at ? null : new Date().toISOString() })}
            busy={loading || sending}
            onDismiss={() => setSidebarOpen(false)}
            width={sidebarWidth}
          />
        )}

        {workspaceExpanded && sidebarOpen && <div className="bob-pane-divider is-left" role="separator" aria-orientation="vertical" aria-label="Resize sessions pane" onPointerDown={(event) => beginPaneResize('left', event)} />}

        <div className="bob-main-pane">
          {contextEntries.length > 0 && <div className="bob-context" aria-label="Active context"><FileSearch size={15} /><div>{contextEntries.map(([key, value]) => <span key={key}><b>{key.replaceAll('_', ' ')}</b>{String(value)}</span>)}</div></div>}

          <div className={`bob-work-state state-${workState.tone}`} role="status" aria-live="polite"><span>{workState.label}</span><p>{workState.detail}</p></div>

          {error && (
            <div className="bob-panel-error" role="alert"><AlertTriangle size={15} /> {error}</div>
          )}

          <BobActivityTimeline phase={activityPhase} sending={sending} loading={loading} pendingFiles={pendingFiles} />

          <div ref={scrollRef} className="bob-message-stream" aria-live="polite">
            {dragging && <div className="bob-drop-target"><FileUp size={17} /> Drop files for Bob to read.</div>}
            {loading ? (
              <div className="bob-agent-status"><Sparkles size={16} /> Loading conversation</div>
            ) : messages.length === 0 ? (
              <div className="bob-empty-state">
                <Bot size={24} />
                <strong>{mode === 'builder' ? 'What should we build?' : 'What are we working on?'}</strong>
                <p>Start a new chat, upload documents, or resume recent work from the session list.</p>
                <div>
                  <button type="button" className="is-primary" onClick={() => void startNewConversation()}>Start a new chat</button>
                  <button type="button" onClick={() => fileInputRef.current?.click()}>Upload documents</button>
                </div>
              </div>
            ) : (
              messages.map((m) => (
                <article key={m.id} className={`bob-message role-${m.role}`}>
                  {m.role !== 'user' && <span className="bob-message-avatar"><Bot size={14} /></span>}
                  <div className="bob-message-body">
                    {m.role === 'assistant' && <AgentMetadata message={m} />}
                    <div className="bob-message-content">{m.role === 'assistant' ? <BobMarkdown content={m.content} /> : m.content}</div>
                    {m.role === 'assistant' && <OperationalCards message={m} />}
                    <footer><time dateTime={m.created_at}>{new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>{m.flagged && <span className="bob-flagged"><AlertTriangle size={12} /> Review required</span>}</footer>
                  </div>
                </article>
              ))
            )}
          </div>

          {!workspaceExpanded && !contextPanelOpen && attachments.length > 0 && (
            <div className="bob-attachment-results" aria-label="Evidence processing results">
              {attachments.map(attachment => <AttachmentResultCard key={attachment.id} attachment={attachment} />)}
            </div>
          )}

          {pendingFiles.length > 0 && (
            <div className="bob-file-tray" aria-label="Attached files">
              {pendingFiles.map(item => (
                <button key={item.id} type="button" className={`bob-file-chip is-${item.status}`} onClick={() => setPendingFiles(current => current.filter(file => file.id !== item.id))} disabled={sending} title={item.error || 'Remove file'}>
                  <FileUp size={13} />
                  <span>{item.file.name}</span>
                  <small>{item.status}</small>
                </button>
              ))}
            </div>
          )}

          <div className="bob-quick-actions" aria-label="Quick actions">
            {quickActions.map(action => (
              <button key={action.label} type="button" onClick={() => setInput(action.prompt)} disabled={sending}>{action.label}</button>
            ))}
          </div>

          <p className="bob-composer-hint">{ACCEPTED_BOB_UPLOAD_LABEL}. Attach with the paperclip or drop files onto this panel.</p>

          <div className="bob-session-actions" aria-label="Bob session and voice controls">
            <button type="button" className="bob-session-action" onClick={() => void startNewConversation()} disabled={loading || sending}>
              <Plus size={15} />
              <span>New chat</span>
            </button>
            <button type="button" className={`bob-session-action bob-voice-action ${voiceState === 'recording' ? 'is-recording' : ''}`} onClick={() => voiceState === 'recording' ? stopVoiceCapture() : void startVoiceCapture()} disabled={sending} aria-label={voiceState === 'recording' ? 'Stop voice capture' : 'Hold to talk'}>
              <Mic size={15} />
              <span>{voiceState === 'recording' ? 'Stop recording' : 'Hold to talk'}</span>
            </button>
          </div>

          <form onSubmit={handleSend} className="bob-composer">
            <input ref={fileInputRef} type="file" multiple accept={ACCEPTED_BOB_UPLOADS} onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.currentTarget.value = ''; }} className="sr-only" aria-label="Attach evidence files" />
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={mode === 'builder' ? 'Describe what you want to build, change, or fix' : 'Ask Bob to plan, inspect, explain, or prepare a proposal'}
              disabled={sending || !conversationId}
              rows={3}
            />
            <button
              type="button"
              className="bob-evidence-button"
              onClick={() => fileInputRef.current?.click()}
              title={ACCEPTED_BOB_UPLOAD_LABEL}
              aria-label="Attach files"
              disabled={sending || !conversationId}
            >
              <Paperclip size={17} />
            </button>
            <button
              type="submit"
              disabled={sending || (!input.trim() && pendingFiles.length === 0) || !conversationId}
              title="Send request to Bob"
            >
              {sending ? <Sparkles size={17} className="is-spinning" /> : <Send size={17} />}
              <span className="sr-only">Send</span>
            </button>
          </form>
        </div>

        {workspaceExpanded && contextPanelOpen && <div className="bob-pane-divider is-right" role="separator" aria-orientation="vertical" aria-label="Resize context pane" onPointerDown={(event) => beginPaneResize('right', event)} />}
        {contextPanelOpen && (
          <ContextPanel
            tab={contextTab}
            onTab={setContextTab}
            messages={messages}
            attachments={attachments}
            contextEntries={contextEntries}
            onDismiss={() => setContextPanelOpen(false)}
            width={contextPanelWidth}
          />
        )}
      </div>
    </div>
  );
};

function derivePanelWorkState(input: { loading: boolean; sending: boolean; error: string | null; input: string; messages: BobMessage[]; pendingFiles: PendingBobFile[]; attachments: BobAttachmentRecord[] }): WorkState {
  if (input.error) return { tone: 'failed', label: 'Failed/paused', detail: `The last operation did not complete: ${input.error}. Check the message and try again.` };
  if (input.pendingFiles.some(file => file.status === 'uploading')) return { tone: 'using-data', label: 'Using app data', detail: 'Uploading evidence to private storage and registering it for Bob.' };
  if (input.pendingFiles.some(file => file.status === 'failed')) return { tone: 'failed', label: 'Failed/paused', detail: 'One or more files failed to upload. Remove the failed file or try again.' };
  if (input.pendingFiles.length) return { tone: 'waiting', label: 'Waiting on you', detail: `${input.pendingFiles.length} file${input.pendingFiles.length === 1 ? '' : 's'} queued. Send when you are ready for Bob to read them.` };
  if (input.sending) return { tone: 'working', label: 'Working', detail: 'Bob is processing the request. The next change will be an answer, a named blocker, or a proposal state.' };
  if (input.loading) return { tone: 'using-data', label: 'Using app data', detail: 'Loading the durable Bob thread before accepting work.' };
  if (input.attachments.some(file => file.processing_state === 'processing' || file.processing_state === 'pending')) return { tone: 'using-data', label: 'Using app data', detail: 'Bob has evidence queued or in extraction. The file cards show the current state.' };
  if (input.attachments.some(file => file.processing_state === 'manual_review_required')) return { tone: 'waiting', label: 'Waiting on you', detail: 'One or more evidence items needs human review before it can be trusted.' };
  if (input.attachments.some(file => file.processing_state === 'failed')) return { tone: 'failed', label: 'Failed/paused', detail: 'One or more evidence items failed extraction. Check the file card and retry with a supported file.' };

  const lastAssistant = [...input.messages].reverse().find(message => message.role === 'assistant');
  if (lastAssistant) {
    const state = classifyMessageState(lastAssistant);
    if (state.tone === 'proposal' || state.tone === 'waiting' || state.tone === 'failed' || state.tone === 'using-data') return state;
  }

  if (input.input.trim()) return { tone: 'idle', label: 'Idle', detail: 'You are drafting locally. Nothing has been sent to Bob yet.' };
  return { tone: 'idle', label: 'Idle', detail: 'Ready for input. No Bob work is running.' };
}

function asString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function BobActivityTimeline({ phase, sending, loading, pendingFiles }: { phase: ActivityPhase; sending: boolean; loading: boolean; pendingFiles: PendingBobFile[] }) {
  const active = phase !== 'idle' || sending || loading || pendingFiles.some(file => file.status === 'uploading');
  if (!active) return null;

  const steps = [
    { id: 'preparing', label: 'Preparing request', detail: pendingFiles.length ? `${pendingFiles.length} file${pendingFiles.length === 1 ? '' : 's'} included` : 'Message context assembled' },
    { id: 'uploading', label: 'Uploading evidence', detail: 'Files are being stored privately and registered for Bob' },
    { id: 'waiting', label: 'Waiting for Bob', detail: 'Request is with the Bob conductor' },
    { id: 'refreshing', label: 'Refreshing transcript', detail: 'Loading the durable response and evidence state' },
  ];
  const order = steps.map(step => step.id);
  const activeIndex = phase === 'recording' ? -1 : Math.max(0, order.indexOf(phase));

  if (phase === 'recording') {
    return (
      <section className="bob-working-panel" aria-label="Bob working state">
        <div><Sparkles size={14} className="is-spinning" /><span>Bob is listening</span></div>
        <ol><li className="is-active"><strong>Recording voice note</strong><small>Press Stop voice capture to queue the audio as evidence.</small></li></ol>
      </section>
    );
  }

  return (
    <section className="bob-working-panel" aria-label="Bob working state">
      <div><Sparkles size={14} className="is-spinning" /><span>Bob is working</span></div>
      <ol>
        {steps.map((step, index) => (
          <li key={step.id} className={index < activeIndex ? 'is-complete' : index === activeIndex ? 'is-active' : ''}>
            <strong>{step.label}</strong>
            <small>{step.detail}</small>
          </li>
        ))}
      </ol>
    </section>
  );
}

function attachmentStateLabel(state: string) {
  if (state === 'pending') return 'Queued';
  if (state === 'processing') return 'Reading/OCR';
  if (state === 'extracted') return 'Extracted';
  if (state === 'failed') return 'Failed';
  if (state === 'manual_review_required') return 'Needs review';
  return state.replaceAll('_', ' ');
}

function sessionGroupLabel(updatedAt: string) {
  const updated = new Date(updatedAt);
  const now = new Date();
  const sameDay = updated.toDateString() === now.toDateString();
  if (sameDay) return 'Today';
  const dayMs = 24 * 60 * 60 * 1000;
  return now.getTime() - updated.getTime() < 7 * dayMs ? 'Earlier this week' : 'Older';
}

function SessionSidebar(props: {
  sessions: BobSessionSummary[];
  activeId: string | null;
  search: string;
  searchScope: SearchScope;
  onScope: (scope: SearchScope) => void;
  onSearch: (value: string) => void;
  results: GlobalSearchResult[];
  onResult: (result: GlobalSearchResult) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  renamingId: string | null;
  renameValue: string;
  onRenameStart: (id: string, title: string) => void;
  onRenameChange: (value: string) => void;
  onRenameCommit: (id: string) => void;
  onRenameCancel: () => void;
  filter: SessionFilter;
  onFilter: (filter: SessionFilter) => void;
  onTogglePin: (session: BobSessionSummary) => void;
  onArchive: (session: BobSessionSummary) => void;
  busy: boolean;
  onDismiss: () => void;
  width: number;
}) {
  const term = props.search.trim().toLowerCase();
  const visible = props.filter === 'archived'
    ? props.sessions.filter(session => Boolean(session.archived_at))
    : props.sessions.filter(session => !session.archived_at && (props.filter !== 'pinned' || session.pinned));
  const filtered = term
    ? visible.filter(session => (session.title ?? 'Untitled session').toLowerCase().includes(term))
    : visible;

  const groups = filtered.reduce<Record<string, BobSessionSummary[]>>((acc, session) => {
    const key = session.pinned && props.filter !== 'archived' ? 'Pinned' : sessionGroupLabel(session.updated_at);
    (acc[key] ??= []).push(session);
    return acc;
  }, {});

  return (
    <aside className="bob-session-sidebar" aria-label="Bob sessions" style={{ flexBasis: props.width }}>
      <div className="bob-drawer-head">
        <h2>Sessions</h2>
        <button type="button" onClick={props.onDismiss} aria-label="Close sessions"><X size={16} /></button>
      </div>

      <button type="button" className="bob-sidebar-new" onClick={props.onNew} disabled={props.busy}>
        <Plus size={15} /><span>New chat</span>
      </button>

      <div className="bob-sidebar-search">
        <Search size={14} />
        <input value={props.search} onChange={(event) => props.onSearch(event.target.value)} placeholder="Search chats" aria-label="Search chats" />
      </div>

      <div className="bob-search-scopes" aria-label="Search scope">
        {(['chats', 'files', 'actions'] as SearchScope[]).map(scope => (
          <button key={scope} type="button" className={props.searchScope === scope ? 'is-active' : ''} onClick={() => props.onScope(scope)}>{scope}</button>
        ))}
      </div>

      <div className="bob-session-filters" aria-label="Session filters">
        {(['all', 'pinned', 'archived'] as SessionFilter[]).map(filter => (
          <button key={filter} type="button" className={props.filter === filter ? 'is-active' : ''} onClick={() => props.onFilter(filter)}>
            {filter}
          </button>
        ))}
      </div>

      {props.searchScope !== 'chats' && props.search.trim().length >= 2 ? (
        <div className="bob-global-results" aria-label="Search results">
          {props.results.length === 0 ? <p className="bob-sidebar-empty">No {props.searchScope} match that search.</p> : props.results.map(result => (
            <button key={`${result.type}-${result.id}`} type="button" onClick={() => props.onResult(result)} disabled={!result.conversationId}>
              <span>{result.type}</span>
              <strong>{result.title}</strong>
              <small>{result.detail}</small>
            </button>
          ))}
        </div>
      ) : <div className="bob-sidebar-list">
        {filtered.length === 0 ? (
          <p className="bob-sidebar-empty">{props.sessions.length === 0 ? 'No sessions yet.' : 'No chats match that search.'}</p>
        ) : (
          Object.entries(groups).sort(([left], [right]) => left === 'Pinned' ? -1 : right === 'Pinned' ? 1 : 0).map(([group, rows]) => (
            <section key={group}>
              <h3>{group}</h3>
              {rows.map(session => (
                <div key={session.id} className={`bob-session-row ${session.id === props.activeId ? 'is-active' : ''}`}>
                  {props.renamingId === session.id ? (
                    <input
                      className="bob-session-rename"
                      value={props.renameValue}
                      autoFocus
                      aria-label="Session title"
                      onChange={(event) => props.onRenameChange(event.target.value)}
                      onBlur={() => props.onRenameCommit(session.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') props.onRenameCommit(session.id);
                        if (event.key === 'Escape') props.onRenameCancel();
                      }}
                    />
                  ) : (
                    <>
                      <button type="button" className="bob-session-open" onClick={() => props.onSelect(session.id)} disabled={props.busy}>
                        <strong>{session.pinned && <Pin size={11} />} {session.title || 'Untitled session'}</strong>
                        <small>{new Date(session.updated_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small>
                      </button>
                      <div className="bob-session-row-actions">
                        <button type="button" aria-label={`Rename ${session.title || 'Untitled session'}`} onClick={() => props.onRenameStart(session.id, session.title ?? '')}><Pencil size={13} /></button>
                        <button type="button" aria-label={session.pinned ? `Unpin ${session.title || 'Untitled session'}` : `Pin ${session.title || 'Untitled session'}`} onClick={() => props.onTogglePin(session)}>{session.pinned ? <PinOff size={13} /> : <Pin size={13} />}</button>
                        <button type="button" aria-label={session.archived_at ? `Restore ${session.title || 'Untitled session'}` : `Archive ${session.title || 'Untitled session'}`} onClick={() => props.onArchive(session)}>{session.archived_at ? <ArchiveRestore size={13} /> : <Archive size={13} />}</button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </section>
          ))
        )}
      </div>}
    </aside>
  );
}

function ContextPanel(props: {
  tab: ContextTab;
  onTab: (tab: ContextTab) => void;
  messages: BobMessage[];
  attachments: BobAttachmentRecord[];
  contextEntries: Array<[string, unknown]>;
  onDismiss: () => void;
  width: number;
}) {
  const assistantTurns = props.messages.filter(message => message.role === 'assistant');
  const proposals = assistantTurns.filter(message => classifyMessageState(message).tone === 'proposal');
  const tabs: Array<{ id: ContextTab; label: string }> = [
    { id: 'context', label: 'Context' },
    { id: 'files', label: 'Files' },
    { id: 'actions', label: 'Actions' },
    { id: 'audit', label: 'Audit' },
  ];

  return (
    <aside className="bob-context-panel" aria-label="Bob context panel" style={{ flexBasis: props.width }}>
      <div className="bob-drawer-head">
        <h2>Context</h2>
        <button type="button" onClick={props.onDismiss} aria-label="Close context panel"><X size={16} /></button>
      </div>

      <div className="bob-context-tabs" role="tablist">
        {tabs.map(tab => (
          <button key={tab.id} type="button" role="tab" aria-selected={props.tab === tab.id} className={props.tab === tab.id ? 'is-active' : ''} onClick={() => props.onTab(tab.id)}>
            {tab.label}
          </button>
        ))}
      </div>

      <div className="bob-context-body">
        {props.tab === 'context' && (
          <section>
            <h4>Active context</h4>
            {props.contextEntries.length === 0 ? <p>No page context supplied.</p> : (
              <ul className="bob-context-entities">
                {props.contextEntries.map(([key, value]) => <li key={key}><span>{key.replaceAll('_', ' ')}</span><strong>{String(value)}</strong></li>)}
              </ul>
            )}
            <h4>Conversation</h4>
            <p>{props.messages.length} message{props.messages.length === 1 ? '' : 's'} in this session.</p>
          </section>
        )}

        {props.tab === 'files' && (
          <section>
            <h4>Attached evidence</h4>
            {props.attachments.length === 0 ? <p>No files attached to this session.</p> : props.attachments.map(attachment => (
              <AttachmentResultCard key={attachment.id} attachment={attachment} />
            ))}
          </section>
        )}

        {props.tab === 'actions' && (
          <section>
            <h4>Governed actions</h4>
            {proposals.length === 0 ? <p>No proposals prepared in this session.</p> : proposals.map(message => (
              <article key={message.id} className="bob-context-action">
                <ListChecks size={14} />
                <div>
                  <strong>Draft prepared</strong>
                  <small>{new Date(message.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small>
                  <p>Nothing is applied until a human approves it in the approval surface.</p>
                </div>
              </article>
            ))}
          </section>
        )}

        {props.tab === 'audit' && (
          <section>
            <h4>Activity timeline</h4>
            {assistantTurns.length === 0 ? <p>No Bob activity recorded yet.</p> : (
              <ol className="bob-context-audit">
                {assistantTurns.map(message => {
                  const state = classifyMessageState(message);
                  return (
                    <li key={message.id}>
                      <Clock3 size={12} />
                      <div>
                        <strong>{state.label}</strong>
                        <small>{new Date(message.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        )}
      </div>
    </aside>
  );
}

function AttachmentResultCard({ attachment }: { attachment: BobAttachmentRecord }) {
  const label = attachmentStateLabel(attachment.processing_state);
  const confidence = typeof attachment.confidence === 'number' ? `${Math.round(attachment.confidence * 100)}% confidence` : null;
  return (
    <article className={`bob-attachment-card state-${attachment.processing_state}`}>
      <FileUp size={14} />
      <div>
        <strong>{attachment.file_name}</strong>
        <span>{label}{confidence ? ` · ${confidence}` : ''}</span>
        {attachment.extraction_summary && <p>{attachment.extraction_summary}</p>}
      </div>
    </article>
  );
}

function classifyMessageState(message: BobMessage): WorkState {
  const metadata = message.metadata ?? {};
  const outcome = asString(metadata.outcome);
  const plannedTool = asString(metadata.planned_tool) ?? asString(metadata.tool);
  const hasProposal = Boolean(asString(metadata.action_id) || asString(metadata.org_action_id) || asArray(metadata.site_action_ids).length || asArray(metadata.proposed_entities).length || plannedTool?.startsWith('propose_'));
  const hasEvidence = Boolean(metadata.document_qa || asArray(metadata.reasoning_steps).length || asArray(metadata.files).length || asArray(metadata.sources).length || asArray(metadata.results).length);

  if (message.flagged || outcome === 'error' || outcome === 'failed') return { tone: 'failed', label: 'Failed/paused', detail: 'Bob recorded a failed or flagged operation for review.' };
  if (hasProposal) return { tone: 'proposal', label: 'Draft prepared', detail: 'Nothing has changed yet. Review the governed action and approve it in the approval surface.' };
  if (outcome === 'need_clarification' || outcome === 'clarifying_questions') return { tone: 'waiting', label: 'Waiting on you', detail: 'Bob needs one decision or missing detail before work can continue.' };
  if (plannedTool === 'query_records' || plannedTool === 'sql_read' || plannedTool === 'schema_inspect' || plannedTool === 'self_audit') return { tone: 'using-data', label: 'Using app data', detail: `Bob checked ${plannedTool.replaceAll('_', ' ')} for this turn.` };
  if (hasEvidence) return { tone: 'completed', label: 'Completed', detail: 'Bob attached structured evidence or reasoning metadata to this turn.' };
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
