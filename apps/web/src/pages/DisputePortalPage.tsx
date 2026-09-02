/**
 * DisputePortalPage.tsx (public, unauthenticated route: /dispute)
 *
 * Canonical schema: disputes, via the submit-dispute edge function (no JWT
 * required; runs service-role to avoid granting anon INSERT on disputes,
 * which would let anyone set an arbitrary organization_id).
 *
 * Per Bob's module_freedom_camping/workflow_freedom_camping knowledge
 * cards: "a notice may be disputed (public dispute portal -> admin
 * Disputes)". submit-dispute already existed and worked, but there was no
 * public page anywhere that could reach it -- the QR/URL printed on a
 * notice had nowhere to send someone.
 */

import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

const GROUND_OPTIONS = [
  { value: 'incorrect_notice_details', label: 'The notice details are incorrect' },
  { value: 'vehicle_not_mine', label: 'This is not my vehicle' },
  { value: 'medical_emergency', label: 'Medical emergency' },
  { value: 'mechanical_breakdown', label: 'Mechanical breakdown' },
  { value: 'signage_unclear', label: 'Signage was unclear or missing' },
  { value: 'other', label: 'Other' },
];

const emptyForm = {
  notice_number: '',
  dispute_type: 'infringement',
  plate_number: '',
  notice_date: '',
  submitter_name: '',
  submitter_email: '',
  submitter_phone: '',
  scv_number: '',
  statement: '',
};

const DisputePortalPage: React.FC = () => {
  const [form, setForm] = useState(emptyForm);
  const [grounds, setGrounds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const toggleGround = (value: string) => {
    setGrounds((prev) => (prev.includes(value) ? prev.filter((g) => g !== value) : [...prev, value]));
  };

  const canSubmit = form.notice_number.trim().length > 0 && form.submitter_name.trim().length > 0 && form.statement.trim().length >= 10 && grounds.length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const { data, error: fnError } = await supabase.functions.invoke<{ success: boolean; error?: string }>('submit-dispute', {
        body: {
          notice_number: form.notice_number.trim() || undefined,
          dispute_type: form.dispute_type,
          plate_number: form.plate_number.trim() || undefined,
          notice_date: form.notice_date || undefined,
          submitter_name: form.submitter_name.trim(),
          submitter_email: form.submitter_email.trim() || undefined,
          submitter_phone: form.submitter_phone.trim() || undefined,
          grounds,
          statement: form.statement.trim(),
          scv_number: form.scv_number.trim() || undefined,
        },
      });
      if (fnError) throw fnError;
      if (!data?.success) throw new Error(data?.error ?? 'The dispute could not be submitted.');
      setSubmitted(true);
      setForm(emptyForm);
      setGrounds([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The dispute could not be submitted.');
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="page-container" style={{ maxWidth: '560px', margin: '0 auto' }}>
        <header className="page-header">
          <h1>Dispute submitted</h1>
        </header>
        <div className="alert alert-success">
          Your dispute has been received and linked to the notice you referenced. It will be reviewed and you will be contacted using the details you provided.
        </div>
        <button type="button" className="btn btn-secondary btn-block" onClick={() => setSubmitted(false)}>
          Submit another dispute
        </button>
      </div>
    );
  }

  return (
    <div className="page-container" style={{ maxWidth: '560px', margin: '0 auto' }}>
      <header className="page-header">
        <h1>Dispute a Notice</h1>
        <p className="subtitle">Use this form to dispute an infringement, notice to vacate, or other enforcement notice.</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      <form className="assessment-form" onSubmit={handleSubmit}>
        <div className="form-group">
          <label>Notice number *</label>
          <input required value={form.notice_number} onChange={(e) => setForm({ ...form, notice_number: e.target.value })} placeholder="e.g. INF-20260901-0001" />
        </div>
        <div className="form-group">
          <label>Vehicle plate</label>
          <input value={form.plate_number} onChange={(e) => setForm({ ...form, plate_number: e.target.value.toUpperCase() })} maxLength={10} />
        </div>
        <div className="form-group">
          <label>Notice date</label>
          <input type="date" value={form.notice_date} onChange={(e) => setForm({ ...form, notice_date: e.target.value })} />
        </div>
        <div className="form-group">
          <label>Your name *</label>
          <input required value={form.submitter_name} onChange={(e) => setForm({ ...form, submitter_name: e.target.value })} />
        </div>
        <div className="form-group">
          <label>Email</label>
          <input type="email" value={form.submitter_email} onChange={(e) => setForm({ ...form, submitter_email: e.target.value })} />
        </div>
        <div className="form-group">
          <label>Phone</label>
          <input value={form.submitter_phone} onChange={(e) => setForm({ ...form, submitter_phone: e.target.value })} />
        </div>
        <div className="form-group">
          <label>Self-containment certificate number (if relevant)</label>
          <input value={form.scv_number} onChange={(e) => setForm({ ...form, scv_number: e.target.value })} />
        </div>
        <div className="form-group">
          <label>Grounds for dispute * (select all that apply)</label>
          {GROUND_OPTIONS.map((option) => (
            <label key={option.value} style={{ display: 'block' }}>
              <input type="checkbox" checked={grounds.includes(option.value)} onChange={() => toggleGround(option.value)} /> {option.label}
            </label>
          ))}
        </div>
        <div className="form-group">
          <label>Statement *</label>
          <textarea required minLength={10} rows={5} value={form.statement} onChange={(e) => setForm({ ...form, statement: e.target.value })} placeholder="Explain why you are disputing this notice" />
        </div>
        <button type="submit" className="btn btn-primary btn-block" disabled={!canSubmit || submitting}>
          {submitting ? 'Submitting…' : 'Submit Dispute'}
        </button>
      </form>
    </div>
  );
};

export default DisputePortalPage;
