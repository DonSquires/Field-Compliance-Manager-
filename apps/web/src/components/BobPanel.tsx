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
import { Bot, ClipboardCheck, Download, FileText, FileUp, Image, Loader2, Plus, SendHorizontal, ShieldCheck, Sparkles, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './BobPanel.css';

const MAX_BOB_UPLOAD_BYTES = 48 * 1024 * 1024;
const ACCEPTED_BOB_UPLOADS = 'image/*,video/*,audio/*,.csv,.txt,.pdf,.doc,.docx,.xls,.xlsx,.json,.md';

interface BobMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  confidence: number | null;
  flagged: boolean;
  created_at: string;
  metadata?: Record<string, unknown>;
}

interface BobChoice {
  label: string;
  value: string;
  state?: 'preferred' | 'qualified' | 'review' | 'not_suitable' | 'no_credentials';
  detail?: string;
}

interface BobArtifact {
  id?: string;
  title: string;
  type?: 'photo' | 'document' | 'report' | 'dataset' | 'map' | 'task' | 'evidence' | 'file';
  status?: 'ready' | 'draft' | 'pending' | 'needs_approval';
  summary?: string;
  content?: string;
  mimeType?: string;
  downloadName?: string;
  url?: string;
  previewUrl?: string;
  storage_bucket?: string;
  storage_path?: string;
}

interface BobAction {
  label: string;
  prompt: string;
  kind?: 'artifact' | 'photo' | 'document' | 'approval' | 'navigation' | 'selection';
  detail?: string;
}

interface BobConversation {
  id: string;
  title: string | null;
  updated_at: string;
}

interface PendingBobFile {
  id: string;
  file: File;
  status: 'ready' | 'uploading' | 'uploaded' | 'failed';
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

interface ApprovalSummary {
  pending: number;
  decidable: number;
}

const bobMissionActions: BobAction[] = [
  {
    label: 'Build Brief',
    prompt: 'Bob, produce an operational brief for the current task with assumptions, blockers, decisions needed, and next actions.',
    kind: 'document',
  },
  {
    label: 'Create Report',
    prompt: 'Bob, create a formal report artifact from this conversation, including evidence, decisions, risks, and recommended actions.',
    kind: 'artifact',
  },
  {
    label: 'Photo Evidence',
    prompt: 'Bob, prepare a photo evidence request pack: what photos are needed, where they should be taken, quality checks, and how they should be labelled.',
    kind: 'photo',
  },
  {
    label: 'Decision Pack',
    prompt: 'Bob, produce a decision pack with options, preference order, risks, approval requirements, and the safest next step.',
    kind: 'approval',
  },
];

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
};

interface BobPanelProps {
  open: boolean;
  onClose: () => void;
  onOpenApprovals?: () => void;
  context?: Record<string, unknown>;
}

