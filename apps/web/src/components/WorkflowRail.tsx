import { Check, ChevronRight } from 'lucide-react';
import type { NavigateWithContext, WorkflowContext } from '../lib/workflowNavigation';
import './WorkflowRail.css';

const STEPS = [
  { page: 'crm', label: 'Account' },
  { page: 'relationships', label: 'Agreement' },
  { page: 'onboarding', label: 'Onboarding' },
  { page: 'locations', label: 'Places' },
  { page: 'roster', label: 'Roster' },
  { page: 'handoffs', label: 'Handoff' },
];

export function WorkflowRail({ activePage, context, onNavigate }: { activePage: string; context: WorkflowContext; onNavigate: NavigateWithContext }) {
  const workflowPage = ['site-360', 'zones', 'sites'].includes(activePage) ? 'locations' : activePage === 'roster-targets' ? 'roster' : activePage;
  const activeIndex = STEPS.findIndex((step) => step.page === workflowPage);
  if (activeIndex < 0) return null;
  return <nav className="workflow-rail" aria-label="Account operations workflow">
    <span className="workflow-rail-label">Account flow</span>
    <div>{STEPS.map((step, index) => <span key={step.page} className="workflow-rail-step"><button type="button" className={index === activeIndex ? 'is-current' : index < activeIndex ? 'is-complete' : ''} aria-current={index === activeIndex ? 'step' : undefined} onClick={() => onNavigate(step.page, context)}><i>{index < activeIndex ? <Check size={12} /> : index + 1}</i>{step.label}</button>{index < STEPS.length - 1 && <ChevronRight size={13} />}</span>)}</div>
  </nav>;
}