import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, CircleHelp, X } from 'lucide-react';
import './HelpInstructions.css';

type HelpInstructionsProps = {
  context?: string;
  role?: string;
};

type HelpContent = {
  title: string;
  summary: string;
  steps: string[];
  next: string;
};

const HELP_CONTENT: Record<string, HelpContent> = {
  finance: {
    title: 'Using Finance',
    summary: 'Bob checks the records and prepares the work. You review decisions before anything is submitted or paid.',
    steps: ['Start at Finance home and choose the task that matches what you need.', 'Ask Bob what needs attention if you are unsure.', 'Review the numbers, assumptions, and missing information Bob shows you.', 'Approve only when the result matches your records.'],
    next: 'For ANZ or IRD, the process stops at the secure provider authorisation step until you confirm it.',
  },
  crm: {
    title: 'Using Client Portfolios',
    summary: 'Keep each client, agreement, site, service, and commercial decision together in one place.',
    steps: ['Open the client portfolio you want to work on.', 'Use the sections for places, agreements, people, services, and finance.', 'Save drafts first, then review the evidence before activating anything.', 'Use Bob when you need records found, compared, or prepared.'],
    next: 'The next person should see the saved record, its status, and any outstanding approval.',
  },
  roster: {
    title: 'Using Schedules and Rosters',
    summary: 'Build coverage from approved people, work units, availability, and service requirements.',
    steps: ['Choose the work unit and date range.', 'Check capability, leave, and overlap warnings.', 'Create or edit the draft assignment.', 'Publish only after the coverage and commercial checks are clear.'],
    next: 'Published work becomes visible to the assigned officer and feeds attendance and costing.',
  },
  field: {
    title: 'Using Field Operations',
    summary: 'Work from the live queue, record what happened, and preserve evidence for the next decision.',
    steps: ['Open the item assigned to you or needing review.', 'Read the site, safety, and access instructions first.', 'Record the outcome and attach evidence where required.', 'Close or escalate the item with a clear next action.'],
    next: 'A completed field record can feed reports, client visibility, finance, and follow-up work.',
  },
  reports: {
    title: 'Using Reports',
    summary: 'Reports turn approved operational records into a reviewable account of work delivered.',
    steps: ['Choose the reporting period and service context.', 'Check that the source records are complete.', 'Review exceptions and missing evidence.', 'Generate or submit only after the review is complete.'],
    next: 'A report should leave a clear receipt, owner, period, and source trail.',
  },
  default: {
    title: 'Using this workspace',
    summary: 'Start with the main action, check the status and evidence, then choose the next safe step.',
    steps: ['Read the page heading and current organisation or service context.', 'Use the primary action or ask Bob to explain the workflow.', 'Review warnings, missing information, and permissions before saving.', 'Confirm the success receipt and what happens next.'],
    next: 'If something is unclear, ask Bob what the next safe action is.',
  },
};

function contentFor(context: string | undefined): HelpContent {
  const value = (context ?? '').toLowerCase();
  if (value.includes('finance')) return HELP_CONTENT.finance;
  if (value.includes('crm') || value.includes('client') || value.includes('relationship')) return HELP_CONTENT.crm;
  if (value.includes('roster') || value.includes('schedule') || value.includes('people')) return HELP_CONTENT.roster;
  if (value.includes('field') || value.includes('dispatch') || value.includes('patrol') || value.includes('scan')) return HELP_CONTENT.field;
  if (value.includes('report')) return HELP_CONTENT.reports;
  return HELP_CONTENT.default;
}

export function HelpInstructions({ context, role }: HelpInstructionsProps) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const content = useMemo(() => contentFor(context), [context]);

  useEffect(() => { setOpen(false); setExpanded(true); }, [context]);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);

  return <>
    <button type="button" className="help-instructions-trigger" onClick={() => setOpen(true)} aria-label={`Open instructions for ${content.title}`} title="How do I use this?"><CircleHelp size={18} /><span>?</span></button>
    {open && <div className="help-instructions-backdrop" role="presentation" onClick={() => setOpen(false)}>
      <section className="help-instructions-panel" role="dialog" aria-modal="true" aria-labelledby="help-instructions-title" onClick={(event) => event.stopPropagation()}>
        <header><div><span className="help-instructions-kicker">Quick instructions{role ? ` · ${role.replaceAll('_', ' ')}` : ''}</span><h2 id="help-instructions-title">{content.title}</h2></div><button type="button" className="help-instructions-close" onClick={() => setOpen(false)} aria-label="Close instructions"><X size={18} /></button></header>
        <p className="help-instructions-summary">{content.summary}</p>
        <button type="button" className="help-instructions-section-toggle" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}><strong>How to use it</strong><ChevronDown size={16} className={expanded ? 'is-expanded' : ''} /></button>
        {expanded && <ol>{content.steps.map((step) => <li key={step}>{step}</li>)}</ol>}
        <div className="help-instructions-next"><strong>What happens next</strong><p>{content.next}</p></div>
      </section>
    </div>}
  </>;
}
