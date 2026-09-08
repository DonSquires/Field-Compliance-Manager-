import { FormEvent, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileText, Send } from 'lucide-react';
import { supabase } from '../lib/supabase';
import './PublicDisputePage.css';

const GROUNDS = ['Incorrect notice details', 'Vehicle was compliant', 'Notice was not received', 'Other'];

export default function PublicDisputePage() {
  const [form, setForm] = useState({ noticeNumber: '', disputeType: 'infringement', plateNumber: '', noticeDate: '', name: '', email: '', phone: '', statement: '', scvNumber: '' });
  const [grounds, setGrounds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const toggleGround = (ground: string) => setGrounds((current) => current.includes(ground) ? current.filter((item) => item !== ground) : [...current, ground]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!grounds.length || !form.name.trim() || !form.statement.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const { data, error: submitError } = await supabase.functions.invoke('submit-dispute', {
        body: {
          notice_number: form.noticeNumber.trim() || undefined,
          dispute_type: form.disputeType,
          plate_number: form.plateNumber.trim() || undefined,
          notice_date: form.noticeDate || undefined,
          submitter_name: form.name.trim(),
          submitter_email: form.email.trim() || undefined,
          submitter_phone: form.phone.trim() || undefined,
          grounds,
          statement: form.statement.trim(),
          scv_number: form.scvNumber.trim() || undefined,
        },
      });
      if (submitError || !data?.success) throw submitError ?? new Error('Your dispute could not be submitted.');
      setSubmitted(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Your dispute could not be submitted.');
    } finally {
      setSaving(false);
    }
  };

  return <main className="public-dispute-page"><header><FileText size={28} /><div><span>Field Compliance Manager</span><h1>Submit a dispute</h1><p>Provide the notice details and your reasons for review. Your submission will be assessed by the issuing organization.</p></div></header>{submitted ? <section className="public-dispute-result"><CheckCircle2 size={24} /><h2>Dispute received</h2><p>Your submission has been recorded for review. Keep your notice number for your records.</p></section> : <form onSubmit={submit}><h2>Notice and contact details</h2>{error && <div className="public-dispute-error" role="alert"><AlertTriangle size={16} />{error}</div>}<div className="public-dispute-grid"><label>Notice number<input value={form.noticeNumber} onChange={(event) => setForm({ ...form, noticeNumber: event.target.value })} /></label><label>Notice type<select value={form.disputeType} onChange={(event) => setForm({ ...form, disputeType: event.target.value })}><option value="infringement">Infringement notice</option><option value="notice_to_vacate">Notice to vacate</option><option value="other">Other</option></select></label><label>Vehicle plate<input value={form.plateNumber} onChange={(event) => setForm({ ...form, plateNumber: event.target.value })} /></label><label>Notice date<input type="date" value={form.noticeDate} onChange={(event) => setForm({ ...form, noticeDate: event.target.value })} /></label><label>Full name<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label>Email<input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label><label>Phone<input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label><label>SCV number<input value={form.scvNumber} onChange={(event) => setForm({ ...form, scvNumber: event.target.value })} /></label></div><fieldset><legend>Grounds for dispute</legend>{GROUNDS.map((ground) => <label key={ground}><input type="checkbox" checked={grounds.includes(ground)} onChange={() => toggleGround(ground)} />{ground}</label>)}</fieldset><label className="public-dispute-statement">Statement<textarea required rows={7} value={form.statement} onChange={(event) => setForm({ ...form, statement: event.target.value })} placeholder="Explain why you are disputing this notice." /></label><button type="submit" disabled={saving || grounds.length === 0 || !form.name.trim() || !form.statement.trim()}><Send size={16} />{saving ? 'Submitting' : 'Submit dispute'}</button></form>}</main>;
}
