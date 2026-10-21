import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ListChecks, ChevronDown, ChevronRight, ExternalLink, FileDiff, FileText, GitPullRequest, Image as ImageIcon, Loader2, Lock, MonitorPlay, Paperclip, Plus, Send, Sparkles, SquareTerminal, Undo2, Wrench, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './BuilderVibePage.css';

export interface VibeSession {
  id: string;
  title: string;
  status: 'open' | 'working' | 'shipping' | 'shipped' | 'closed' | 'failed';
  branch: string | null;
  base_sha: string | null;
  head_sha: string | null;
  changed_files: string[];
  preview_requested: boolean;
  preview_status: 'off' | 'starting' | 'ready' | 'failed';
  preview_detail: string | null;
  pr_url: string | null;
  last_activity_at: string;
}

export interface VibeMessage {
  id: string;
  seq: number;
  session_id: string;
  role: 'owner' | 'bob' | 'system' | 'tool';
  kind: 'message' | 'thinking' | 'tool' | 'diff' | 'test' | 'preview' | 'error' | 'status';
  content: string;
  payload: Record<string, unknown>;
  status: 'queued' | 'claimed' | 'done' | 'failed' | null;
  created_at: string;
}

interface VibeAttachmentSummary {
  id: string;
  file_name: string;
  file_type: string;
  file_size_bytes: number;
  extraction_status: string;
}

interface PendingVibeAttachment {
  id: string;
  file: File;
  fileType: string;
  status: 'staged' | 'uploading' | 'extracting' | 'ready' | 'failed';
  storagePath?: string;
  registered?: boolean;
  error?: string;
}

type Access = 'checking' | 'allowed' | 'denied';

const PREVIEW_ORIGIN = (import.meta.env.VITE_BOB_VIBE_PREVIEW_ORIGIN as string | undefined) || 'https://bob.fcmanager.co.nz';
const SESSION_FIELDS = 'id, title, status, branch, base_sha, head_sha, changed_files, preview_requested, preview_status, preview_detail, pr_url, last_activity_at';
const VIBE_FILE_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain', md: 'text/plain', csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const VIBE_ACCEPTED_FILES = 'image/jpeg,image/png,image/webp,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const VIBE_MAX_FILES = 5;
const VIBE_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const VIBE_MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const STARTERS = [
  'Add a "last updated by" line under the vehicle profile header',
  'Explain how the Atlas gap report is built and where it is shown',
  'Make the Builder job list show the model that authored each job',
];

const STATUS_LABEL: Record<VibeSession['status'], string> = {
  open: 'Ready', working: 'Bob is working', shipping: 'Opening pull request', shipped: 'Pull request open', closed: 'Closed', failed: 'Needs attention',
};

function errorText(error: unknown): string {
  const message = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : String(error ?? 'Something went wrong');
  return /platform owner|42501|permission/i.test(message) ? 'Vibe building is limited to the platform owner (grand master).' : message;
}

function requestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function vibeFileType(file: File): string | null {
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  const expected = VIBE_FILE_TYPES[extension];
  if (!expected) return null;
  return file.type && VIBE_ACCEPTED_FILES.split(',').includes(file.type) && file.type !== expected ? null : expected;
}

