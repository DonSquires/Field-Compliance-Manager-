import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ListChecks, ChevronDown, ChevronRight, ExternalLink, FileDiff, FileText, GitPullRequest, Image as ImageIcon, Loader2, Lock, MonitorPlay, Paperclip, Plus, RefreshCw, Send, Sparkles, SquareTerminal, Undo2, Wrench, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { githubChecksUrl } from '../lib/githubLinks';
import './BuilderVibePage.css';

export interface VibeSession {
  id: string;
  human_reference?: string | null;
  created_by?: string;
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
  updated_at: string;
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
type PendingMessageChange = { kind: 'INSERT' | 'UPDATE'; row: VibeMessage } | null;
type SessionRename = { revision: number; title: string; updatedAt: bigint };

const PREVIEW_ORIGIN = (import.meta.env.VITE_BOB_VIBE_PREVIEW_ORIGIN as string | undefined) || 'https://bob.fcmanager.co.nz';
const SESSION_FIELDS = 'id, human_reference, created_by, title, status, branch, base_sha, head_sha, changed_files, preview_requested, preview_status, preview_detail, pr_url, last_activity_at, updated_at';
const MESSAGE_FIELDS = 'id, seq, session_id, role, kind, content, payload, status, created_at';
const SESSION_PAGE_SIZE = 50;
const MESSAGE_PAGE_SIZE = 100;
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

function preserveNewerSessionName(session: VibeSession, started: ReadonlyMap<string, SessionRename>, latest: ReadonlyMap<string, SessionRename>) {
  const rename = latest.get(session.id);
  return rename && rename.revision !== (started.get(session.id)?.revision ?? 0) ? { ...session, title: rename.title } : session;
}

function timestampMicros(value: string): bigint | null {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const fraction = (/\.(\d+)/.exec(value)?.[1] ?? '').padEnd(6, '0');
  return BigInt(milliseconds) * 1000n + BigInt(fraction.slice(3, 6));
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

function mergeSessions(existing: VibeSession[], incoming: VibeSession[]): VibeSession[] {
  const rows = new Map(existing.map((session) => [session.id, session]));
  for (const session of incoming) rows.set(session.id, session);
  return [...rows.values()]
    .filter((session) => session.status !== 'closed')
    .sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at) || b.id.localeCompare(a.id));
}

function mergeClosedHistory(existing: VibeSession[], incoming: VibeSession[]): VibeSession[] {
  const rows = new Map(existing.map((session) => [session.id, session]));
  for (const session of incoming) rows.set(session.id, session);
  return [...rows.values()]
    .filter((session) => session.status === 'closed')
    .sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at) || b.id.localeCompare(a.id));
}

function mergeMessages(existing: VibeMessage[], incoming: VibeMessage[]): VibeMessage[] {
  const rows = new Map(existing.map((message) => [message.id, message]));
  for (const message of incoming) rows.set(message.id, message);
  return [...rows.values()].sort((a, b) => a.seq - b.seq);
}

