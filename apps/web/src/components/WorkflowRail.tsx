import { ChevronRight } from 'lucide-react';
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
    <div>{STEPS.map((step, index) => <span key={step.page} className="workflow-rail-step"><button type="button" className={index === activeIndex ? 'is-current' : ''} aria-current={index === activeIndex ? 'step' : undefined} onClick={() => onNavigate(step.page, context)}><i>{index + 1}</i>{step.label}</button>{index < STEPS.length - 1 && <ChevronRight size={13} />}</span>)}</div>
    <select className="workflow-rail-select" aria-label="Account workflow destination" value={workflowPage} onChange={(event) => onNavigate(event.target.value, context)}>
      {STEPS.map((step) => <option key={step.page} value={step.page}>{step.label}</option>)}
    </select>
  </nav>;
}