/** Steps between two conversational messages collapse into one "Bob's steps" group. */
export function groupThread(messages: VibeMessage[]): Array<{ type: 'message'; message: VibeMessage } | { type: 'steps'; key: string; steps: VibeMessage[] }> {
  const out: Array<{ type: 'message'; message: VibeMessage } | { type: 'steps'; key: string; steps: VibeMessage[] }> = [];
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

function DiffBlock({ message }: { message: VibeMessage }) {
  const [open, setOpen] = useState(false);
  const diff = typeof message.payload.diff === 'string' ? message.payload.diff : '';
  const files = Array.isArray(message.payload.files) ? (message.payload.files as string[]) : [];
  return (
    <div className="vibe-diff">
      <button type="button" className="vibe-diff__head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        <FileDiff size={15} />
        <span>Changed {files.length} file{files.length === 1 ? '' : 's'}</span>
        <code>{String(message.payload.commit ?? '').slice(0, 8)}</code>
      </button>
      <ul className="vibe-diff__files">{files.map((file) => <li key={file}><code>{file}</code></li>)}</ul>
      {open && <pre className="vibe-diff__body" aria-label="Diff">{diff.split('\n').map((line, index) => (
        <span key={index} className={line.startsWith('+') && !line.startsWith('+++') ? 'is-add' : line.startsWith('-') && !line.startsWith('---') ? 'is-del' : line.startsWith('@@') ? 'is-hunk' : undefined}>{line}{'\n'}</span>
      ))}</pre>}
    </div>
  );
}

function StepsBlock({ steps, live }: { steps: VibeMessage[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const failed = steps.filter((step) => step.payload.ok === false).length;
  const last = steps[steps.length - 1];
  return (
    <div className="vibe-steps">
      <button type="button" className="vibe-steps__head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        <Wrench size={14} />
        <span>{steps.length} step{steps.length === 1 ? '' : 's'}{failed ? ` · ${failed} refused or failed` : ''}</span>
        {!open && <span className="vibe-steps__last">{live && <Loader2 size={13} className="vibe-spin" />}{last.content}</span>}
      </button>
      {open && <ol className="vibe-steps__list">{steps.map((step) => (
        <li key={step.id} className={step.payload.ok === false ? 'is-failed' : undefined}>
          <div className="vibe-steps__row">{step.kind === 'test' ? <SquareTerminal size={13} /> : <Wrench size={13} />}<span>{step.content}</span></div>
          {typeof step.payload.thought === 'string' && step.payload.thought && <p className="vibe-steps__thought">{step.payload.thought}</p>}
          {typeof step.payload.preview === 'string' && step.payload.preview && <pre className="vibe-steps__preview">{step.payload.preview}</pre>}
        </li>
      ))}</ol>}
    </div>
  );
}

function MessageBlock({ message }: { message: VibeMessage }) {
  if (message.kind === 'diff') return <DiffBlock message={message} />;
  const owner = message.role === 'owner';
  const system = message.role === 'system';
  const action = typeof message.payload.action === 'string' ? message.payload.action : 'message';
  const prUrl = typeof message.payload.pr_url === 'string' ? message.payload.pr_url : null;
  const attachments = Array.isArray(message.payload.attachments) ? message.payload.attachments as VibeAttachmentSummary[] : [];
  const attachmentContext = Array.isArray(message.payload.attachment_context) ? message.payload.attachment_context as Array<{ file_name?: string; context?: string }> : [];
  return (
    <div className={`vibe-msg vibe-msg--${message.role}${message.kind === 'error' ? ' is-error' : ''}`}>
      {!owner && !system && <span className="vibe-msg__avatar" aria-hidden="true"><Sparkles size={14} /></span>}
      <div className="vibe-msg__body">
        {owner && action !== 'message' ? <em>{action === 'ship' ? 'Ship this as a pull request' : 'Undo the last change'}</em> : <p>{message.content}</p>}
        {attachments.length > 0 && <ul className="vibe-msg__attachments">{attachments.map((attachment) => (
          <li key={attachment.id}>{attachment.file_type.startsWith('image/') ? <ImageIcon size={13} /> : <FileText size={13} />}<span>{attachment.file_name}</span></li>
        ))}</ul>}
        {attachmentContext.length > 0 && <details className="vibe-msg__attachment-context">
          <summary>Local attachment analysis</summary>
          {attachmentContext.map((item, index) => <p key={`${item.file_name || 'attachment'}-${index}`}>{item.context}</p>)}
        </details>}
        {prUrl && <a href={prUrl} target="_blank" rel="noreferrer" className="vibe-msg__link"><GitPullRequest size={14} />Open pull request</a>}
        {owner && message.status && message.status !== 'done' && <span className={`vibe-msg__state is-${message.status}`}>{message.status === 'queued' ? 'Waiting for Bob' : message.status === 'claimed' ? 'Bob is on it' : 'Not processed — send it again'}</span>}
      </div>
    </div>
  );
}

export default function BuilderVibePage({ onOpenJobs }: { onOpenJobs?: () => void } = {}) {
  const { profile } = useAuth();
  const [access, setAccess] = useState<Access>('checking');
  const [sessions, setSessions] = useState<VibeSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<VibeMessage[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [loadingThread, setLoadingThread] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<PendingVibeAttachment[]>([]);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<'chat' | 'preview'>('chat');
  const threadEnd = useRef<HTMLDivElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const selected = useMemo(() => sessions.find((session) => session.id === selectedId) ?? null, [sessions, selectedId]);
  const working = selected?.status === 'working' || selected?.status === 'shipping' || messages.some((message) => message.role === 'owner' && (message.status === 'queued' || message.status === 'claimed'));
  const thread = useMemo(() => groupThread(messages), [messages]);

  const loadSessions = useCallback(async () => {
    const { data, error: loadError } = await supabase.from('builder_vibe_sessions').select(SESSION_FIELDS).neq('status', 'closed').order('last_activity_at', { ascending: false }).limit(50);
    setLoadingSessions(false);
    if (loadError) { setError(errorText(loadError)); return; }
    const rows = (data ?? []) as VibeSession[];
    setSessions(rows);
    setSelectedId((current) => current && rows.some((row) => row.id === current) ? current : rows[0]?.id ?? null);
  }, []);

  const loadThread = useCallback(async (sessionId: string) => {
    const { data, error: loadError } = await supabase.from('builder_vibe_messages').select('id, seq, session_id, role, kind, content, payload, status, created_at').eq('session_id', sessionId).order('seq', { ascending: true }).limit(600);
    setLoadingThread(false);
    if (loadError) { setError(errorText(loadError)); return; }
    setMessages((data ?? []) as VibeMessage[]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error: roleError } = await supabase.rpc('is_grand_master');
      if (cancelled) return;
      if (roleError || data !== true) { setAccess('denied'); setLoadingSessions(false); return; }
      setAccess('allowed');
      await loadSessions();
    })();
    return () => { cancelled = true; };
  }, [loadSessions]);

  useEffect(() => {
    if (access !== 'allowed') return undefined;
    const channel = supabase.channel('builder-vibe-sessions')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'builder_vibe_sessions' }, () => void loadSessions())
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [access, loadSessions]);

  useEffect(() => {
    setPreviewSrc(null);
    if (!selectedId) { setMessages([]); return undefined; }
    setLoadingThread(true);
    void loadThread(selectedId);
    const channel = supabase.channel(`builder-vibe-${selectedId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'builder_vibe_messages', filter: `session_id=eq.${selectedId}` }, (change) => {
        const row = change.new as VibeMessage | undefined;
        if (!row?.id) return;
        setMessages((current) => {
          const index = current.findIndex((message) => message.id === row.id);
          if (index === -1) return [...current, row].sort((a, b) => a.seq - b.seq);
          const next = current.slice();
          next[index] = { ...current[index], ...row };
          return next;
        });
      })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [selectedId, loadThread]);

  useEffect(() => { threadEnd.current?.scrollIntoView?.({ block: 'end' }); }, [messages.length]);

  const run = useCallback(async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try { await action(); } catch (caught) { setError(errorText(caught)); } finally { setBusy(null); }
  }, []);

  const newSession = (title?: string) => run('new', async () => {
    if (attachments.length) throw new Error('Send or remove the staged attachments before starting another session.');
    const { data, error: openError } = await supabase.rpc('builder_vibe_session_open', { p_title: title || null });
    if (openError) throw openError;
    await loadSessions();
    setSelectedId(String(data));
  });

  const updateAttachment = (id: string, patch: Partial<PendingVibeAttachment>) => {
    setAttachments(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
  };

  const addFiles = (fileList: FileList | null) => {
    if (!fileList?.length) return;
    if (!selected || selected.status === 'closed') { setError('Open a Vibe session before attaching files.'); return; }
    const files = Array.from(fileList);
    if (attachments.length + files.length > VIBE_MAX_FILES) { setError(`Attach up to ${VIBE_MAX_FILES} files to one message.`); return; }
    const staged: PendingVibeAttachment[] = [];
    for (const file of files) {
      const fileType = vibeFileType(file);
      if (!fileType) { setError(`${file.name} is not a supported Vibe attachment type.`); return; }
      const limit = fileType.startsWith('image/') ? VIBE_MAX_IMAGE_BYTES : VIBE_MAX_DOCUMENT_BYTES;
      if (file.size <= 0 || file.size > limit) { setError(`${file.name} exceeds the ${fileType.startsWith('image/') ? '10 MB image' : '20 MB document'} limit.`); return; }
      staged.push({ id: crypto.randomUUID(), file, fileType, status: 'staged' });
    }
    setError(null);
    setAttachments(current => [...current, ...staged]);
  };

  const prepareAttachment = async (pending: PendingVibeAttachment): Promise<PendingVibeAttachment> => {
    if (!selected || !profile?.id) throw new Error('Your owner profile is not ready for Vibe uploads.');
    let current = pending;
    if (!current.registered) {
      const safeName = current.file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-180) || 'upload.bin';
      const storagePath = `desktop/${profile.id}/vibe/${selected.id}/${current.id}-${safeName}`;
      updateAttachment(current.id, { status: 'uploading', error: undefined });
      const { error: uploadError } = await supabase.storage.from('bob-uploads').upload(storagePath, current.file, { contentType: current.fileType, upsert: false });
      if (uploadError) throw uploadError;
      const { error: registerError } = await supabase.rpc('builder_vibe_attachment_register', {
        p_session_id: selected.id,
        p_attachment_id: current.id,
        p_file_name: current.file.name,
        p_file_type: current.fileType,
        p_file_size_bytes: current.file.size,
        p_storage_path: storagePath,
      });
      if (registerError) {
        await supabase.storage.from('bob-uploads').remove([storagePath]);
        throw registerError;
      }
      current = { ...current, storagePath, registered: true };
      updateAttachment(current.id, { storagePath, registered: true });
    }
    if (!current.fileType.startsWith('image/')) {
      updateAttachment(current.id, { status: 'extracting', error: undefined });
      const { data, error: extractionError } = await supabase.functions.invoke('bob-extract-document', {
        body: { file_name: current.file.name, storage_bucket: 'bob-uploads', storage_path: current.storagePath },
      });
      if (extractionError) throw extractionError;
      if (!data?.success || typeof data.text !== 'string' || typeof data.checksum !== 'string') {
        throw new Error(`Local extraction could not read ${current.file.name}.`);
      }
      const extractedText = data.text.slice(0, 200000);
      const extractionStatus = data.has_text ? 'extracted' : 'empty';
      const { error: saveError } = await supabase.rpc('builder_vibe_attachment_set_extraction', {
        p_session_id: selected.id,
        p_attachment_id: current.id,
        p_extracted_text: extractedText,
        p_sha256: data.checksum,
        p_extraction_status: extractionStatus,
      });
      if (saveError) throw saveError;
    }
    current = { ...current, status: 'ready', error: undefined };
    updateAttachment(current.id, { status: 'ready', error: undefined });
    return current;
  };

  const removeAttachment = (attachment: PendingVibeAttachment) => run(`remove-${attachment.id}`, async () => {
    if (attachment.registered && attachment.storagePath && selected) {
      const { error: removeError } = await supabase.storage.from('bob-uploads').remove([attachment.storagePath]);
      if (removeError) throw removeError;
      const { error: deleteError } = await supabase.rpc('builder_vibe_attachment_delete', { p_session_id: selected.id, p_attachment_id: attachment.id });
      if (deleteError) throw deleteError;
    }
    setAttachments(current => current.filter(item => item.id !== attachment.id));
  });

  const send = (action: 'message' | 'ship' | 'revert', text = '') => {
    if (!selected) return;
    void run(action, async () => {
      if (action === 'message') {
        const ready: PendingVibeAttachment[] = [];
        for (const attachment of attachments) {
          try { ready.push(await prepareAttachment(attachment)); }
          catch (caught) {
            const message = caught instanceof Error ? caught.message : 'Attachment processing failed.';
            updateAttachment(attachment.id, { status: 'failed', error: message });
            throw caught;
          }
        }
        const content = text || (ready.length ? 'Please inspect the attached files and use them as context.' : '');
        const { error: sendError } = await supabase.rpc('builder_vibe_send_with_attachments', {
          p_session_id: selected.id,
          p_content: content,
          p_client_request_id: requestId(),
          p_attachment_ids: ready.map(item => item.id),
        });
        if (sendError) throw sendError;
        setDraft('');
        setAttachments([]);
        if (fileInput.current) fileInput.current.value = '';
        return;
      }
      const { error: sendError } = await supabase.rpc('builder_vibe_send', { p_session_id: selected.id, p_content: text, p_client_request_id: requestId(), p_action: action });
      if (sendError) throw sendError;
    });
  };

  const submit = (event?: React.FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if ((!text && !attachments.length) || !selected || busy) return;
    send('message', text);
  };

  const togglePreview = () => {
    if (!selected) return;
    void run('preview', async () => {
      const { error: previewError } = await supabase.rpc('builder_vibe_set_preview', { p_session_id: selected.id, p_on: !selected.preview_requested });
      if (previewError) throw previewError;
      if (selected.preview_requested) setPreviewSrc(null);
    });
  };

  const openPreview = (newTab: boolean) => {
    if (!selected) return;
    void run('ticket', async () => {
      const { data, error: ticketError } = await supabase.rpc('builder_vibe_preview_ticket', { p_session_id: selected.id });
      if (ticketError) throw ticketError;
      const url = `${PREVIEW_ORIGIN}/vibe/${selected.id}/__open?ticket=${encodeURIComponent(String(data))}`;
      if (newTab) window.open(url, '_blank', 'noopener');
      else setPreviewSrc(url);
    });
  };

  const closeSession = () => {
    if (!selected || attachments.length || !window.confirm(`Close "${selected.title}"? The branch and any pull request stay on GitHub.`)) return;
    void run('close', async () => {
      const { error: closeError } = await supabase.rpc('builder_vibe_session_close', { p_session_id: selected.id });
      if (closeError) throw closeError;
      await loadSessions();
    });
  };

  if (access === 'checking') return <div className="vibe-page vibe-page--state" role="status"><Loader2 className="vibe-spin" size={20} />Checking access…</div>;
  if (access === 'denied') {
    return (
      <div className="vibe-page vibe-page--state">
        <Lock size={22} />
        <h1>Vibe Builder</h1>
        <p>Vibe building changes the platform's own code, so it is limited to the platform owner (grand master). Ask the owner to make the change, or review Builder jobs and approvals.</p>
        {onOpenJobs && <button type="button" className="vibe-btn" onClick={onOpenJobs}><ListChecks size={15} />Jobs &amp; approvals</button>}
      </div>
    );
  }

  const hasChanges = Boolean(selected?.changed_files?.length);
  return (
    <div className={`vibe-page is-${mobilePane}`}>
      <aside className="vibe-rail" aria-label="Vibe sessions">
        <div className="vibe-rail__head">
          <h1><Sparkles size={18} />Vibe Builder</h1>
          <button type="button" className="vibe-btn vibe-btn--primary" onClick={() => void newSession()} disabled={busy === 'new' || attachments.length > 0}><Plus size={15} />New</button>
        </div>
        {loadingSessions ? <p className="vibe-muted" role="status">Loading sessions…</p>
          : sessions.length === 0 ? <p className="vibe-muted">No sessions yet. Start one and describe what you want built.</p>
            : <ul className="vibe-rail__list">{sessions.map((session) => (
              <li key={session.id}>
                <button type="button" className={`vibe-rail__item${session.id === selectedId ? ' is-active' : ''}`} aria-current={session.id === selectedId} onClick={() => { if (attachments.length) setError('Send or remove the staged attachments before switching sessions.'); else setSelectedId(session.id); }}>
                  <span className="vibe-rail__title">{session.title}</span>
                  <span className={`vibe-pill is-${session.status}`}>{STATUS_LABEL[session.status]}</span>
                  <span className="vibe-rail__meta">{session.changed_files?.length ? `${session.changed_files.length} file${session.changed_files.length === 1 ? '' : 's'} changed` : 'No changes yet'}</span>
                </button>
              </li>
            ))}</ul>}
        {onOpenJobs && <div className="vibe-rail__foot"><button type="button" className="vibe-btn vibe-btn--ghost" onClick={onOpenJobs}><ListChecks size={15} />Jobs &amp; approvals</button></div>}
      </aside>

      <section className="vibe-chat" aria-label="Conversation with Bob">
        {error && <div className="vibe-alert" role="alert"><AlertTriangle size={16} /><span>{error}</span><button type="button" aria-label="Dismiss" onClick={() => setError(null)}><X size={14} /></button></div>}
        {!selected ? (
          <div className="vibe-empty">
            <Sparkles size={28} />
            <h2>Describe it. Bob builds it.</h2>
            <p>Each session is one branch from main. Bob reads the code and the live Atlas, makes the change, runs the tests, and shows you the diff and a live preview. Nothing ships until you ask for a pull request.</p>
            <div className="vibe-starters">{STARTERS.map((starter) => <button key={starter} type="button" className="vibe-chip" onClick={() => void newSession(starter.slice(0, 80))}>{starter}</button>)}</div>
          </div>
        ) : (
          <>
            <header className="vibe-chat__head">
              <div>
                <h2>{selected.title}</h2>
                <p className="vibe-muted">{selected.branch ? <code>{selected.branch}</code> : 'Branch is created from main on your first message'}{selected.head_sha && selected.base_sha && selected.head_sha !== selected.base_sha ? ` · ${selected.changed_files.length} file(s) changed` : ''}</p>
              </div>
              <div className="vibe-chat__actions">
                <button type="button" className="vibe-btn" onClick={() => send('revert')} disabled={!hasChanges || working || Boolean(busy) || attachments.length > 0} title="Undo Bob's last change"><Undo2 size={15} />Undo</button>
                <button type="button" className="vibe-btn vibe-btn--primary" onClick={() => send('ship')} disabled={!hasChanges || working || Boolean(busy) || attachments.length > 0}><GitPullRequest size={15} />{selected.pr_url ? 'Update PR' : 'Ship as PR'}</button>
                {selected.pr_url && <a className="vibe-btn" href={selected.pr_url} target="_blank" rel="noreferrer"><ExternalLink size={15} />PR</a>}
                <button type="button" className="vibe-btn vibe-btn--ghost" onClick={closeSession} aria-label="Close session" disabled={attachments.length > 0}><X size={15} /></button>
                <button type="button" className="vibe-btn vibe-only-mobile" onClick={() => setMobilePane('preview')}><MonitorPlay size={15} />Preview</button>
              </div>
            </header>
            <div className="vibe-thread" aria-live="polite" aria-busy={loadingThread}>
              {loadingThread && <p className="vibe-muted" role="status">Loading conversation…</p>}
              {thread.map((item, index) => item.type === 'steps'
                ? <StepsBlock key={item.key} steps={item.steps} live={working && index === thread.length - 1} />
                : <MessageBlock key={item.message.id} message={item.message} />)}
              {working && <div className="vibe-working" role="status"><Loader2 size={15} className="vibe-spin" />{STATUS_LABEL[selected.status === 'shipping' ? 'shipping' : 'working']}…</div>}
              <div ref={threadEnd} />
            </div>
            <form className="vibe-composer" onSubmit={submit}>
              <input ref={fileInput} className="vibe-sr-only" type="file" multiple accept={VIBE_ACCEPTED_FILES} aria-label="Attach screenshots or documents" onChange={(event) => { addFiles(event.currentTarget.files); event.currentTarget.value = ''; }} />
              {attachments.length > 0 && <ul className="vibe-composer__attachments" aria-label="Attachments ready for Bob">
                {attachments.map((attachment) => (
                  <li key={attachment.id}>
                    {attachment.fileType.startsWith('image/') ? <ImageIcon size={14} /> : <FileText size={14} />}
                    <span>{attachment.file.name}</span>
                    <small>{attachment.status === 'ready' ? 'Ready' : attachment.status === 'failed' ? attachment.error || 'Failed' : attachment.status === 'extracting' ? 'Extracting text…' : attachment.status === 'uploading' ? 'Uploading…' : 'Queued'}</small>
                    <button type="button" aria-label={`Remove ${attachment.file.name}`} onClick={() => void removeAttachment(attachment)} disabled={Boolean(busy)}><X size={13} /></button>
                  </li>
                ))}
              </ul>}
              <label htmlFor="vibe-input" className="vibe-sr-only">Tell Bob what to build</label>
              <textarea
                id="vibe-input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); } }}
                placeholder={working ? 'Bob is working — your next message will queue behind this one' : 'Describe the change, ask a question, or say "continue"…'}
                rows={3}
                maxLength={20000}
                disabled={selected.status === 'closed'}
              />
              <button type="button" className="vibe-btn" onClick={() => fileInput.current?.click()} disabled={selected.status === 'closed' || attachments.length >= VIBE_MAX_FILES || Boolean(busy)} aria-label="Attach screenshot or document"><Paperclip size={15} />Attach</button>
              <button type="submit" className="vibe-btn vibe-btn--primary" disabled={(!draft.trim() && !attachments.length) || Boolean(busy)} aria-label="Send"><Send size={15} />Send</button>
              <p className="vibe-composer__notice">Private session files only · images are analyzed on local Ollama · documents are text-extracted · nothing is registered as a business record.</p>
            </form>
          </>
        )}
      </section>

      <section className="vibe-preview" aria-label="Live preview">
        <header className="vibe-preview__head">
          <h2><MonitorPlay size={16} />Live preview</h2>
          <button type="button" className="vibe-btn vibe-only-mobile" onClick={() => setMobilePane('chat')}>Back to chat</button>
          {selected && <label className="vibe-switch">
            <input type="checkbox" checked={selected.preview_requested} onChange={togglePreview} disabled={busy === 'preview' || selected.status === 'closed'} />
            <span>{selected.preview_requested ? 'On' : 'Off'}</span>
          </label>}
        </header>
        {!selected ? <p className="vibe-muted">Select a session to preview its branch.</p>
          : !selected.preview_requested ? <div className="vibe-preview__note"><p>Turn the preview on to run this session's branch in a dev server. It updates as Bob edits.</p><p className="vibe-muted">The preview uses the live database, like any preview deployment: sign in with your own account and treat writes as real.</p></div>
            : selected.preview_status === 'failed' ? <div className="vibe-preview__note is-error" role="alert"><AlertTriangle size={16} /><p>{selected.preview_detail || 'The preview could not start.'}</p><p className="vibe-muted">Turn it off and on again to retry.</p></div>
              : selected.preview_status !== 'ready' ? <div className="vibe-preview__note" role="status"><Loader2 size={16} className="vibe-spin" /><p>{selected.preview_detail || 'Starting the dev server…'}</p></div>
                : previewSrc ? <>
                  <div className="vibe-preview__bar"><button type="button" className="vibe-btn" onClick={() => openPreview(true)}><ExternalLink size={14} />New tab</button></div>
                  <iframe className="vibe-preview__frame" title={`Preview of ${selected.title}`} src={previewSrc} sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads" />
                </>
                  : <div className="vibe-preview__note"><p>The dev server is running.</p><div className="vibe-chat__actions"><button type="button" className="vibe-btn vibe-btn--primary" onClick={() => openPreview(false)} disabled={busy === 'ticket'}><MonitorPlay size={15} />Show here</button><button type="button" className="vibe-btn" onClick={() => openPreview(true)}><ExternalLink size={15} />Open in new tab</button></div></div>}
      </section>
    </div>
  );
}
