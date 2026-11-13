import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, Loader2, MessageSquarePlus, ShieldCheck, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { ChangeRequestQueue } from './ChangeRequestQueue';
import {
  CHANGE_REQUEST_KINDS,
  CHANGE_REQUEST_TEXT_LIMIT,
  canRequestChange,
  captureViewContext,
  changeRequestStatusLabel,
  listChangeRequests,
  submitChangeRequest,
  type ChangeRequestKind,
  type ChangeRequestRecord,
  type ChangeRequestVerdict,
  type ViewContext,
} from '../lib/bobChangeRequest';
import './ChangeRequestButton.css';

interface ChangeRequestButtonProps {
  workspaceLabel?: string;
  className?: string;
  compact?: boolean;
  onOpenBob?: (prompt: string) => void;
}

type Phase = 'editing' | 'sending' | 'sent' | 'error';

export function ChangeRequestButton({ workspaceLabel = '', className = '', compact = false, onOpenBob }: ChangeRequestButtonProps) {
  const { profile } = useAuth();
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState<ViewContext | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  if (!canRequestChange(profile?.role)) return null;

  const openDialog = () => {
    // Capture before the dialog renders so its own heading is not part of the context.
    setContext(captureViewContext(workspaceLabel));
    setOpen(true);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`change-request-trigger ${compact ? 'is-compact' : ''} ${className}`.trim()}
        onClick={openDialog}
        title="Request a change or report a UI flow on this page"
        aria-haspopup="dialog"
      >
        <MessageSquarePlus size={16} aria-hidden="true" />
        <span className={compact ? 'sr-only' : undefined}>Request change</span>
      </button>
      {open && context && (
        <ChangeRequestDialog
          context={context}
          userId={profile?.id}
          onOpenBob={onOpenBob}
          onClose={() => { setOpen(false); triggerRef.current?.focus(); }}
        />
      )}
    </>
  );
}

interface ChangeRequestDialogProps {
  context: ViewContext;
  userId?: string;
  onClose: () => void;
  onOpenBob?: (prompt: string) => void;
}

