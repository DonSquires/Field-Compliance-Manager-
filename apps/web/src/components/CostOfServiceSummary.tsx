import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CircleDollarSign, RefreshCw } from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
  type CostOfServiceSummary as Summary,
  costTypeLabel,
  formatHours,
  formatMoney,
  missingSteps,
  monthWindow,
  normaliseCostOfService,
} from '../lib/costOfService';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string; denied: boolean }
  | { status: 'ready'; summary: Summary };

export default function CostOfServiceSummary({ organizationId, monthsBack }: { organizationId: string; monthsBack: number }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const range = monthWindow(monthsBack);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    // ATLAS CALLS: get_cost_of_service_summary
    const { data, error } = await supabase.rpc('get_cost_of_service_summary', {
      p_organization_id: organizationId,
      p_from: range.from,
      p_to: range.to,
    });
    if (error) {
      const denied = error.code === '42501' || /not authori[sz]ed|permission/i.test(error.message);
      setState({ status: 'error', denied, message: denied
        ? 'You need finance or organisation admin access to see cost of service for this organisation.'
        : `Cost of service could not be loaded: ${error.message}` });
      return;
    }
    try {
      setState({ status: 'ready', summary: normaliseCostOfService(data) });
    } catch (failure) {
      setState({ status: 'error', denied: false, message: failure instanceof Error ? failure.message : 'Cost of service could not be read.' });
    }
  }, [organizationId, range.from, range.to]);

  useEffect(() => { void load(); }, [load]);

  return <section className="cost-of-service-panel" aria-labelledby="cost-of-service-agreements">
    <header>
      <div>
        <h2 id="cost-of-service-agreements"><CircleDollarSign size={17} aria-hidden="true" />Cost by client agreement</h2>
        <p>Posted costs come from the finance ledger. Labour not yet posted is shown as a separate estimate. Missing timesheets, approvals or pay rules are listed as steps, never counted as $0.</p>
      </div>
      <button type="button" onClick={() => void load()} disabled={state.status === 'loading'}><RefreshCw size={14} aria-hidden="true" />Refresh</button>
    </header>

    {state.status === 'loading' && <p className="cost-of-service-muted" role="status">Loading cost of service…</p>}
    {state.status === 'error' && <p className="cost-of-service-message" role="alert"><AlertTriangle size={17} aria-hidden="true" />{state.message}</p>}
    {state.status === 'ready' && (() => {
      const { agreements, unattributed } = state.summary;
      const active = agreements.filter((row) => row.posted.total || row.labour.workedShifts || row.labour.inProgressShifts || row.callouts.completedJobs);
      if (!active.length && !unattributed.workedShifts && !unattributed.completedJobs) {
        return <p className="cost-of-service-muted" role="status">No worked shifts, completed callouts or posted costs in this window.</p>;
      }
      return <>
        {active.map((row) => {
          const steps = missingSteps(row);
          return <article className="cost-of-service-agreement" key={row.agreementId} aria-label={row.agreementName}>
            <header>
              <h3>{row.agreementName}</h3>
              {row.clientName && <span>{row.clientName}</span>}
            </header>
            <dl>
              <div>
                <dt>Posted cost</dt>
                <dd>{row.posted.byType.length ? formatMoney(row.posted.total) : 'Nothing posted yet'}</dd>
                {row.posted.byType.length > 0 && <small>{row.posted.byType.map((item) => `${costTypeLabel(item.costType)} ${formatMoney(item.total)}`).join(' · ')}</small>}
              </div>
              <div>
                <dt>Worked</dt>
                <dd>{formatHours(row.labour.hours)}</dd>
                <small>{row.labour.workedShifts} shift{row.labour.workedShifts === 1 ? '' : 's'} · {row.labour.postedShifts} posted{row.labour.inProgressShifts ? ` · ${row.labour.inProgressShifts} in progress` : ''}</small>
              </div>
              <div>
                <dt>Labour estimate, not posted</dt>
                <dd>{row.labour.estimatedShifts ? formatMoney(row.labour.estimateNotPosted) : 'No estimate'}</dd>
                <small>{row.labour.estimatedShifts ? `${row.labour.estimatedShifts} shift${row.labour.estimatedShifts === 1 ? '' : 's'} at the applicable pay rate` : 'No unposted shift has a resolvable rate'}</small>
              </div>
              <div>
                <dt>Callouts</dt>
                <dd>{row.callouts.completedJobs ? `${row.callouts.completedJobs} completed` : 'None'}</dd>
                {row.callouts.completedJobs > 0 && <small>Pay lines {formatMoney(row.callouts.payLineTotal)}{row.callouts.notPostedPayTotal ? ` · ${formatMoney(row.callouts.notPostedPayTotal)} not posted` : ''}</small>}
              </div>
            </dl>
            {steps.length > 0 && <div className="cost-of-service-steps">
              <strong>To complete the cost picture</strong>
              <ul>{steps.map((step) => <li key={step.key}>{step.text} <Link to={step.href}>{step.action}</Link></li>)}</ul>
            </div>}
          </article>;
        })}
        {(unattributed.workedShifts > 0 || unattributed.completedJobs > 0) && <p className="cost-of-service-message is-warning" role="note">
          <AlertTriangle size={17} aria-hidden="true" />
          {unattributed.workedShifts} worked shift{unattributed.workedShifts === 1 ? '' : 's'} ({formatHours(unattributed.hours)}) and {unattributed.completedJobs} completed callout{unattributed.completedJobs === 1 ? '' : 's'} are not linked to a client agreement, so they cannot be costed to a client. Link the work unit or place to an agreement.
        </p>}
      </>;
    })()}
  </section>;
}