export const BobPanel: React.FC<BobPanelProps> = ({ open, onClose, onOpenApprovals, context }) => {
  const { profile } = useAuth();
  const [conversations, setConversations] = useState<BobConversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<BobMessage[]>([]);
  const [input, setInput] = useState('');
  const [pendingFiles, setPendingFiles] = useState<PendingBobFile[]>([]);
  const [approvalSummary, setApprovalSummary] = useState<ApprovalSummary>({ pending: 0, decidable: 0 });
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadMessages = useCallback(async (convId: string) => {
    const { data: history, error: historyErr } = await supabase
      .from('bob_messages')
      .select('id, role, content, confidence, flagged, created_at, metadata')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: true });

    if (historyErr) throw historyErr;
    setMessages([...(history as BobMessage[] || [])].sort((left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime()));
  }, []);

  const createConversation = useCallback(async () => {
    if (!profile?.organizationId || !profile?.id) return null;
    const { data: created, error: createErr } = await supabase
      .from('bob_conversations')
      .insert([{ organization_id: profile.organizationId, user_id: profile.id, title: 'Session' }])
      .select('id, title, updated_at')
      .single();

    if (createErr) throw createErr;
    return created as BobConversation;
  }, [profile?.organizationId, profile?.id]);

  const loadApprovalSummary = useCallback(async () => {
    if (!profile?.organizationId) return;
    const { data, error: approvalError } = await supabase.rpc('get_approvals_activity', {
      p_limit: 25,
      p_offset: 0,
      p_statuses: ['pending'],
      p_action_types: null,
    });
    if (approvalError) return;
    const rows = (data as Array<{ can_decide?: boolean }> | null) ?? [];
    setApprovalSummary({
      pending: rows.length,
      decidable: rows.filter(row => row.can_decide).length,
    });
  }, [profile?.organizationId]);

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
        .select('id, title, updated_at')
        .eq('organization_id', profile.organizationId)
        .eq('user_id', profile.id)
        .order('updated_at', { ascending: false })
        .limit(20);

      if (findErr) throw findErr;

      const conversationRows = (existing as BobConversation[] || []);
      let convId: string | null = conversationId && conversationRows.some(conversation => conversation.id === conversationId) ? conversationId : conversationRows[0]?.id ?? null;

      if (!convId) {
        // ATLAS WRITES: bob_conversations
        const created = await createConversation();
        convId = created?.id ?? null;
        setConversations(created ? [created] : []);
      } else {
        setConversations(conversationRows);
      }

      setConversationId(convId);
      if (convId) await loadMessages(convId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Bob conversation');
    } finally {
      setLoading(false);
    }
  }, [profile?.organizationId, profile?.id, conversationId, createConversation, loadMessages]);

  const startNewConversation = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const created = await createConversation();
      if (!created) return;
      setConversations(current => [created, ...current.filter(conversation => conversation.id !== created.id)]);
      setConversationId(created.id);
      setMessages([]);
      setPendingFiles([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create a new Bob session.');
    } finally {
      setLoading(false);
    }
  }, [createConversation]);

  const selectConversation = useCallback(async (convId: string) => {
    setConversationId(convId);
    setPendingFiles([]);
    setError(null);
    await loadMessages(convId).catch(err => setError(err instanceof Error ? err.message : 'Could not load that Bob session.'));
  }, [loadMessages]);

  const updateConversationTitle = async (convId: string, message: string) => {
    const current = conversations.find(conversation => conversation.id === convId);
    if (!current || (current.title && current.title !== 'Session')) return;
    const title = message.replace(/\s+/g, ' ').trim().slice(0, 60) || 'File review';
    const { error: titleError } = await supabase.from('bob_conversations').update({ title }).eq('id', convId);
    if (!titleError) {
      setConversations(rows => rows.map(row => row.id === convId ? { ...row, title } : row));
    }
  };

  const choicesFor = (message: BobMessage): BobChoice[] => {
    const choices = message.metadata?.choices;
    if (!Array.isArray(choices)) return [];
    return choices.filter((choice): choice is BobChoice => Boolean(
      choice && typeof choice === 'object' && typeof choice.label === 'string' && typeof choice.value === 'string'
    ));
  };

  const artifactsFor = (message: BobMessage): BobArtifact[] => {
    const metadata = asRecord(message.metadata);
    const rawArtifacts = metadata?.artifacts ?? metadata?.artifact_cards ?? metadata?.outputs;
    const artifacts = Array.isArray(rawArtifacts) ? rawArtifacts : metadata?.artifact ? [metadata.artifact] : [];
    return artifacts.filter((artifact): artifact is BobArtifact => Boolean(
      artifact && typeof artifact === 'object' && typeof (artifact as BobArtifact).title === 'string'
    ));
  };

  const actionsFor = (message: BobMessage): BobAction[] => {
    const actions = message.metadata?.actions;
    if (!Array.isArray(actions)) return [];
    return actions.filter((action): action is BobAction => Boolean(
      action && typeof action === 'object' && typeof action.label === 'string' && typeof action.prompt === 'string'
    ));
  };

  const requestMissionAction = (action: BobAction) => {
    setInput(action.prompt);
  };

  const chooseBobOption = (choice: BobChoice) => {
    setInput(`I select ${choice.value}. Continue with this selection.`);
  };

  const downloadArtifact = (artifact: BobArtifact) => {
    if (artifact.url || artifact.previewUrl) {
      window.open(artifact.url ?? artifact.previewUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    const content = artifact.content ?? artifact.summary ?? '';
    if (!content.trim()) return;
    const mimeType = artifact.mimeType ?? (artifact.type === 'dataset' ? 'application/json' : 'text/markdown');
    const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = artifact.downloadName ?? `${artifact.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'bob-artifact'}.${mimeType.includes('json') ? 'json' : 'md'}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(href);
  };

  useEffect(() => {
    if (open) {
      void loadConversation();
      void loadApprovalSummary();
    }
  }, [open, loadConversation, loadApprovalSummary]);

  useEffect(() => {
    if (!open || !conversationId) return undefined;
    if (typeof supabase.channel !== 'function') return undefined;
    const channel = supabase
      .channel(`bob_messages_${conversationId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bob_messages', filter: `conversation_id=eq.${conversationId}` }, () => void loadMessages(conversationId))
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [open, conversationId, loadMessages]);

  useEffect(() => {
    if (!open || !profile?.organizationId) return undefined;
    if (typeof supabase.channel !== 'function') return undefined;
    const channel = supabase
      .channel(`bob_approvals_${profile.organizationId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bob_agentic_actions', filter: `organization_id=eq.${profile.organizationId}` }, () => void loadApprovalSummary())
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [open, profile?.organizationId, loadApprovalSummary]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node || typeof node.scrollTo !== 'function') return;
    node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const addFiles = (fileList: FileList | File[]) => {
    const nextFiles = Array.from(fileList).filter(file => file.size > 0 && file.size <= MAX_BOB_UPLOAD_BYTES).map(file => ({
      id: `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`,
      file,
      status: 'ready' as const,
    }));
    const rejected = Array.from(fileList).filter(file => file.size > MAX_BOB_UPLOAD_BYTES);
    if (rejected.length) setError('One or more files are larger than the 48 MB upload limit.');
    setPendingFiles(current => [...current, ...nextFiles].slice(0, 8));
  };

  const uploadPendingFiles = async (convId: string) => {
    if (!profile?.organizationId || !profile?.id) return [];
    const uploaded: BobAttachmentPayload[] = [];
    for (const pending of pendingFiles) {
      if (pending.attachment) {
        uploaded.push(pending.attachment);
        continue;
      }
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
      const attachmentRecord = {
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
      };
      const { error: metadataError } = await supabase.from('bob_attachments').insert([attachmentRecord]);
      if (metadataError) {
        await supabase.storage.from('bob-uploads').remove([storagePath]);
        setPendingFiles(current => current.map(item => item.id === pending.id ? { ...item, status: 'failed', error: metadataError.message } : item));
        throw metadataError;
      }
      const attachment = {
        id: attachmentId,
        name: pending.file.name,
        type: pending.file.type || 'application/octet-stream',
        storage_bucket: 'bob-uploads',
        storage_path: storagePath,
      };
      uploaded.push(attachment);
      setPendingFiles(current => current.map(item => item.id === pending.id ? { ...item, status: 'uploaded', attachment } : item));
    }
    return uploaded;
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const message = input.trim();
    if ((!message && pendingFiles.length === 0) || !conversationId) return;

    const optimisticId = `optimistic-${Date.now()}`;
    const attachmentNames = pendingFiles.map(item => item.file.name);
    setMessages((prev) => [
      ...prev,
      { id: optimisticId, role: 'user', content: attachmentNames.length ? `${message || 'Please review the attached file(s).'}

Attached: ${attachmentNames.join(', ')}` : message, confidence: null, flagged: false, created_at: new Date().toISOString() },
    ]);
    setInput('');
    setSending(true);
    setError(null);

    try {
      const attachments = await uploadPendingFiles(conversationId);
      await updateConversationTitle(conversationId, message || attachmentNames[0] || 'File review');
      // ATLAS CALLS: onspace-ai-chat (persists both user + assistant messages server-side)
      const { data, error: fnError } = await supabase.functions.invoke('onspace-ai-chat', {
        body: {
          message: message || 'Please review the attached file(s).',
          conversation_id: conversationId,
          attachments,
          context: context ?? {},
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
        setMessages([...(history as BobMessage[])].sort((left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime()));
        setPendingFiles([]);
      } else if (data?.reply) {
        // Fallback: function replied but history read didn't return rows yet
        const replyMetadata = asRecord(data.metadata);
        setMessages((prev) => [
          ...prev.filter((m) => m.id !== optimisticId),
          { id: optimisticId, role: 'user', content: attachmentNames.length ? `${message || 'Please review the attached file(s).'}

Attached: ${attachmentNames.join(', ')}` : message, confidence: null, flagged: false, created_at: new Date().toISOString() },
          {
            id: `reply-${Date.now()}`,
            role: 'assistant',
            content: String(data.reply),
            confidence: null,
            flagged: false,
            created_at: new Date().toISOString(),
            metadata: replyMetadata,
          },
        ]);
        setPendingFiles([]);
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
      className={`bob-panel ${dragging ? 'is-dragging' : ''}`}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
      onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }}
    >
      <div className="bob-panel-header">
        <div className="bob-panel-title">
          <span><Bot size={16} aria-hidden="true" /></span>
          <div>
            <strong>Bob</strong>
            <small>Ship's computer · artifacts · approvals</small>
          </div>
        </div>
        <div className="bob-panel-header-actions">
          {approvalSummary.pending > 0 && (
            <button type="button" className="bob-approval-button" onClick={onOpenApprovals} title="Open approvals" disabled={!onOpenApprovals}>
              <ShieldCheck size={15} aria-hidden="true" />
              <span>{approvalSummary.decidable}/{approvalSummary.pending}</span>
            </button>
          )}
          <button type="button" onClick={() => void startNewConversation()} title="New Bob session">
            <Plus size={15} aria-hidden="true" />
            <span>New</span>
          </button>
          <button type="button" onClick={onClose} title="Close Bob">
            <X size={16} aria-hidden="true" />
            <span className="sr-only">Close Bob</span>
          </button>
        </div>
      </div>

      {conversations.length > 1 && (
        <div className="bob-session-strip" aria-label="Bob sessions">
          {conversations.map((conversation, index) => (
            <button key={conversation.id} type="button" className={conversation.id === conversationId ? 'is-active' : ''} onClick={() => void selectConversation(conversation.id)}>
              {conversation.title || `Session ${conversations.length - index}`}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="bob-panel-error" role="alert">{error}</div>
      )}

      <div className="bob-command-deck" aria-label="Bob mission actions">
        <div className="bob-command-status">
          <span><Sparkles size={14} aria-hidden="true" /> Live console</span>
          <small>{pendingFiles.length ? `${pendingFiles.length} file${pendingFiles.length === 1 ? '' : 's'} staged` : 'Ready for commands, files, photos, documents, and approvals'}</small>
        </div>
        <div className="bob-command-actions">
          {bobMissionActions.map((action) => (
            <button key={action.label} type="button" onClick={() => requestMissionAction(action)} disabled={sending || !conversationId} title={action.prompt}>
              {action.kind === 'photo' ? <Image size={14} aria-hidden="true" /> : action.kind === 'approval' ? <ClipboardCheck size={14} aria-hidden="true" /> : <FileText size={14} aria-hidden="true" />}
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div ref={scrollRef} className="bob-message-list">
        {dragging && (
          <div className="bob-drop-target"><FileUp size={17} aria-hidden="true" /> Drop files for Bob to read.</div>
        )}
        {loading ? (
          <div className="bob-panel-empty"><Loader2 size={16} className="is-spinning" aria-hidden="true" /> Loading conversation...</div>
        ) : messages.length === 0 ? (
          <div className="bob-panel-empty">
            Ask Bob about what you're looking at.
          </div>
        ) : (
          messages.map((m) => {
            const choices = choicesFor(m);
            const artifacts = artifactsFor(m);
            const actions = actionsFor(m);
            return (
              <div
                key={m.id}
                className={`bob-message is-${m.role} ${artifacts.length ? 'has-artifacts' : ''}`}
              >
                <div className="bob-message-content">{m.content}</div>
                {artifacts.length > 0 && (
                  <div className="bob-artifact-grid" aria-label="Bob artifacts">
                    {artifacts.map((artifact, index) => {
                      const artifactKey = artifact.id ?? `${m.id}-artifact-${index}`;
                      const isPhoto = artifact.type === 'photo' || artifact.type === 'evidence';
                      const preview = artifact.previewUrl ?? artifact.url;
                      return (
                        <article key={artifactKey} className={`bob-artifact-card is-${artifact.type ?? 'document'}`}>
                          {isPhoto && preview ? (
                            <img src={preview} alt={artifact.title} />
                          ) : (
                            <div className="bob-artifact-icon">
                              {isPhoto ? <Image size={18} aria-hidden="true" /> : <FileText size={18} aria-hidden="true" />}
                            </div>
                          )}
                          <div>
                            <strong>{artifact.title}</strong>
                            <span>{artifact.status ?? 'ready'} · {artifact.type ?? 'document'}</span>
                            {artifact.summary && <p>{artifact.summary}</p>}
                          </div>
                          <button type="button" onClick={() => downloadArtifact(artifact)} disabled={sending || (!artifact.url && !artifact.previewUrl && !artifact.content && !artifact.summary)}>
                            <Download size={14} aria-hidden="true" />
                            <span>Open</span>
                          </button>
                        </article>
                      );
                    })}
                  </div>
                )}
                {actions.length > 0 && (
                  <div className="bob-inline-actions" aria-label="Bob actions">
                    {actions.map((action) => (
                      <button key={`${m.id}-${action.label}`} type="button" onClick={() => requestMissionAction(action)} disabled={sending} title={action.detail ?? action.prompt}>
                        <Sparkles size={13} aria-hidden="true" />
                        <span>{action.label}</span>
                      </button>
                    ))}
                  </div>
                )}
                {choices.length > 0 && (
                  <div className="bob-choice-list" aria-label="Select a recommendation">
                    {choices.map((choice) => (
                      <button
                        key={`${m.id}-${choice.value}`}
                        type="button"
                        className={`bob-choice is-${choice.state ?? 'qualified'}`}
                        onClick={() => chooseBobOption(choice)}
                        disabled={sending}
                        title={choice.detail ?? `Select ${choice.label}`}
                      >
                        <span>{choice.label}</span>
                        {choice.detail && <small>{choice.detail}</small>}
                      </button>
                    ))}
                  </div>
                )}
                {m.flagged && <div className="bob-message-flag">Flagged for review</div>}
              </div>
            );
          })
        )}
      </div>

      {pendingFiles.length > 0 && (
        <div className="bob-file-tray" aria-label="Attached files">
          {pendingFiles.map(item => (
            <button key={item.id} type="button" className={`bob-file-chip is-${item.status}`} onClick={() => setPendingFiles(current => current.filter(file => file.id !== item.id))} disabled={sending} title={item.error || 'Remove file'}>
              <FileUp size={13} aria-hidden="true" />
              <span>{item.file.name}</span>
              <small>{item.status}</small>
            </button>
          ))}
        </div>
      )}

      <form onSubmit={handleSend} className={`bob-composer ${pendingFiles.length > 0 ? 'has-files' : ''}`}>
        <input ref={fileInputRef} type="file" multiple accept={ACCEPTED_BOB_UPLOADS} onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.currentTarget.value = ''; }} className="sr-only" />
        <button type="button" className="bob-icon-button" onClick={() => fileInputRef.current?.click()} disabled={sending || !conversationId} aria-label="Attach files">
          <FileUp size={17} aria-hidden="true" />
        </button>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message Bob…"
          disabled={sending || !conversationId}
        />
        <button
          type="submit"
          className="bob-send-button"
          disabled={sending || (!input.trim() && pendingFiles.length === 0) || !conversationId}
        >
          {sending ? <Loader2 size={16} className="is-spinning" aria-hidden="true" /> : <SendHorizontal size={16} aria-hidden="true" />}
          <span>Send</span>
        </button>
      </form>
    </div>
  );
};

export default BobPanel;
