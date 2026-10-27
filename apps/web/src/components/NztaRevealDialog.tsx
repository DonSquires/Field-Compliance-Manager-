import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ShieldAlert, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { MIN_EXPLANATION, NZTA_USE_NOTICE, REVEAL_PURPOSES, type RevealPurpose } from '../lib/nztaRegister';
import './NztaRevealDialog.css';

export interface NztaRevealResult {
  revealed_until: string;
  organization_count: number;
  warnings: Array<'training' | 'confidentiality'>;
}

interface FollowUpNotice {
  notice_id: string;
  organization_id: string;
  notice_number: string | null;
  notice_type: string;
  issued_at: string | null;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

const noticeLabel = (notice: FollowUpNotice) => {
  const kind = notice.notice_type === 'trespass' ? 'Trespass notice' : 'Warning notice';
  const issued = notice.issued_at ? new Date(notice.issued_at).toLocaleDateString('en-NZ', { dateStyle: 'medium' }) : 'issue date not recorded';
  return `${kind} ${notice.notice_number ?? '(no number)'} · issued ${issued}`;
};

/**
 * Purpose-stated reveal of an NZTA person<->vehicle link. The server records
 * who, when, why and against which subject, then opens a 15-minute window for
 * this user and subject only. Follow-up notices are loaded from the server so
 * only issued trespass/warning notices about this subject can be chosen.
 */
export const NztaRevealDialog: React.FC<{
  subjectType: 'vehicle' | 'person';
  subjectId: string;
  subjectLabel: string;
  organizationId?: string | null;
  observationId?: string | null;
  onRevealed: (result: NztaRevealResult) => void;
  onClose: () => void;
}> = ({ subjectType, subjectId, subjectLabel, organizationId = null, observationId = null, onRevealed, onClose }) => {
  const [purpose, setPurpose] = useState<RevealPurpose | ''>('');
  const [explanation, setExplanation] = useState('');
  const [noticeId, setNoticeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [notices, setNotices] = useState<FollowUpNotice[]>([]);
  const [noticesState, setNoticesState] = useState<'loading' | 'ready' | 'error'>('loading');
  const firstField = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    firstField.current?.focus();
    return () => { if (opener && opener.isConnected) opener.focus(); };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) { onClose(); return; }
      if (event.key !== 'Tab' || !formRef.current) return;
      const focusable = Array.from(formRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!formRef.current.contains(active)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  useEffect(() => {
    let current = true;
    setNoticesState('loading');
    void supabase.rpc('list_nzta_follow_up_notices', {
      p_subject_type: subjectType, p_subject_id: subjectId, p_organization_id: organizationId,
    }).then(({ data, error: noticeError }) => {
      if (!current) return;
      if (noticeError) { setNotices([]); setNoticesState('error'); return; }
      setNotices((data ?? []) as FollowUpNotice[]);
      setNoticesState('ready');
    });
    return () => { current = false; };
  }, [subjectType, subjectId, organizationId]);

  const trimmed = explanation.trim();
  const problems = [
    !purpose && 'Choose why you need this information.',
    trimmed.length < MIN_EXPLANATION && `Explain the reason in at least ${MIN_EXPLANATION} characters.`,
    purpose === 'notice_follow_up' && !noticeId && 'Choose the notice you are following up.',
  ].filter(Boolean) as string[];

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setTouched(true);
    if (problems.length > 0) return;
    setBusy(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc('reveal_nzta_registered_person', {
      p_subject_type: subjectType,
      p_subject_id: subjectId,
      p_purpose: purpose,
      p_explanation: trimmed,
      p_organization_id: organizationId,
      p_notice_id: purpose === 'notice_follow_up' ? noticeId : null,
      p_observation_id: observationId,
    });
    setBusy(false);
    if (rpcError) {
      setError(rpcError.message || 'The information could not be revealed. Check your access and try again.');
      return;
    }
    onRevealed(data as NztaRevealResult);
  };

  return createPortal(
    <div className="nzta-reveal-backdrop">
      <form ref={formRef} className="nzta-reveal-dialog" role="dialog" aria-modal="true" aria-labelledby="nzta-reveal-title" aria-describedby="nzta-reveal-intro" onSubmit={(event) => void submit(event)} noValidate>
        <header>
          <div>
            <span>NZTA register · logged access</span>
            <h2 id="nzta-reveal-title">State your purpose to view</h2>
          </div>
          <button type="button" className="nzta-reveal-close" onClick={onClose} disabled={busy} aria-label="Close without viewing"><X size={18} aria-hidden="true" /></button>
        </header>
        <p id="nzta-reveal-intro" className="nzta-reveal-intro">
          <ShieldAlert size={16} aria-hidden="true" />
          <span>You are about to view NZTA register information linking <strong>{subjectLabel}</strong> to a {subjectType === 'vehicle' ? 'registered person' : 'vehicle'}. Your name, the time and your reason are recorded, and access stays open for 15 minutes.</span>
        </p>
        <fieldset className="nzta-reveal-purposes" disabled={busy}>
          <legend>Purpose</legend>
          {REVEAL_PURPOSES.map((option, index) => {
            const unavailable = option.id === 'notice_follow_up' && notices.length === 0;
            const unavailableHint = noticesState === 'loading' ? 'Checking for issued notices…'
              : noticesState === 'error' ? 'Issued notices could not be loaded. Close and try again.'
              : `No issued trespass or warning notice is recorded for this ${subjectType}.`;
            return (
              <label key={option.id} className={unavailable ? 'is-unavailable' : undefined}>
                <input ref={index === 0 ? firstField : undefined} type="radio" name="nzta-purpose" value={option.id}
                  checked={purpose === option.id} disabled={unavailable} onChange={() => setPurpose(option.id)} />
                <span><strong>{option.label}</strong><small>{unavailable ? unavailableHint : option.hint}</small></span>
              </label>
            );
          })}
        </fieldset>
        {purpose === 'notice_follow_up' && (
          <label className="nzta-reveal-field">Notice
            <select value={noticeId} onChange={(event) => setNoticeId(event.target.value)} disabled={busy} required>
              <option value="">Choose a notice…</option>
              {notices.map((notice) => <option key={notice.notice_id} value={notice.notice_id}>{noticeLabel(notice)}</option>)}
            </select>
          </label>
        )}
        <label className="nzta-reveal-field">Reason
          <textarea value={explanation} onChange={(event) => setExplanation(event.target.value)} rows={3} maxLength={2000} disabled={busy}
            placeholder="For example: vehicle seen inside the locked gate at Block 4 on 12 Oct with no permit displayed." aria-describedby="nzta-reveal-reason-hint" />
          <small id="nzta-reveal-reason-hint">{trimmed.length < MIN_EXPLANATION ? `${MIN_EXPLANATION - trimmed.length} more characters needed` : 'Reason recorded with your access'}</small>
        </label>
        <p className="nzta-reveal-notice">{NZTA_USE_NOTICE}</p>
        {touched && problems.length > 0 && <ul className="nzta-reveal-problems" role="alert">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
        {error && <p className="nzta-reveal-error" role="alert">{error}</p>}
        <div className="nzta-reveal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Recording…' : 'Record purpose and view'}</button>
        </div>
      </form>
    </div>,
    document.body,
  );
};

export const nztaWarningText = (warnings: NztaRevealResult['warnings'] | undefined) => {
  if (!warnings || warnings.length === 0) return null;
  const missing = warnings.map((warning) => warning === 'training' ? 'current NZTA register training' : 'a current confidentiality acceptance').join(' and ');
  return `Access was logged, but your record shows no ${missing}. Ask an administrator to update it under NZTA register (s241).`;
};
