import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Bot, CheckCircle2, CircleHelp, FileCheck2, LockKeyhole, RefreshCw, Sparkles } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './FinanceOwnerGuide.css';
import './FinanceOwnerBrief.css';

type FinanceOwnerGuideProps = { onOpenBob?: () => void };
type OwnerBrief = { headline: string; priorities: Array<{ kind: string; title: string; detail: string }>; checked_at: string };
type Readiness = { overall_score: number; checks: Array<{ source_key: string; title: string; status: 'ready' | 'partial' | 'gap'; score: number }> };

const questions = [
  { icon: CircleHelp, title: 'What needs my attention?', detail: 'Bob reviews your numbers and explains the few items that matter today.' },
  { icon: FileCheck2, title: 'Prepare my month-end checklist', detail: 'Bob checks costs, invoices, GST, payments, and missing approvals.' },
  { icon: Sparkles, title: 'Explain my business finances', detail: 'Bob translates the latest results into plain language and practical choices.' },
];

export function FinanceOwnerGuide({ onOpenBob }: FinanceOwnerGuideProps) {
  const { profile } = useAuth();
  const [brief, setBrief] = useState<OwnerBrief | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [assessing, setAssessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadBrief = useCallback(async () => {
    if (!profile?.organizationId) return;
    setLoading(true); setError(null);
    const { data, error: briefError } = await supabase.rpc('get_finance_owner_brief');
    if (briefError) setError(briefError.message); else setBrief(data as OwnerBrief);
    setLoading(false);
  }, [profile?.organizationId]);
  useEffect(() => { void loadBrief(); }, [loadBrief]);
  const assessReadiness = async () => {
    setAssessing(true);
    const { data } = await supabase.rpc('assess_bob_nz_finance_readiness');
    if (data) setReadiness(data as Readiness);
    setAssessing(false);
  };

  return <section className="finance-owner-guide" aria-labelledby="finance-owner-guide-heading">
    <div className="finance-owner-guide-intro"><div className="finance-owner-guide-icon"><Bot size={20} /></div><div><p className="finance-owner-eyebrow">Your finance co-pilot</p><h2 id="finance-owner-guide-heading">You do not need to be an accountant</h2><p>Bob can gather the records, do the maths, explain what changed, and prepare the next step. You stay in control of approvals, filing, and payments.</p></div></div>
    <div className="finance-owner-actions">{questions.map(({ icon: Icon, title, detail }) => <button key={title} type="button" className="finance-owner-action" onClick={onOpenBob} disabled={!onOpenBob}><Icon size={16} /><span><strong>{title}</strong><small>{detail}</small></span><span className="finance-owner-action-arrow">Ask Bob</span></button>)}</div>
    <div className="finance-owner-brief" aria-live="polite"><div className="finance-owner-brief-heading"><strong>Bob's quick check</strong><button type="button" className="finance-owner-refresh" onClick={() => void loadBrief()} disabled={loading} title="Run the finance check again"><RefreshCw size={13} /></button></div>{loading ? <p>Bob is checking your finance records...</p> : error ? <p className="finance-owner-error"><AlertTriangle size={14} />{error}</p> : <><p className="finance-owner-headline">{brief?.headline}</p>{brief?.priorities.length ? <ul>{brief.priorities.slice(0, 4).map((priority) => <li key={`${priority.kind}-${priority.title}`}><strong>{priority.title}</strong><span>{priority.detail}</span></li>)}</ul> : null}</>}</div>
    <div className="finance-owner-readiness"><div><strong>How ready are we for NZ finance?</strong><small>This is a readiness check, not a legal compliance certificate.</small></div><button type="button" className="finance-owner-check" onClick={() => void assessReadiness()} disabled={assessing}>{assessing ? 'Checking...' : 'Check now'}</button></div>
    {readiness && <div className="finance-owner-results" aria-live="polite"><strong>Readiness snapshot: {readiness.overall_score}%</strong><div>{readiness.checks.map((check) => <span key={check.source_key} className={`finance-owner-result status-${check.status}`} title={check.title}>{check.status === 'ready' ? 'Ready' : check.status === 'partial' ? 'Partly ready' : 'Gap'}<small>{check.title}</small></span>)}</div></div>}
    <div className="finance-owner-boundary"><LockKeyhole size={15} /><span><strong>Human approval stays with you.</strong> Bob will never file tax, close a period, pay a bill, or change a number without showing you what he found and asking first.</span><CheckCircle2 size={15} /></div>
  </section>;
}
