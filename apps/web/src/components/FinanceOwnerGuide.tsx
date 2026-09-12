import { Bot, CheckCircle2, CircleHelp, FileCheck2, LockKeyhole, Sparkles } from 'lucide-react';
import './FinanceOwnerGuide.css';

type FinanceOwnerGuideProps = { onOpenBob?: () => void };

const questions = [
  { icon: CircleHelp, title: 'What needs my attention?', detail: 'Bob reviews your numbers and explains the few items that matter today.' },
  { icon: FileCheck2, title: 'Prepare my month-end checklist', detail: 'Bob checks costs, invoices, GST, payments, and missing approvals.' },
  { icon: Sparkles, title: 'Explain my business finances', detail: 'Bob translates the latest results into plain language and practical choices.' },
];

export function FinanceOwnerGuide({ onOpenBob }: FinanceOwnerGuideProps) {
  return <section className="finance-owner-guide" aria-labelledby="finance-owner-guide-heading">
    <div className="finance-owner-guide-intro"><div className="finance-owner-guide-icon"><Bot size={20} /></div><div><p className="finance-owner-eyebrow">Your finance co-pilot</p><h2 id="finance-owner-guide-heading">You do not need to be an accountant</h2><p>Bob can gather the records, do the maths, explain what changed, and prepare the next step. You stay in control of approvals, filing, and payments.</p></div></div>
    <div className="finance-owner-actions">{questions.map(({ icon: Icon, title, detail }) => <button key={title} type="button" className="finance-owner-action" onClick={onOpenBob} disabled={!onOpenBob}><Icon size={16} /><span><strong>{title}</strong><small>{detail}</small></span><span className="finance-owner-action-arrow">Ask Bob</span></button>)}</div>
    <div className="finance-owner-boundary"><LockKeyhole size={15} /><span><strong>Human approval stays with you.</strong> Bob will never file tax, close a period, pay a bill, or change a number without showing you what he found and asking first.</span><CheckCircle2 size={15} /></div>
  </section>;
}