function threadScrollContainer(thread: HTMLElement): HTMLElement {
  if (thread.clientHeight > 0 && thread.scrollHeight > thread.clientHeight) return thread;
  for (let parent = thread.parentElement; parent && parent !== document.body && parent !== document.documentElement; parent = parent.parentElement) {
    if (parent.scrollHeight > parent.clientHeight && /^(auto|scroll|overlay)$/.test(window.getComputedStyle(parent).overflowY)) return parent;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

function isNearThreadEnd(thread: HTMLElement, end: HTMLElement): boolean {
  const container = threadScrollContainer(thread);
  const viewportTop = container === document.scrollingElement
    ? 0 : Math.max(0, container.getBoundingClientRect().top);
  const viewportBottom = container === document.scrollingElement
    ? window.innerHeight : Math.min(window.innerHeight, container.getBoundingClientRect().bottom);
  const endTop = end.getBoundingClientRect().top;
  return endTop >= viewportTop - 120 && endTop <= viewportBottom + 120;
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

function StepsBlock({ steps, live, open, onToggle }: { steps: VibeMessage[]; live: boolean; open: boolean; onToggle: () => void }) {
  const failed = steps.filter((step) => step.payload.ok === false).length;
  const last = steps[steps.length - 1];
  return (
    <div className="vibe-steps">
      <button type="button" className="vibe-steps__head" aria-expanded={open} onClick={onToggle}>
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

function MessageBlock({ message, branch }: { message: VibeMessage; branch?: string | null }) {
  if (message.kind === 'diff') return <DiffBlock message={message} />;
  const owner = message.role === 'owner';
  const system = message.role === 'system';
  const action = typeof message.payload.action === 'string' ? message.payload.action : 'message';
  const prUrl = typeof message.payload.pr_url === 'string' ? message.payload.pr_url : null;
  const checksUrl = githubChecksUrl(prUrl, branch);
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
        {owner && attachments.length > 0 && <span className="vibe-msg__state">
          {message.payload.external_attachment_consent === true
            ? 'Attachment context: Ollama Cloud permitted for this message; raw files stay private.'
            : 'Attachment context: local models only.'}
        </span>}
        {attachmentContext.length > 0 && <details className="vibe-msg__attachment-context">
          <summary>Local attachment analysis</summary>
          {attachmentContext.map((item, index) => <p key={`${item.file_name || 'attachment'}-${index}`}>{item.context}</p>)}
        </details>}
        {prUrl && <a href={prUrl} target="_blank" rel="noreferrer" className="vibe-msg__link"><GitPullRequest size={14} />Open pull request</a>}
        {checksUrl && <a href={checksUrl} target="_blank" rel="noreferrer" className="vibe-msg__link"><ListChecks size={14} />GitHub Actions checks</a>}
        {owner && message.status && message.status !== 'done' && <span className={`vibe-msg__state is-${message.status}`}>{message.status === 'queued' ? 'Waiting for Bob' : message.status === 'claimed' ? 'Bob is on it' : attachmentContext.length ? 'Coding turn stopped after attachment analysis — see Bob’s error below. Continue with a new message; these files remain in session history.' : 'Turn failed — see Bob’s error below.'}</span>}
      </div>
    </div>
  );
}

export default function BuilderVibePage({ onOpenJobs }: { onOpenJobs?: () => void } = {}) {
  const { profile } = useAuth();
  const [access, setAccess] = useState<Access>('checking');
  const [sessions, setSessions] = useState<VibeSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  const [messages, setMessages] = useState<VibeMessage[]>([]);
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [loadingThread, setLoadingThread] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [draftTitles, setDraftTitles] = useState<Record<string, string>>({});
  const [renameDrafts, setRenameDrafts] = useState<Record<string, { expected: string; value: string }>>({});
  const [renameNotice, setRenameNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<PendingVibeAttachment[]>([]);
  const [attachmentSessionId, setAttachmentSessionId] = useState<string | null>(null);
  const [recoveryDismissed, setRecoveryDismissed] = useState(false);
  const [allowCloudAttachments, setAllowCloudAttachments] = useState(false);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<'chat' | 'preview'>('chat');
  const [hasMoreSessions, setHasMoreSessions] = useState(false);
  const [loadingMoreSessions, setLoadingMoreSessions] = useState(false);
  const [closedVisible, setClosedVisible] = useState(false);
  const [closedHistory, setClosedHistory] = useState<VibeSession[]>([]);
  const [closedHistoryLoading, setClosedHistoryLoading] = useState(false);
  const [closedHistoryError, setClosedHistoryError] = useState<string | null>(null);
  const [hasMoreClosedHistory, setHasMoreClosedHistory] = useState(false);
  const [sessionSearch, setSessionSearch] = useState('');
  const [sessionSearchResults, setSessionSearchResults] = useState<VibeSession[]>([]);
  const [sessionSearchLoading, setSessionSearchLoading] = useState(false);
  const [sessionSearchError, setSessionSearchError] = useState<string | null>(null);
  const [sessionSearchComplete, setSessionSearchComplete] = useState(false);
  const [hasMoreSessionSearch, setHasMoreSessionSearch] = useState(false);
  const [sessionLoadFailed, setSessionLoadFailed] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [olderSessionError, setOlderSessionError] = useState<string | null>(null);
  const [sessionsReload, setSessionsReload] = useState(0);
  const [sessionsLiveWarning, setSessionsLiveWarning] = useState<string | null>(null);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingMoreMessages, setLoadingMoreMessages] = useState(false);
  const [threadLoadFailed, setThreadLoadFailed] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [olderMessageError, setOlderMessageError] = useState<string | null>(null);
  const [threadReload, setThreadReload] = useState(0);
  const [liveWarning, setLiveWarning] = useState<string | null>(null);
  const sessionRequest = useRef(0);
  const sessionGeneration = useRef(0);
  const sessionLoading = useRef(false);
  const sessionRefreshQueued = useRef(false);
  const sessionReconcileNeeded = useRef(false);
  const sessionSubscribed = useRef(false);
  const sessionChangesDuringLoad = useRef(new Set<string>());
  const loadedSessionIds = useRef(new Set<string>());
  const loadedOlderSessions = useRef(false);
  const sessionCursor = useRef<Pick<VibeSession, 'id' | 'last_activity_at'> | null>(null);
  const closedSessions = useRef(new Set<string>());
  const closedHistoryRequest = useRef(0);
  const closedHistoryFetching = useRef(false);
  const closedHistoryChanges = useRef(new Map<string, VibeSession | null>());
  const closedHistoryCursor = useRef<Pick<VibeSession, 'id' | 'last_activity_at'> | null>(null);
  const sessionSearchRequest = useRef(0);
  const sessionSearchCursor = useRef<Pick<VibeSession, 'id' | 'last_activity_at'> | null>(null);
  const threadRequest = useRef(0);
  const threadSession = useRef<string | null>(null);
  const threadFetching = useRef(false);
  const threadConnected = useRef(false);
  const threadHistoryMayHaveGaps = useRef(false);
  const pendingMessageChanges = useRef(new Map<string, PendingMessageChange>());
  const oldestMessageSeq = useRef<number | null>(null);
  const scrollSnapshot = useRef<{ sessionId: string; container: HTMLElement; top: number; height: number } | null>(null);
  const lastScrolled = useRef<{ sessionId: string | null; seq: number | null }>({ sessionId: null, seq: null });
  const followLive = useRef(true);
  const draftVersions = useRef(new Map<string, number>());
  const sessionInvalidations = useRef(new Map<string, number>());
  const sessionRenames = useRef(new Map<string, SessionRename>());
  const attachmentSelectionVersion = useRef(0);
  const pendingSendRequests = useRef(new Map<string, string>());
  const busyActions = useRef(new Map<symbol, string>());
  const threadContainer = useRef<HTMLDivElement | null>(null);
  const threadEnd = useRef<HTMLDivElement | null>(null);
  const messagesRef = useRef<VibeMessage[]>([]);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const composer = useRef<HTMLFormElement | null>(null);
  const recovery = useRef<HTMLDivElement | null>(null);

  const selected = useMemo(() => sessions.find((session) => session.id === selectedId)
    ?? closedHistory.find((session) => session.id === selectedId) ?? null, [sessions, closedHistory, selectedId]);
  const draft = selectedId ? drafts[selectedId] ?? '' : '';
  const isBusy = busy.size > 0;
  const setDraft = (value: string) => {
    if (selectedId) {
      draftVersions.current.set(selectedId, (draftVersions.current.get(selectedId) ?? 0) + 1);
      setDrafts((current) => ({ ...current, [selectedId]: value }));
      if (selected) setDraftTitles((current) => ({ ...current, [selectedId]: selected.title }));
    }
  };
  const detachedDrafts = Object.entries(drafts).filter(([id, value]) => value.trim() && !sessions.some((session) => session.id === id));
  const detachedAttachments = attachments.length > 0 && (attachmentSessionId !== selected?.id || selected?.status === 'closed');
  const working = selected?.status === 'working' || selected?.status === 'shipping' || messages.some((message) => message.role === 'owner' && (message.status === 'queued' || message.status === 'claimed'));
  const thread = useMemo(() => groupThread(messages), [messages]);

  useEffect(() => {
    if (detachedDrafts.length || detachedAttachments) setRecoveryDismissed(false);
  }, [detachedDrafts.length, detachedAttachments]);

  const restartSessionPaging = useCallback(() => {
    loadedOlderSessions.current = false;
    sessionCursor.current = null;
  }, []);

  const invalidateSession = useCallback((id: string) => {
    sessionInvalidations.current.set(id, (sessionInvalidations.current.get(id) ?? 0) + 1);
  }, []);

  const loadSessions = useCallback(async (reconcile = false) => {
    if (reconcile) sessionReconcileNeeded.current = true;
    if (sessionLoading.current) {
      sessionRefreshQueued.current = true;
      return;
    }
    const checkClosed = sessionReconcileNeeded.current;
    sessionReconcileNeeded.current = false;
    sessionLoading.current = true;
    sessionChangesDuringLoad.current.clear();
    const request = ++sessionRequest.current;
    const renamesAtStart = new Map(sessionRenames.current);
    const knownSessionIds = checkClosed ? [...loadedSessionIds.current] : [];
    try {
      const { data, error: loadError } = await supabase.from('builder_vibe_sessions').select(SESSION_FIELDS).neq('status', 'closed')
        .order('last_activity_at', { ascending: false }).order('id', { ascending: false }).limit(SESSION_PAGE_SIZE + 1);
      if (request !== sessionRequest.current) return;
      if (loadError) throw loadError;
      const unavailableIds: string[] = [];
      const refreshedKnown: VibeSession[] = [];
      for (let index = 0; index < knownSessionIds.length; index += SESSION_PAGE_SIZE) {
        const ids = knownSessionIds.slice(index, index + SESSION_PAGE_SIZE);
        const { data: known, error: knownError } = await supabase.from('builder_vibe_sessions').select(SESSION_FIELDS)
          .in('id', ids).limit(ids.length);
        if (request !== sessionRequest.current) return;
        if (knownError) throw knownError;
        const knownRows = ((known ?? []) as VibeSession[]).map((row) => preserveNewerSessionName(row, renamesAtStart, sessionRenames.current));
        const statusById = new Map(knownRows.map((row) => [row.id, row.status]));
        unavailableIds.push(...ids.filter((id) => !statusById.has(id) || statusById.get(id) === 'closed'));
        refreshedKnown.push(...knownRows.filter((row) => row.status !== 'closed'));
      }
      const changed = new Set(sessionChangesDuringLoad.current);
      const confirmedClosed = new Set(unavailableIds.filter((id) => !changed.has(id)));
      for (const id of confirmedClosed) {
        invalidateSession(id);
        closedSessions.current.add(id);
        loadedSessionIds.current.delete(id);
      }
      const result = ((data ?? []) as VibeSession[]).map((row) => preserveNewerSessionName(row, renamesAtStart, sessionRenames.current));
      const rows = result.slice(0, SESSION_PAGE_SIZE).filter((row) => !closedSessions.current.has(row.id));
      for (const row of rows) loadedSessionIds.current.add(row.id);
      setSessions((current) => mergeSessions(
        mergeSessions(current.filter((row) => !confirmedClosed.has(row.id)), rows.filter((row) => !changed.has(row.id))),
        refreshedKnown.filter((row) => !changed.has(row.id)),
      ));
      if (!loadedOlderSessions.current) {
        sessionCursor.current = result.slice(0, SESSION_PAGE_SIZE).at(-1) ?? null;
        setHasMoreSessions(result.length > SESSION_PAGE_SIZE);
      }
      setSelectedId((current) => current && confirmedClosed.has(current) ? null : current);
      setSessionLoadFailed(false);
      setSessionError(null);
    } catch (caught) {
      if (request !== sessionRequest.current) return;
      if (checkClosed) sessionReconcileNeeded.current = true;
      setSessionLoadFailed(true);
      setSessionError(errorText(caught));
    } finally {
      if (request === sessionRequest.current) {
        sessionLoading.current = false;
        setLoadingSessions(false);
        if (sessionRefreshQueued.current) {
          sessionRefreshQueued.current = false;
          void loadSessions();
        }
      }
    }
  }, [invalidateSession]);

  useEffect(() => {
    if (!loadingSessions && !selectedId && sessions.length) setSelectedId(sessions[0].id);
  }, [loadingSessions, selectedId, sessions]);

  const loadOlderSessions = useCallback(async () => {
    const cursor = sessionCursor.current;
    if (!cursor || loadingMoreSessions) return;
    const generation = sessionGeneration.current;
    const renamesAtStart = new Map(sessionRenames.current);
    const subscribedAtStart = sessionSubscribed.current;
    setLoadingMoreSessions(true);
    setOlderSessionError(null);
    try {
      const { data, error: loadError } = await supabase.from('builder_vibe_sessions').select(SESSION_FIELDS).neq('status', 'closed')
        .or(`last_activity_at.lt.${cursor.last_activity_at},and(last_activity_at.eq.${cursor.last_activity_at},id.lt.${cursor.id})`)
        .order('last_activity_at', { ascending: false }).order('id', { ascending: false }).limit(SESSION_PAGE_SIZE + 1);
      if (generation !== sessionGeneration.current) return;
      if (loadError) throw loadError;
      const result = ((data ?? []) as VibeSession[]).map((row) => preserveNewerSessionName(row, renamesAtStart, sessionRenames.current));
      const rows = result.slice(0, SESSION_PAGE_SIZE).filter((row) => !closedSessions.current.has(row.id));
      for (const row of rows) loadedSessionIds.current.add(row.id);
      sessionCursor.current = result.slice(0, SESSION_PAGE_SIZE).at(-1) ?? cursor;
      setSessions((current) => mergeSessions(rows, current));
      setHasMoreSessions(result.length > SESSION_PAGE_SIZE);
      loadedOlderSessions.current = true;
      if (!subscribedAtStart && sessionSubscribed.current) {
        restartSessionPaging();
        void loadSessions(true);
      }
    } catch (caught) {
      if (generation === sessionGeneration.current) setOlderSessionError(errorText(caught));
    } finally {
      if (generation === sessionGeneration.current) setLoadingMoreSessions(false);
    }
  }, [loadSessions, loadingMoreSessions, restartSessionPaging]);

  const loadClosedHistory = useCallback(async (older = false, existing?: VibeSession[]) => {
    if (closedHistoryFetching.current || (older && !closedHistoryCursor.current)) return;
    const request = ++closedHistoryRequest.current;
    const renamesAtStart = new Map(sessionRenames.current);
    const cursor = older ? closedHistoryCursor.current : null;
    const knownIds = existing?.map((session) => session.id) ?? [];
    closedHistoryFetching.current = true;
    closedHistoryChanges.current.clear();
    setClosedHistoryLoading(true);
    setClosedHistoryError(null);
    try {
      let query = supabase.from('builder_vibe_sessions').select(SESSION_FIELDS).eq('status', 'closed');
      if (cursor) query = query.or(`last_activity_at.lt.${cursor.last_activity_at},and(last_activity_at.eq.${cursor.last_activity_at},id.lt.${cursor.id})`);
      const { data, error: loadError } = await query.order('last_activity_at', { ascending: false })
        .order('id', { ascending: false }).limit(SESSION_PAGE_SIZE + 1);
      if (request !== closedHistoryRequest.current) return;
      if (loadError) throw loadError;
      const refreshedKnown: VibeSession[] = [];
      for (let index = 0; index < knownIds.length; index += SESSION_PAGE_SIZE) {
        const ids = knownIds.slice(index, index + SESSION_PAGE_SIZE);
        const { data: known, error: knownError } = await supabase.from('builder_vibe_sessions').select(SESSION_FIELDS)
          .in('id', ids).limit(ids.length);
        if (request !== closedHistoryRequest.current) return;
        if (knownError) throw knownError;
        refreshedKnown.push(...((known ?? []) as VibeSession[]).map((row) => preserveNewerSessionName(row, renamesAtStart, sessionRenames.current)));
      }
      const result = ((data ?? []) as VibeSession[]).map((row) => preserveNewerSessionName(row, renamesAtStart, sessionRenames.current));
      const page = result.slice(0, SESSION_PAGE_SIZE);
      const changes = new Map(closedHistoryChanges.current);
      setClosedHistory((current) => {
        let rows = mergeClosedHistory(existing ? refreshedKnown : older ? current : [], page);
        for (const [id, change] of changes) {
          rows = change?.status === 'closed'
            ? mergeClosedHistory(rows, [change])
            : rows.filter((session) => session.id !== id);
        }
        return rows;
      });
      if (existing) {
        const available = new Set(refreshedKnown.map((session) => session.id));
        setSelectedId((current) => current && knownIds.includes(current) && !available.has(current) && !changes.has(current) ? null : current);
      }
      closedHistoryCursor.current = page.at(-1) ?? cursor;
      setHasMoreClosedHistory(result.length > SESSION_PAGE_SIZE);
    } catch (caught) {
      if (request === closedHistoryRequest.current) setClosedHistoryError(errorText(caught));
    } finally {
      if (request === closedHistoryRequest.current) {
        closedHistoryFetching.current = false;
        setClosedHistoryLoading(false);
      }
    }
  }, []);

  const searchSessions = async (older = false) => {
    const term = sessionSearch.trim();
    if (!term || sessionSearchLoading || (older && !sessionSearchCursor.current)) return;
    const request = ++sessionSearchRequest.current;
    const cursor = older ? sessionSearchCursor.current : null;
    const renamesAtStart = new Map(sessionRenames.current);
    setSessionSearchLoading(true);
    setSessionSearchError(null);
    try {
      const literal = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchField = (field: 'title' | 'human_reference') => {
        let query = supabase.from('builder_vibe_sessions').select(SESSION_FIELDS).filter(field, 'imatch', literal);
        if (cursor) query = query.or(`last_activity_at.lt.${cursor.last_activity_at},and(last_activity_at.eq.${cursor.last_activity_at},id.lt.${cursor.id})`);
        return query.order('last_activity_at', { ascending: false }).order('id', { ascending: false }).limit(SESSION_PAGE_SIZE + 1);
      };
      const [names, references] = await Promise.all([searchField('title'), searchField('human_reference')]);
      if (request !== sessionSearchRequest.current) return;
      if (names.error) throw names.error;
      if (references.error) throw references.error;
      const matches = new Map<string, VibeSession>();
      for (const row of [...(names.data ?? []), ...(references.data ?? [])] as VibeSession[]) {
        matches.set(row.id, preserveNewerSessionName(row, renamesAtStart, sessionRenames.current));
      }
      const result = [...matches.values()]
        .sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at) || b.id.localeCompare(a.id));
      const page = result.slice(0, SESSION_PAGE_SIZE);
      setSessionSearchResults((current) => {
        const rows = new Map((older ? current : []).map((session) => [session.id, session]));
        for (const session of page) rows.set(session.id, session);
        return [...rows.values()];
      });
      sessionSearchCursor.current = page.at(-1) ?? cursor;
      setHasMoreSessionSearch(result.length > SESSION_PAGE_SIZE);
      setSessionSearchComplete(true);
    } catch (caught) {
      if (request === sessionSearchRequest.current) setSessionSearchError(errorText(caught));
    } finally {
      if (request === sessionSearchRequest.current) setSessionSearchLoading(false);
    }
  };

  const loadThread = useCallback(async (sessionId: string, request: number, before?: number, reconcile = false) => {
    threadFetching.current = true;
    pendingMessageChanges.current.clear();
    const previous = messagesRef.current.filter((message) => message.session_id === sessionId);
    const floor = reconcile ? oldestMessageSeq.current ?? Infinity : Infinity;
    const updateGapWarning = (hasOlder: boolean) => {
      if (!threadConnected.current || !threadHistoryMayHaveGaps.current) return;
      if (hasOlder) {
        setLiveWarning('Earlier messages may contain activity missed while disconnected. Load earlier messages to check the rest of this conversation.');
      } else {
        threadHistoryMayHaveGaps.current = false;
        setLiveWarning(null);
      }
    };
    try {
      let query = supabase.from('builder_vibe_messages').select(MESSAGE_FIELDS)
        .eq('session_id', sessionId).order('seq', { ascending: false });
      if (before !== undefined) query = query.lt('seq', before);
      const { data, error: loadError } = await query.limit(MESSAGE_PAGE_SIZE + 1);
      if (request !== threadRequest.current) return;
      if (loadError) throw loadError;
      const result = (data ?? []) as VibeMessage[];
      if (Number.isFinite(floor)) {
        const upper = result[0]?.seq;
        const refreshed: VibeMessage[] = [];
        let after: number | null = null;
        if (upper !== undefined && upper >= floor) {
          while (true) {
            let range = supabase.from('builder_vibe_messages').select(MESSAGE_FIELDS)
              .eq('session_id', sessionId).gte('seq', floor).lte('seq', upper).order('seq', { ascending: true });
            if (after !== null) range = range.gt('seq', after);
            const { data: batch, error: rangeError } = await range.limit(MESSAGE_PAGE_SIZE);
            if (request !== threadRequest.current) return;
            if (rangeError) throw rangeError;
            const rows = (batch ?? []) as VibeMessage[];
            refreshed.push(...rows);
            if (rows.length < MESSAGE_PAGE_SIZE) break;
            after = rows[rows.length - 1].seq;
          }
        }
        const { data: older, error: olderError } = await supabase.from('builder_vibe_messages').select('id')
          .eq('session_id', sessionId).lt('seq', floor).limit(1);
        if (request !== threadRequest.current) return;
        if (olderError) throw olderError;
        const previousIds = new Set(previous.map((message) => message.id));
        const outlierIds = previous.filter((message) => message.seq < floor).map((message) => message.id);
        const previousOutliers = new Set(outlierIds);
        const refreshedOutliers: VibeMessage[] = [];
        for (let offset = 0; offset < outlierIds.length; offset += MESSAGE_PAGE_SIZE) {
          const { data: outliers, error: outlierError } = await supabase.from('builder_vibe_messages').select(MESSAGE_FIELDS)
            .eq('session_id', sessionId).in('id', outlierIds.slice(offset, offset + MESSAGE_PAGE_SIZE)).limit(MESSAGE_PAGE_SIZE);
          if (request !== threadRequest.current) return;
          if (outlierError) throw outlierError;
          refreshedOutliers.push(...((outliers ?? []) as VibeMessage[]));
        }
        const changes = new Map(pendingMessageChanges.current);
        setMessages((current) => {
          const retained = current.filter((message) => message.session_id === sessionId
            && ((message.seq < floor && !previousOutliers.has(message.id))
              || (upper !== undefined && message.seq > upper && !previousIds.has(message.id))));
          const rows = new Map(mergeMessages(retained, [...refreshedOutliers, ...refreshed]).map((message) => [message.id, message]));
          for (const [id, change] of changes) {
            if (change === null) rows.delete(id);
            else if (change.kind === 'INSERT' || previousIds.has(id) || change.row.seq >= floor) rows.set(id, change.row);
          }
          return [...rows.values()].sort((a, b) => a.seq - b.seq);
        });
        oldestMessageSeq.current = floor;
        const hasOlder = (older ?? []).length > 0;
        setHasMoreMessages(hasOlder);
        updateGapWarning(hasOlder);
        setThreadLoadFailed(false);
        setThreadError(null);
        return;
      }
      const page = result.slice(0, MESSAGE_PAGE_SIZE).reverse();
      const rows = page.flatMap((message) => {
        const change = pendingMessageChanges.current.get(message.id);
        return change === null ? [] : [change?.row ?? message];
      });
      if (page.length) oldestMessageSeq.current = page[0].seq;
      if (before !== undefined && rows.length && threadContainer.current) {
        const container = threadScrollContainer(threadContainer.current);
        scrollSnapshot.current = { sessionId, container, top: container.scrollTop, height: container.scrollHeight };
      }
      setMessages((current) => mergeMessages(rows, current.filter((message) => message.session_id === sessionId)));
      const hasOlder = result.length > MESSAGE_PAGE_SIZE;
      setHasMoreMessages(hasOlder);
      updateGapWarning(hasOlder);
      if (before === undefined) {
        setThreadLoadFailed(false);
        setThreadError(null);
      } else {
        setOlderMessageError(null);
      }
    } catch (caught) {
      if (request !== threadRequest.current) return;
      if (before === undefined) {
        setThreadLoadFailed(true);
        setThreadError(errorText(caught));
      } else {
        setOlderMessageError(errorText(caught));
      }
    } finally {
      if (request === threadRequest.current) {
        threadFetching.current = false;
        pendingMessageChanges.current.clear();
        setLoadingThread(false);
        setLoadingMoreMessages(false);
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error: roleError } = await supabase.rpc('is_grand_master');
      if (cancelled) return;
      if (roleError || data !== true) { setAccess('denied'); setLoadingSessions(false); return; }
      setAccess('allowed');
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (access !== 'allowed') return undefined;
    const generation = ++sessionGeneration.current;
    let active = true;
    let started = false;
    let connected = false;
    let interrupted = false;
    let timer: number | undefined;
    setSessionsLiveWarning(null);
    const startSessions = () => {
      if (!active || generation !== sessionGeneration.current || started) return;
      started = true;
      void loadSessions(loadedSessionIds.current.size > 0);
    };
    const channel = supabase.channel('builder-vibe-sessions')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'builder_vibe_sessions' }, (change) => {
        if (!active || generation !== sessionGeneration.current) return;
        const row = change.new as VibeSession | undefined;
        const rename = row?.id ? sessionRenames.current.get(row.id) : undefined;
        if (rename) {
          const committedAt = timestampMicros(change.commit_timestamp);
          if (committedAt === null) {
            setSessionsLiveWarning('A live session update could not be verified. Reload sessions to check for changes.');
            void loadSessions(true);
            return;
          }
          if (committedAt < rename.updatedAt) return;
        }
        const removed = row?.status === 'closed' ? row.id : change.eventType === 'DELETE' ? (change.old as { id?: string }).id : undefined;
        const changedId = removed ?? row?.id;
        if (changedId && sessionLoading.current) sessionChangesDuringLoad.current.add(changedId);
        if (changedId && closedHistoryFetching.current) closedHistoryChanges.current.set(changedId, row?.status === 'closed' ? row : null);
        if (row?.status === 'closed') setClosedHistory((current) => mergeClosedHistory(current, [row]));
        else if (changedId) setClosedHistory((current) => current.filter((session) => session.id !== changedId));
        if (changedId) setSessionSearchResults((current) => change.eventType === 'DELETE'
          ? current.filter((session) => session.id !== changedId)
          : current.map((session) => session.id === changedId && row ? row : session));
        if (removed) {
          invalidateSession(removed);
          closedSessions.current.add(removed);
          loadedSessionIds.current.delete(removed);
          setSessions((current) => current.filter((session) => session.id !== removed));
          setSelectedId((current) => current === removed ? null : current);
        } else if (row?.id) {
          closedSessions.current.delete(row.id);
          loadedSessionIds.current.add(row.id);
          setSessions((current) => mergeSessions(current, [row]));
        }
        void loadSessions();
      })
      .subscribe((status) => {
        if (!active || generation !== sessionGeneration.current) return;
        if (status === 'SUBSCRIBED') {
          connected = true;
          sessionSubscribed.current = true;
          if (timer !== undefined) window.clearTimeout(timer);
          if (interrupted) setSessionsLiveWarning('Live session updates reconnected. Reload sessions to include any changes missed while disconnected.');
          else if (started) {
            restartSessionPaging();
            void loadSessions(true);
          }
          else startSessions();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          interrupted = true;
          sessionSubscribed.current = false;
          setSessionsLiveWarning('Live session updates are unavailable. The list may be out of date; reload sessions to reconnect.');
          startSessions();
        }
      });
    startSessions();
    if (!connected && !interrupted) timer = window.setTimeout(() => {
      if (!active || generation !== sessionGeneration.current) return;
      interrupted = true;
      setSessionsLiveWarning('Live session updates are unavailable. The list may be out of date; reload sessions to reconnect.');
      startSessions();
    }, 3000);
    return () => {
      active = false;
      sessionGeneration.current += 1;
      sessionRequest.current += 1;
      sessionLoading.current = false;
      sessionRefreshQueued.current = false;
      sessionReconcileNeeded.current = false;
      sessionSubscribed.current = false;
      if (timer !== undefined) window.clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [access, invalidateSession, loadSessions, restartSessionPaging, sessionsReload]);

  useEffect(() => {
    const sameSession = selectedId !== null && threadSession.current === selectedId;
    threadSession.current = selectedId;
    const request = ++threadRequest.current;
    threadFetching.current = false;
    threadConnected.current = false;
    pendingMessageChanges.current.clear();
    scrollSnapshot.current = null;
    if (!sameSession) {
      threadHistoryMayHaveGaps.current = false;
      setPreviewSrc(null);
      oldestMessageSeq.current = null;
      lastScrolled.current = { sessionId: null, seq: null };
      followLive.current = true;
      setMessages([]);
      setExpandedSteps(new Set());
      setHasMoreMessages(false);
      setThreadError(null);
      setOlderMessageError(null);
    }
    setLoadingMoreMessages(false);
    setThreadLoadFailed(false);
    setLiveWarning(null);
    if (!selectedId) { setLoadingThread(false); return undefined; }
    setLoadingThread(true);
    let started = false;
    let interrupted = false;
    let timer: number | undefined;
    const startHistory = () => {
      if (started || request !== threadRequest.current) return;
      started = true;
      void loadThread(selectedId, request, undefined, sameSession);
    };
    const channel = supabase.channel(`builder-vibe-${selectedId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'builder_vibe_messages', filter: `session_id=eq.${selectedId}` }, (change) => {
        if (request !== threadRequest.current) return;
        if (change.eventType === 'DELETE') {
          const id = (change.old as { id?: string }).id;
          if (id) {
            if (threadFetching.current) pendingMessageChanges.current.set(id, null);
            setMessages((current) => current.filter((message) => message.id !== id));
          }
          return;
        }
        const row = change.new as VibeMessage | undefined;
        if (!row?.id || row.session_id !== selectedId) return;
        if (threadContainer.current && threadEnd.current) {
          followLive.current = isNearThreadEnd(threadContainer.current, threadEnd.current);
        }
        if (threadFetching.current) {
          const previousChange = pendingMessageChanges.current.get(row.id);
          pendingMessageChanges.current.set(row.id, {
            kind: change.eventType === 'INSERT' || previousChange?.kind === 'INSERT' ? 'INSERT' : 'UPDATE',
            row,
          });
        }
        setMessages((current) => {
          if (change.eventType !== 'INSERT' && !current.some((message) => message.id === row.id)
            && (oldestMessageSeq.current === null || row.seq < oldestMessageSeq.current)) return current;
          return mergeMessages(current, [row]);
        });
      })
      .subscribe((status) => {
        if (request !== threadRequest.current) return;
        if (status === 'SUBSCRIBED') {
          threadConnected.current = true;
          if (timer !== undefined) window.clearTimeout(timer);
          if (interrupted) setLiveWarning('Live updates reconnected. Reload the conversation to include any activity missed while disconnected.');
          startHistory();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          threadConnected.current = false;
          threadHistoryMayHaveGaps.current = true;
          interrupted = true;
          setLiveWarning('Live updates are unavailable. The conversation may be out of date; reload to reconnect.');
          startHistory();
        }
      });
    if (!started) timer = window.setTimeout(() => {
      if (request !== threadRequest.current) return;
      interrupted = true;
      threadConnected.current = false;
      threadHistoryMayHaveGaps.current = true;
      setLiveWarning('Live updates are unavailable. The conversation may be out of date; reload to reconnect.');
      startHistory();
    }, 3000);
    return () => {
      threadRequest.current += 1;
      if (timer !== undefined) window.clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [selectedId, loadThread, threadReload]);

  useLayoutEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useLayoutEffect(() => {
    const snapshot = scrollSnapshot.current;
    if (snapshot && snapshot.sessionId === selectedId && snapshot.container.isConnected) {
      snapshot.container.scrollTop = snapshot.top + snapshot.container.scrollHeight - snapshot.height;
      scrollSnapshot.current = null;
    }
  }, [messages, selectedId]);

  useEffect(() => {
    const latest = messages[messages.length - 1];
    if (latest?.session_id === selectedId && (lastScrolled.current.sessionId !== selectedId || lastScrolled.current.seq !== latest.seq)) {
      if (lastScrolled.current.sessionId !== selectedId || followLive.current) threadEnd.current?.scrollIntoView?.({ block: 'end' });
      lastScrolled.current = { sessionId: selectedId, seq: latest.seq };
    }
  }, [messages, selectedId]);

  useEffect(() => {
    if (attachments.length) composer.current?.scrollIntoView?.({ block: 'end' });
  }, [attachments.length]);

  const loadOlderMessages = () => {
    if (!selectedId || oldestMessageSeq.current === null || loadingMoreMessages || threadFetching.current) return;
    setOlderMessageError(null);
    setLoadingMoreMessages(true);
    void loadThread(selectedId, threadRequest.current, oldestMessageSeq.current);
  };

  const retryThread = () => {
    if (!selectedId || threadFetching.current) return;
    setThreadError(null);
    setThreadLoadFailed(false);
    setLoadingThread(true);
    void loadThread(selectedId, threadRequest.current, undefined, true);
  };

  const reloadConversation = () => {
    if (threadContainer.current && threadEnd.current) followLive.current = isNearThreadEnd(threadContainer.current, threadEnd.current);
    setThreadReload((value) => value + 1);
  };

  const reloadSessions = () => {
    sessionRequest.current += 1;
    sessionGeneration.current += 1;
    sessionLoading.current = false;
    sessionRefreshQueued.current = false;
    restartSessionPaging();
    closedSessions.current.clear();
    setSessionError(null);
    setOlderSessionError(null);
    setLoadingSessions(true);
    setSessionLoadFailed(false);
    setLoadingMoreSessions(false);
    setHasMoreSessions(false);
    if (closedVisible) {
      closedHistoryRequest.current += 1;
      closedHistoryFetching.current = false;
      void loadClosedHistory(false, closedHistory);
    }
    setSessionsReload((value) => value + 1);
  };

  const run = useCallback(async (label: string, action: () => Promise<void>) => {
    const token = Symbol(label);
    busyActions.current.set(token, label);
    setBusy(new Set(busyActions.current.values()));
    setError(null);
    try { await action(); } catch (caught) { setError(errorText(caught)); } finally {
      busyActions.current.delete(token);
      setBusy(new Set(busyActions.current.values()));
    }
  }, []);

  const newSession = (title?: string) => run('new', async () => {
    if (attachments.length) throw new Error('Send or remove the staged attachments before starting another session.');
    const { data, error: openError } = await supabase.rpc('builder_vibe_session_open', { p_title: title || null });
    if (openError) throw openError;
    if (typeof data !== 'string' || !data) throw new Error('The new session could not be confirmed. Refresh before starting another.');
    const { data: opened, error: lookupError } = await supabase.from('builder_vibe_sessions').select(SESSION_FIELDS).eq('id', data).limit(1);
    if (lookupError) throw new Error(`The session was created, but its reference could not be loaded. Refresh before starting another. ${errorText(lookupError)}`);
    const session = (opened ?? [])[0] as VibeSession | undefined;
    if (!session?.human_reference) throw new Error('The session was created, but its reference could not be confirmed. Refresh before starting another.');
    loadedSessionIds.current.add(session.id);
    setSessions((current) => mergeSessions(current, [session]));
    setSelectedId(session.id);
    setRenameNotice(`Started ${session.human_reference}.`);
    void loadSessions();
  });

  const saveSessionName = (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || selected.created_by !== profile?.id || isBusy) return;
    const sessionId = selected.id;
    const rename = renameDrafts[sessionId];
    const title = rename?.value.trim();
    if (!rename || !title || Array.from(title).length > 160) return;
    setRenameNotice(null);
    void run('rename', async () => {
      const { data, error: renameError } = await supabase.rpc('builder_vibe_rename_session', {
        p_session_id: sessionId, p_expected_title: rename.expected, p_title: title,
      }).single();
      if (renameError) throw renameError;
      const saved = data as VibeSession | null;
      const updatedAt = saved?.updated_at ? timestampMicros(saved.updated_at) : null;
      if (!saved || saved.id !== sessionId || saved.title !== title || !saved.human_reference
        || updatedAt === null || (selected.human_reference && saved.human_reference !== selected.human_reference)) {
        throw new Error('The saved session name and reference could not be confirmed. Refresh before retrying.');
      }
      sessionRenames.current.set(sessionId, { revision: (sessionRenames.current.get(sessionId)?.revision ?? 0) + 1, title: saved.title, updatedAt });
      setSessions((current) => current.map((session) => session.id === sessionId ? { ...session, ...saved } : session));
      setClosedHistory((current) => current.map((session) => session.id === sessionId ? { ...session, ...saved } : session));
      setSessionSearchResults((current) => current.map((session) => session.id === sessionId ? { ...session, ...saved } : session));
      setRenameDrafts((current) => {
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
      setRenameNotice(`Name saved for ${saved.human_reference}.`);
    });
  };

  const updateAttachment = (id: string, patch: Partial<PendingVibeAttachment>) => {
    setAttachments(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
  };

  const addFiles = (fileList: FileList | null) => {
    if (!fileList?.length) return;
    if (!selected || selected.status === 'closed') { setError('Open a Vibe session before attaching files.'); return; }
    if (detachedAttachments) { setError('Clear the previous session’s attachment selections before adding files here.'); return; }
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
    setAllowCloudAttachments(false);
    attachmentSelectionVersion.current += 1;
    setAttachmentSessionId(selected.id);
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
    attachmentSelectionVersion.current += 1;
    setAttachments(current => current.filter(item => item.id !== attachment.id));
    if (attachments.length === 1) setAttachmentSessionId(null);
    setAllowCloudAttachments(false);
  });

  const send = (action: 'message' | 'ship' | 'revert', text = '') => {
    if (!selected || selected.status === 'closed') return;
    if (detachedAttachments) { setError('Clear the previous session’s attachment selections before sending here.'); return; }
    const submittedSessionVersion = sessionInvalidations.current.get(selected.id) ?? 0;
    const submittedDraftVersion = draftVersions.current.get(selected.id) ?? 0;
    const submittedAttachments = attachments;
    const submittedAttachmentVersion = attachmentSelectionVersion.current;
    void run(action, async () => {
      if (action === 'message') {
        const ready: PendingVibeAttachment[] = [];
        for (const attachment of submittedAttachments) {
          try { ready.push(await prepareAttachment(attachment)); }
          catch (caught) {
            const message = caught instanceof Error ? caught.message : 'Attachment processing failed.';
            updateAttachment(attachment.id, { status: 'failed', error: message });
            throw caught;
          }
        }
        const content = text || (ready.length ? 'Please inspect the attached files and use them as context.' : '');
        const key = JSON.stringify([selected.id, action, content, ready.map(item => item.id), allowCloudAttachments]);
        const clientRequestId = pendingSendRequests.current.get(key) ?? requestId();
        pendingSendRequests.current.set(key, clientRequestId);
        const { error: sendError } = await supabase.rpc('builder_vibe_send_with_attachments_opt_in', {
          p_session_id: selected.id,
          p_content: content,
          p_client_request_id: clientRequestId,
          p_attachment_ids: ready.map(item => item.id),
          p_allow_ollama_cloud: allowCloudAttachments,
        });
        if (sendError) throw new Error(`${errorText(sendError)}. This message may already be saved; retry it unchanged or check the conversation before sending again.`);
        pendingSendRequests.current.delete(key);
        if ((sessionInvalidations.current.get(selected.id) ?? 0) !== submittedSessionVersion) {
          setError('This message may already have been saved, but its session became unavailable before confirmation. Your draft and files remain available for recovery.');
          return;
        }
        setDrafts((current) => (draftVersions.current.get(selected.id) ?? 0) === submittedDraftVersion
          ? { ...current, [selected.id]: '' } : current);
        if (submittedAttachments.length) {
          const submittedIds = new Set(submittedAttachments.map((attachment) => attachment.id));
          setAttachments((current) => current.filter((attachment) => !submittedIds.has(attachment.id)));
          if (attachmentSelectionVersion.current === submittedAttachmentVersion) {
            attachmentSelectionVersion.current += 1;
            setAttachmentSessionId(null);
            setAllowCloudAttachments(false);
            if (fileInput.current) fileInput.current.value = '';
          }
        }
        return;
      }
      const key = JSON.stringify([selected.id, action, text]);
      const clientRequestId = pendingSendRequests.current.get(key) ?? requestId();
      pendingSendRequests.current.set(key, clientRequestId);
      const { error: sendError } = await supabase.rpc('builder_vibe_send', { p_session_id: selected.id, p_content: text, p_client_request_id: clientRequestId, p_action: action });
      if (sendError) throw new Error(`${errorText(sendError)}. This action may already be saved; retry it unchanged or check the conversation before sending again.`);
      pendingSendRequests.current.delete(key);
    });
  };

  const submit = (event?: React.FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if ((!text && !attachments.length) || !selected || selected.status === 'closed' || isBusy) return;
    send('message', text);
  };

  const togglePreview = () => {
    if (!selected || selected.status === 'closed') return;
    void run('preview', async () => {
      const { error: previewError } = await supabase.rpc('builder_vibe_set_preview', { p_session_id: selected.id, p_on: !selected.preview_requested });
      if (previewError) throw previewError;
      if (selected.preview_requested) setPreviewSrc(null);
    });
  };

  const openPreview = (newTab: boolean) => {
    if (!selected || selected.status === 'closed') return;
    void run('ticket', async () => {
      const { data, error: ticketError } = await supabase.rpc('builder_vibe_preview_ticket', { p_session_id: selected.id });
      if (ticketError) throw ticketError;
      if (selectedIdRef.current !== selected.id) return;
      const url = `${PREVIEW_ORIGIN}/vibe/${selected.id}/__open?ticket=${encodeURIComponent(String(data))}`;
      if (newTab) window.open(url, '_blank', 'noopener');
      else setPreviewSrc(url);
    });
  };

  const closeSession = () => {
    if (!selected || selected.status === 'closed' || attachments.length) return;
    if (draft.trim()) {
      setError('Send or clear the draft before closing this session.');
      return;
    }
    if (!window.confirm(`Close "${selected.title}"? The branch and any pull request stay on GitHub.`)) return;
    void run('close', async () => {
      const { error: closeError } = await supabase.rpc('builder_vibe_session_close', { p_session_id: selected.id });
      if (closeError) throw closeError;
      invalidateSession(selected.id);
      closedSessions.current.add(selected.id);
      loadedSessionIds.current.delete(selected.id);
      setSessions((current) => current.filter((session) => session.id !== selected.id));
      setSelectedId((current) => current === selected.id ? null : current);
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
          <button type="button" className="vibe-btn vibe-btn--primary" onClick={() => void newSession()} disabled={busy.has('new') || attachments.length > 0}><Plus size={15} />New</button>
        </div>
        <form className="vibe-session-search" onSubmit={(event) => { event.preventDefault(); void searchSessions(); }}>
          <label>Search Vibe sessions<input value={sessionSearch} maxLength={160} onChange={(event) => {
            sessionSearchRequest.current += 1;
            sessionSearchCursor.current = null;
            setSessionSearch(event.target.value);
            setSessionSearchResults([]);
            setSessionSearchLoading(false);
            setSessionSearchError(null);
            setSessionSearchComplete(false);
            setHasMoreSessionSearch(false);
          }} /></label>
          <button type="submit" className="vibe-btn" disabled={!sessionSearch.trim() || sessionSearchLoading}>Search all Vibe sessions</button>
        </form>
        {sessionSearchError && <p role="alert">{sessionSearchError}</p>}
        {sessionSearchComplete && <section aria-label="Vibe session search results">
          <h2>Search results</h2>
          {!sessionSearchResults.length && <p className="vibe-muted">No accessible sessions matched.</p>}
          <ul className="vibe-rail__list">{sessionSearchResults.map((session) => <li key={session.id}>
            <button type="button" className="vibe-rail__item" onClick={() => {
              if (attachments.length && session.id !== attachmentSessionId) {
                setError('Send or remove the staged attachments before switching sessions.');
                return;
              }
              if (session.status === 'closed') setClosedHistory((current) => mergeClosedHistory(current, [session]));
              else {
                loadedSessionIds.current.add(session.id);
                setSessions((current) => mergeSessions(current, [session]));
              }
              setSelectedId(session.id);
            }}>
              <span className="vibe-rail__title"><span>{session.human_reference ?? 'Reference unavailable'}</span> · <span>{session.title}</span></span>
              <span className={`vibe-pill is-${session.status}`}>{STATUS_LABEL[session.status]}</span>
            </button>
          </li>)}</ul>
          {hasMoreSessionSearch && <button type="button" className="vibe-btn" onClick={() => void searchSessions(true)} disabled={sessionSearchLoading}>Load more matching sessions</button>}
        </section>}
        {loadingSessions ? <p className="vibe-muted" role="status">Loading sessions…</p>
          : sessions.length === 0 ? !sessionLoadFailed && <p className="vibe-muted">No sessions yet. Start one and describe what you want built.</p>
            : <ul className="vibe-rail__list">{sessions.map((session) => (
              <li key={session.id}>
                <button type="button" className={`vibe-rail__item${session.id === selectedId ? ' is-active' : ''}`} aria-current={session.id === selectedId} onClick={() => { if (attachments.length && session.id !== attachmentSessionId) setError('Send or remove the staged attachments before switching sessions.'); else setSelectedId(session.id); }}>
                  <span className="vibe-rail__title"><span>{session.human_reference ?? 'Reference unavailable'}</span> · <span>{session.title}</span></span>
                  <span className={`vibe-pill is-${session.status}`}>{STATUS_LABEL[session.status]}</span>
                  <span className="vibe-rail__meta">{session.changed_files?.length ? `${session.changed_files.length} file${session.changed_files.length === 1 ? '' : 's'} changed` : 'No changes yet'}</span>
                </button>
              </li>
            ))}</ul>}
        {!loadingSessions && sessionLoadFailed && <button type="button" className="vibe-btn" onClick={() => { setSessionError(null); setLoadingSessions(true); void loadSessions(); }}>Retry loading sessions</button>}
        {hasMoreSessions && <button type="button" className="vibe-btn" onClick={() => void loadOlderSessions()} disabled={loadingMoreSessions}>{loadingMoreSessions ? 'Loading older sessions…' : 'Load older sessions'}</button>}
        <button type="button" className="vibe-btn" onClick={() => {
          if (closedVisible) {
            closedHistoryRequest.current += 1;
            closedHistoryFetching.current = false;
            setClosedHistoryLoading(false);
            setClosedVisible(false);
            if (selected?.status === 'closed') setSelectedId(sessions[0]?.id ?? null);
          } else {
            setClosedVisible(true);
            void loadClosedHistory();
          }
        }}>{closedVisible ? 'Hide closed sessions' : 'Show closed sessions'}</button>
        {closedVisible && <section aria-label="Closed Vibe sessions">
          <h2>Closed sessions</h2>
          {closedHistoryLoading && <p className="vibe-muted" role="status">Loading closed sessions…</p>}
          {closedHistoryError && <p role="alert">{closedHistoryError}</p>}
          {closedHistoryError && <button type="button" className="vibe-btn" onClick={() => void loadClosedHistory(false, closedHistory)}>Retry closed sessions</button>}
          {!closedHistoryLoading && !closedHistoryError && !closedHistory.length && <p className="vibe-muted">No closed sessions.</p>}
          <ul className="vibe-rail__list">{closedHistory.map((session) => <li key={session.id}>
            <button type="button" className={`vibe-rail__item${session.id === selectedId ? ' is-active' : ''}`} aria-current={session.id === selectedId} onClick={() => {
              if (attachments.length && session.id !== attachmentSessionId) setError('Send or remove the staged attachments before switching sessions.');
              else setSelectedId(session.id);
            }}>
              <span className="vibe-rail__title"><span>{session.human_reference ?? 'Reference unavailable'}</span> · <span>{session.title}</span></span>
              <span className="vibe-pill">Closed</span>
            </button>
          </li>)}</ul>
          {hasMoreClosedHistory && <button type="button" className="vibe-btn" onClick={() => void loadClosedHistory(true)} disabled={closedHistoryLoading}>Load older closed sessions</button>}
        </section>}
        {(detachedDrafts.length > 0 || detachedAttachments) && <div className="vibe-recovery-list" ref={recovery}>
        {detachedDrafts.length > 0 && <section className="vibe-recovery" aria-label="Unsent drafts">
          <h2>Unsent drafts</h2>
          <p>These sessions are not in the current list. Copy a draft to an open session before leaving; drafts are kept only while this page stays open.</p>
          {detachedDrafts.map(([id, value]) => {
            const title = draftTitles[id] || 'Unavailable session';
            return <div key={id} className="vibe-recovery__item">
              <span>{title}</span>
              <textarea aria-label={`Unsent draft for ${title}`} value={value} readOnly rows={3} />
              <button type="button" className="vibe-btn" onClick={() => {
                if (window.confirm(`Discard the unsent draft for "${title}"?`)) {
                  draftVersions.current.set(id, (draftVersions.current.get(id) ?? 0) + 1);
                  setDrafts((current) => ({ ...current, [id]: '' }));
                }
              }}>Discard draft</button>
            </div>;
          })}
        </section>}
        {detachedAttachments && <section className="vibe-recovery" aria-label="Unsent attachments">
          <h2>Unsent attachments</h2>
          <p>The session is unavailable. Clear these local selections to continue. Already uploaded files remain private in their original session.</p>
          <ul className="vibe-composer__attachments">
            {attachments.map((attachment) => <li key={attachment.id}>
              <span>{attachment.file.name}</span>
              <button type="button" aria-label={`Clear local selection of ${attachment.file.name}`} disabled={isBusy} onClick={() => {
                attachmentSelectionVersion.current += 1;
                setAttachments((current) => current.filter((item) => item.id !== attachment.id));
                if (attachments.length === 1) setAttachmentSessionId(null);
                setAllowCloudAttachments(false);
              }}><X size={13} /></button>
            </li>)}
          </ul>
        </section>}
        </div>}
        {onOpenJobs && <div className="vibe-rail__foot"><button type="button" className="vibe-btn vibe-btn--ghost" onClick={onOpenJobs}><ListChecks size={15} />Jobs &amp; approvals</button></div>}
      </aside>

      {(sessionError || olderSessionError || sessionsLiveWarning || threadError || olderMessageError || error || liveWarning || renameNotice) && <div className="vibe-notices">
        {sessionError && <div className="vibe-alert" role="alert"><AlertTriangle size={16} /><span>{sessionError}</span><button type="button" aria-label="Dismiss session error" onClick={() => setSessionError(null)}><X size={14} /></button></div>}
        {olderSessionError && <div className="vibe-alert" role="alert"><AlertTriangle size={16} /><span>{olderSessionError}</span><button type="button" aria-label="Dismiss older sessions error" onClick={() => setOlderSessionError(null)}><X size={14} /></button></div>}
        {sessionsLiveWarning && <div className="vibe-alert" role="status"><AlertTriangle size={16} /><span>{sessionsLiveWarning}</span><button type="button" className="vibe-btn" onClick={reloadSessions}>Reload sessions</button></div>}
        {threadError && <div className="vibe-alert" role="alert"><AlertTriangle size={16} /><span>{threadError}</span><button type="button" aria-label="Dismiss conversation error" onClick={() => setThreadError(null)}><X size={14} /></button></div>}
        {olderMessageError && <div className="vibe-alert" role="alert"><AlertTriangle size={16} /><span>{olderMessageError}</span><button type="button" aria-label="Dismiss older messages error" onClick={() => setOlderMessageError(null)}><X size={14} /></button></div>}
        {error && <div className="vibe-alert" role="alert"><AlertTriangle size={16} /><span>{error}</span><button type="button" aria-label="Dismiss" onClick={() => setError(null)}><X size={14} /></button></div>}
        {renameNotice && <div className="vibe-alert" role="status"><span>{renameNotice}</span><button type="button" aria-label="Dismiss name confirmation" onClick={() => setRenameNotice(null)}><X size={14} /></button></div>}
        {liveWarning && <div className="vibe-alert" role="status"><AlertTriangle size={16} /><span>{liveWarning}</span><button type="button" className="vibe-btn" onClick={reloadConversation}>Reload conversation</button></div>}
      </div>}

      {(detachedDrafts.length > 0 || detachedAttachments) && !recoveryDismissed && <div className="vibe-recovery-notice" role="status">
        <span>Unsent work belongs to a session that is not currently available.</span>
        <button type="button" className="vibe-btn" onClick={() => {
          recovery.current?.scrollIntoView?.({ block: 'start' });
          recovery.current?.querySelector<HTMLElement>('textarea, button')?.focus({ preventScroll: true });
          setRecoveryDismissed(true);
        }}>Review unsent work</button>
        <button type="button" className="vibe-btn vibe-btn--ghost" aria-label="Dismiss unsent work notice" onClick={() => setRecoveryDismissed(true)}><X size={14} /></button>
      </div>}

      <section className="vibe-chat" aria-label="Conversation with Bob">
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
                <p className="vibe-muted">Reference: {selected.human_reference ?? 'unavailable'}</p>
                {selected.status === 'closed' && <p className="vibe-muted">Closed session · No new work can be sent.</p>}
                {selected.created_by === profile?.id && (renameDrafts[selected.id] ? <form className="vibe-name-editor" onSubmit={saveSessionName}>
                  <label>Session name<input value={renameDrafts[selected.id].value} maxLength={160} onChange={(event) => {
                    const value = event.target.value;
                    setRenameDrafts((current) => ({ ...current, [selected.id]: { ...current[selected.id], value } }));
                  }} disabled={busy.has('rename')} /></label>
                  <button type="submit" className="vibe-btn" disabled={isBusy || !renameDrafts[selected.id].value.trim()}>Save session name</button>
                  <button type="button" className="vibe-btn" disabled={busy.has('rename')} onClick={() => setRenameDrafts((current) => {
                    const next = { ...current };
                    delete next[selected.id];
                    return next;
                  })}>Cancel name edit</button>
                </form> : <button type="button" className="vibe-btn" onClick={() => setRenameDrafts((current) => ({
                  ...current, [selected.id]: { expected: selected.title, value: selected.title },
                }))}>Edit session name</button>)}
                <p className="vibe-muted">{selected.branch ? <code>{selected.branch}</code> : 'Branch is created from main on your first message'}{selected.head_sha && selected.base_sha && selected.head_sha !== selected.base_sha ? ` · ${selected.changed_files.length} file(s) changed` : ''}</p>
              </div>
              <div className="vibe-chat__actions">
                <button type="button" className="vibe-btn" onClick={reloadConversation} disabled={loadingThread || loadingMoreMessages} aria-label="Refresh conversation"><RefreshCw size={15} />Refresh</button>
                <button type="button" className="vibe-btn" onClick={() => send('revert')} disabled={selected.status === 'closed' || !hasChanges || working || isBusy || attachments.length > 0} title="Undo Bob's last change"><Undo2 size={15} />Undo</button>
                <button type="button" className="vibe-btn vibe-btn--primary" onClick={() => send('ship')} disabled={selected.status === 'closed' || !hasChanges || working || isBusy || attachments.length > 0}><GitPullRequest size={15} />{selected.pr_url ? 'Update PR' : 'Ship as PR'}</button>
                {selected.pr_url && <a className="vibe-btn" href={selected.pr_url} target="_blank" rel="noreferrer"><ExternalLink size={15} />PR</a>}
                {githubChecksUrl(selected.pr_url, selected.branch) && <a className="vibe-btn" href={githubChecksUrl(selected.pr_url, selected.branch) as string} target="_blank" rel="noreferrer" title="GitHub Actions runs for this branch"><ListChecks size={15} />Checks</a>}
                <button type="button" className="vibe-btn vibe-btn--ghost" onClick={closeSession} aria-label="Close session" disabled={selected.status === 'closed' || attachments.length > 0 || isBusy}><X size={15} /></button>
                <button type="button" className="vibe-btn vibe-only-mobile" onClick={() => setMobilePane('preview')}><MonitorPlay size={15} />Preview</button>
              </div>
            </header>
            <div className="vibe-thread" ref={threadContainer} aria-live="polite" aria-busy={loadingThread || loadingMoreMessages}>
              {loadingThread && <p className="vibe-muted" role="status">Loading conversation…</p>}
              {threadLoadFailed && <button type="button" className="vibe-btn" onClick={retryThread} disabled={loadingThread || loadingMoreMessages}>Retry loading conversation</button>}
              {hasMoreMessages && <button type="button" className="vibe-btn" onClick={loadOlderMessages} disabled={loadingMoreMessages || loadingThread}>{loadingMoreMessages ? 'Loading earlier messages…' : 'Load earlier messages'}</button>}
              {thread.map((item, index) => item.type === 'steps'
                ? <StepsBlock key={item.key} steps={item.steps} live={working && index === thread.length - 1}
                    open={item.steps.some((step) => expandedSteps.has(step.id))}
                    onToggle={() => setExpandedSteps((current) => {
                      const next = new Set(current);
                      const open = item.steps.some((step) => next.has(step.id));
                      for (const step of item.steps) open ? next.delete(step.id) : next.add(step.id);
                      return next;
                    })} />
                : <MessageBlock key={item.message.id} message={item.message} branch={selected.branch} />)}
              {working && <div className="vibe-working" role="status"><Loader2 size={15} className="vibe-spin" />{STATUS_LABEL[selected.status === 'shipping' ? 'shipping' : 'working']}…</div>}
              <div ref={threadEnd} />
            </div>
            <form className="vibe-composer" ref={composer} onSubmit={submit}>
              <input ref={fileInput} className="vibe-sr-only" type="file" multiple accept={VIBE_ACCEPTED_FILES} aria-label="Attach screenshots or documents" onChange={(event) => { addFiles(event.currentTarget.files); event.currentTarget.value = ''; }} />
              {!detachedAttachments && attachments.length > 0 && <ul className="vibe-composer__attachments" aria-label="Attachments ready for Bob">
                {attachments.map((attachment) => (
                  <li key={attachment.id}>
                    {attachment.fileType.startsWith('image/') ? <ImageIcon size={14} /> : <FileText size={14} />}
                    <span>{attachment.file.name}</span>
                    <small>{attachment.status === 'ready' ? 'Ready' : attachment.status === 'failed' ? attachment.error || 'Failed' : attachment.status === 'extracting' ? 'Extracting text…' : attachment.status === 'uploading' ? 'Uploading…' : 'Queued'}</small>
                    <button type="button" aria-label={`Remove ${attachment.file.name}`} onClick={() => void removeAttachment(attachment)} disabled={isBusy}><X size={13} /></button>
                  </li>
                ))}
              </ul>}
              {!detachedAttachments && attachments.length > 0 && <label className="vibe-composer__egress">
                <input
                  type="checkbox"
                  checked={allowCloudAttachments}
                  onChange={(event) => setAllowCloudAttachments(event.target.checked)}
                  disabled={isBusy}
                />
                <span>
                  Allow this message’s locally extracted text or screenshot description to be sent to Ollama Cloud if private models cannot complete the task. I confirm these attachments contain no personal, confidential, restricted, credential, or proprietary information.
                </span>
              </label>}
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
              <button type="button" className="vibe-btn" onClick={() => fileInput.current?.click()} disabled={selected.status === 'closed' || detachedAttachments || attachments.length >= VIBE_MAX_FILES || isBusy} aria-label="Attach screenshot or document"><Paperclip size={15} />Attach</button>
              <button type="submit" className="vibe-btn vibe-btn--primary" disabled={selected.status === 'closed' || detachedAttachments || (!draft.trim() && !attachments.length) || isBusy} aria-label="Send"><Send size={15} />Send</button>
              <p className="vibe-composer__notice">Private session files · images are analyzed locally · documents are text-extracted locally · raw attachment bytes are never sent to Ollama Cloud · nothing is registered as a business record.</p>
            </form>
          </>
        )}
      </section>

      <section className="vibe-preview" aria-label="Live preview">
        <header className="vibe-preview__head">
          <h2><MonitorPlay size={16} />Live preview</h2>
          <button type="button" className="vibe-btn vibe-only-mobile" onClick={() => setMobilePane('chat')}>Back to chat</button>
          {selected && <label className="vibe-switch">
            <input type="checkbox" checked={selected.preview_requested} onChange={togglePreview} disabled={busy.has('preview') || selected.status === 'closed'} />
            <span>{selected.preview_requested ? 'On' : 'Off'}</span>
          </label>}
        </header>
        {!selected ? <p className="vibe-muted">Select a session to preview its branch.</p>
          : selected.status === 'closed' ? <p className="vibe-muted">This session is closed; its history is read-only.</p>
          : !selected.preview_requested ? <div className="vibe-preview__note"><p>Turn the preview on to run this session's branch in a dev server. It updates as Bob edits.</p><p className="vibe-muted">The preview uses the live database, like any preview deployment: sign in with your own account and treat writes as real.</p></div>
            : selected.preview_status === 'failed' ? <div className="vibe-preview__note is-error" role="alert"><AlertTriangle size={16} /><p>{selected.preview_detail || 'The preview could not start.'}</p><p className="vibe-muted">Turn it off and on again to retry.</p></div>
              : selected.preview_status !== 'ready' ? <div className="vibe-preview__note" role="status"><Loader2 size={16} className="vibe-spin" /><p>{selected.preview_detail || 'Starting the dev server…'}</p></div>
                : previewSrc ? <>
                  <div className="vibe-preview__bar"><button type="button" className="vibe-btn" onClick={() => openPreview(true)}><ExternalLink size={14} />New tab</button></div>
                  <iframe className="vibe-preview__frame" title={`Preview of ${selected.title}`} src={previewSrc} sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads" />
                </>
                  : <div className="vibe-preview__note"><p>The dev server is running.</p><div className="vibe-chat__actions"><button type="button" className="vibe-btn vibe-btn--primary" onClick={() => openPreview(false)} disabled={busy.has('ticket')}><MonitorPlay size={15} />Show here</button><button type="button" className="vibe-btn" onClick={() => openPreview(true)} disabled={busy.has('ticket')}><ExternalLink size={15} />Open in new tab</button></div></div>}
      </section>
    </div>
  );
}