export function ChangeRequestDialog({ context, userId, onClose, onOpenBob }: ChangeRequestDialogProps) {
  const titleId = useId();
  const [kind, setKind] = useState<ChangeRequestKind>('workflow_snag');
  const [currentBehavior, setCurrentBehavior] = useState('');
  const [desiredBehavior, setDesiredBehavior] = useState('');
  const [businessReason, setBusinessReason] = useState('');
  const [phase, setPhase] = useState<Phase>('editing');
  const [error, setError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<ChangeRequestVerdict | null>(null);
  const [recent, setRecent] = useState<ChangeRequestRecord[] | null>(null);
  const [recentError, setRecentError] = useState<string | null>(null);
  const clientKey = useRef(crypto.randomUUID());
  const dialogRef = useRef<HTMLDialogElement>(null);
  const firstFieldRef = useRef<HTMLSelectElement>(null);

  const loadRecent = useCallback(async () => {
    if (!userId) return;
    try {
      setRecent(await listChangeRequests({ mineOnly: true, userId, limit: 5 }));
      setRecentError(null);
    } catch (err) {
      setRecentError(err instanceof Error ? err.message : 'Your earlier requests could not be loaded.');
    }
  }, [userId]);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    firstFieldRef.current?.focus();
    void loadRecent();
    return () => dialog?.close();
  }, [loadRecent]);

  const closeDialog = () => { dialogRef.current?.close(); onClose(); };
  const canSend = desiredBehavior.trim().length >= 10 && phase !== 'sending';

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSend) return;
    setPhase('sending');
    setError(null);
    try {
      const result = await submitChangeRequest({ kind, currentBehavior, desiredBehavior, businessReason }, context, clientKey.current);
      setVerdict(result);
      setPhase('sent');
      void loadRecent();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The change request could not be sent.');
      setPhase('error');
    }
  };

  const kindHint = CHANGE_REQUEST_KINDS.find((item) => item.value === kind)?.hint;

  return createPortal(
      <dialog ref={dialogRef} className="change-request-dialog" aria-modal="true" aria-labelledby={titleId}
        onCancel={(event) => { event.preventDefault(); if (phase !== 'sending') closeDialog(); }}>
        <header className="change-request-head">
          <div>
            <span>Bob Builder brief</span>
            <h2 id={titleId}>Request a change to this page</h2>
            <p>Describe what gets in your way. Bob Builder checks it against the app's rules, data and permissions and plans the change; protected areas wait for a person. Nothing is merged or deployed without human approval.</p>
          </div>
          <button type="button" className="change-request-close" onClick={closeDialog} disabled={phase === 'sending'} aria-label="Close change request"><X size={18} /></button>
        </header>

        {phase === 'sent' && verdict ? (
          <section className="change-request-sent" role="status">
            <CheckCircle2 size={28} aria-hidden="true" />
            <h3>Request recorded</h3>
            <p>
              {verdict.stop_line_hit
                ? 'Your request mentions personal or security-sensitive detail, so it is held for a platform reviewer before Bob looks at it.'
                : verdict.repair_risk === 'protected'
                  ? 'It touches a protected area (access, money, evidence or legal), so the platform owner reviews it before Bob proposes anything.'
                  : 'Bob Builder will assess it and plan the change in Builder chat, then open a job for review. Nothing is merged or deployed without a person.'}
            </p>
            <dl>
              <div><dt>Reference</dt><dd><code>{verdict.packet_id.slice(0, 8)}</code></dd></div>
              <div><dt>Status</dt><dd>{changeRequestStatusLabel({ disposition: 'open', builder_job_id: null, repair_risk: verdict.repair_risk, automation_status: verdict.automation_status, stop_line_hit: verdict.stop_line_hit })}</dd></div>
            </dl>
            <div className="change-request-actions"><button type="button" className="is-primary" onClick={closeDialog}>Done</button></div>
          </section>
        ) : (
          <form onSubmit={send} className="change-request-form">
            <label>
              <span>What kind of request is this?</span>
              <select ref={firstFieldRef} value={kind} onChange={(event) => setKind(event.target.value as ChangeRequestKind)} disabled={phase === 'sending'}>
                {CHANGE_REQUEST_KINDS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
              {kindHint && <small>{kindHint}</small>}
            </label>
            <label>
              <span>Before — what happens now?</span>
              <textarea value={currentBehavior} maxLength={CHANGE_REQUEST_TEXT_LIMIT} rows={3} onChange={(event) => setCurrentBehavior(event.target.value)} disabled={phase === 'sending'} placeholder="e.g. Unfilled shifts are mixed in with filled ones, so I scroll the whole week to find gaps." />
            </label>
            <label>
              <span>After — what should happen instead? <em>Required</em></span>
              <textarea value={desiredBehavior} maxLength={CHANGE_REQUEST_TEXT_LIMIT} rows={3} required onChange={(event) => setDesiredBehavior(event.target.value)} disabled={phase === 'sending'} placeholder="e.g. Show unfilled shifts first, with a count per day." aria-describedby={`${titleId}-desired-hint`} />
              <small id={`${titleId}-desired-hint`}>At least a short sentence, so Bob knows the outcome you want.</small>
            </label>
            <label>
              <span>Why does it matter?</span>
              <textarea value={businessReason} maxLength={CHANGE_REQUEST_TEXT_LIMIT} rows={2} onChange={(event) => setBusinessReason(event.target.value)} disabled={phase === 'sending'} placeholder="e.g. Dispatchers fill gaps faster before the shift starts." />
            </label>

            <details className="change-request-context">
              <summary><ShieldCheck size={15} aria-hidden="true" /> What Bob receives about this screen</summary>
              <dl>
                <div><dt>Page</dt><dd><code>{context.page}</code></dd></div>
                {context.workspace && <div><dt>Workspace</dt><dd>{context.workspace}</dd></div>}
                {context.view_title && <div><dt>Title</dt><dd>{context.view_title}</dd></div>}
                {context.active_tab && <div><dt>Tab</dt><dd>{context.active_tab}</dd></div>}
                {context.view_headings.length > 0 && <div><dt>Sections</dt><dd>{context.view_headings.join(' · ')}</dd></div>}
                <div><dt>Device</dt><dd>{context.viewport}</dd></div>
              </dl>
              <p>Your role and keeping organisation are attached by the server. Only the route and view structure above are captured, not form values or table rows. Titles may contain record names: check this preview and do not include personal, legal, security or financial details in your report.</p>
            </details>

            {phase === 'error' && error && <p className="change-request-error" role="alert">{error}</p>}

            <div className="change-request-actions">
              <button type="button" onClick={closeDialog} disabled={phase === 'sending'}>Cancel</button>
              <button type="submit" className="is-primary" disabled={!canSend}>
                {phase === 'sending' ? <><Loader2 size={15} className="spin" aria-hidden="true" /> Sending…</> : 'Send to review queue'}
              </button>
            </div>
          </form>
        )}

        {userId && (
          <section className="change-request-recent" aria-label="Your recent requests">
            <h3>Your recent requests</h3>
            {recentError ? <p className="change-request-muted">{recentError}</p>
              : recent === null ? <p className="change-request-muted">Loading…</p>
                : recent.length === 0 ? <p className="change-request-muted">You have not sent any requests yet.</p>
                  : (
                    <ul>
                      {recent.map((item) => (
                        <li key={item.id}>
                          <span className="change-request-recent-text">{item.desiredBehavior}</span>
                          <span className="change-request-recent-meta"><code>{item.page}</code> · {changeRequestStatusLabel(item)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <ChangeRequestQueue onOpenBob={onOpenBob ? (prompt) => { closeDialog(); onOpenBob(prompt); } : undefined} />
          </section>
        )}
      </dialog>,
      document.body,
  );
}
