import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Bot, CheckCircle2, CircleHelp, FileCheck2, LockKeyhole, RefreshCw, Sparkles } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './FinanceOwnerGuide.css';
import './FinanceOwnerBrief.css';

type FinanceOwnerGuideProps = { onOpenBob?: (prompt: string) => void };
type OwnerBrief = { headline: string; priorities: Array<{ kind: string; title: string; detail: string }>; checked_at: string };
type Readiness = { overall_score: number; checks: Array<{ source_key: string; title: string; status: 'ready' | 'partial' | 'gap'; score: number }> };

const questions = [
  { icon: CircleHelp, title: 'What needs my attention?', detail: 'Bob reviews your numbers and explains the few items that matter today.', prompt: 'Check the finance records for this organisation and tell me, in plain business language, what needs my attention today. Start with: money earned, money left after costs, tax money to set aside, customer payments to follow up, and any missing approvals. Ask me only for decisions you cannot safely make from the records.' },
  { icon: FileCheck2, title: 'Prepare my month-end checklist', detail: 'Bob checks costs, invoices, GST, payments, and missing approvals.', prompt: 'Prepare a plain-language month-end checklist for this organisation. Check costs, invoices, GST/tax preparation, customer payments, staff/pay items, missing approvals, and anything that blocks closing the month. Do not file, pay, close, or change records; list the next human decisions clearly.' },
  { icon: Sparkles, title: 'Explain my business finances', detail: 'Bob translates the latest results into plain language and practical choices.', prompt: 'Explain this organisation\'s finance position in simple terms for a business owner who is not an accountant. Avoid accounting jargon. Show what changed, why it matters, and the practical choices I need to make next.' },
  { icon: FileCheck2, title: 'Prepare a customer quote', detail: 'Bob gathers the job facts, checks costs, and drafts the quote for you to approve.', prompt: 'Help me prepare a customer quote with minimal effort from me. First inspect the CRM, agreement, site/place, roster, rate, and job-cost records available in this organisation. Tell me what is already known, ask only for missing facts, calculate what the job should cost, and draft the quote lines for human approval. Do not send the quote or change prices without approval.' },
];

export function FinanceOwnerGuide({ onOpenBob }: FinanceOwnerGuideProps) {
  const { profile } = useAuth();
  const [brief, setBrief] = useState<OwnerBrief | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [assessing, setAssessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadBrief = useCallback(async () => {
    if (!profile?.organizationId) {
      setError('Organisation access could not be confirmed. Finance guidance is unavailable.');
      setLoading(false);
      return;
    }
    setLoading(true); setError(null);
    const { data, error: briefError } = await supabase.rpc('get_finance_owner_brief');
    if (briefError) setError(briefError.message); else setBrief(data ? { ...(data as OwnerBrief), priorities: Array.isArray((data as OwnerBrief).priorities) ? (data as OwnerBrief).priorities : [] } : null);
    setLoading(false);
  }, [profile?.organizationId]);
  useEffect(() => { void loadBrief(); }, [loadBrief]);
  const assessReadiness = async () => {
    setAssessing(true);
    const { data } = await supabase.rpc('assess_bob_nz_finance_readiness');
    if (data) setReadiness({ ...(data as Readiness), checks: Array.isArray((data as Readiness).checks) ? (data as Readiness).checks : [] });
    setAssessing(false);
  };

  return <section className="finance-owner-guide" aria-labelledby="finance-owner-guide-heading">
    <div className="finance-owner-guide-intro"><div className="finance-owner-guide-icon"><Bot size={20} /></div><div><p className="finance-owner-eyebrow">Your finance co-pilot</p><h2 id="finance-owner-guide-heading">You do not need to be an accountant</h2><p>Bob can gather the records, do the maths, explain what changed, and prepare the next step. You stay in control of approvals, filing, and payments.</p></div></div>
    <div className="finance-owner-actions">{questions.map(({ icon: Icon, title, detail, prompt }) => <button key={title} type="button" className="finance-owner-action" onClick={() => onOpenBob?.(prompt)} disabled={!onOpenBob}><Icon size={16} /><span><strong>{title}</strong><small>{detail}</small></span><span className="finance-owner-action-arrow">Ask Bob</span></button>)}</div>
    <div className="finance-owner-brief" aria-live="polite"><div className="finance-owner-brief-heading"><strong>Bob's quick check</strong><button type="button" className="finance-owner-refresh" onClick={() => void loadBrief()} disabled={loading} title="Run the finance check again"><RefreshCw size={13} /></button></div>{loading ? <p>Bob is checking your finance records...</p> : error ? <p className="finance-owner-error"><AlertTriangle size={14} />{error}</p> : <>{brief?.headline ? <p className="finance-owner-headline">{brief.headline}</p> : <p>Finance records returned no headline. Run the check again or ask Bob for a plain-language review.</p>}{brief?.priorities.length ? <ul>{brief.priorities.slice(0, 4).map((priority) => <li key={`${priority.kind}-${priority.title}`}><strong>{priority.title}</strong><span>{priority.detail}</span></li>)}</ul> : null}</>}</div>
    <div className="finance-owner-readiness"><div><strong>How ready are we for NZ finance?</strong><small>This is a readiness check, not a legal compliance certificate.</small></div><button type="button" className="finance-owner-check" onClick={() => void assessReadiness()} disabled={assessing}>{assessing ? 'Checking...' : 'Check now'}</button></div>
    {readiness && <div className="finance-owner-results" aria-live="polite"><strong>Readiness snapshot: {readiness.overall_score}%</strong><div>{readiness.checks.map((check) => <span key={check.source_key} className={`finance-owner-result status-${check.status}`} title={check.title}>{check.status === 'ready' ? 'Ready' : check.status === 'partial' ? 'Partly ready' : 'Gap'}<small>{check.title}</small></span>)}</div></div>}
    <div className="finance-owner-boundary"><LockKeyhole size={15} /><span><strong>Human approval stays with you.</strong> Bob will never file tax, close a period, pay a bill, or change a number without showing you what he found and asking first.</span><CheckCircle2 size={15} /></div>
  </section>;
}
