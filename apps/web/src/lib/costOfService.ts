// Normalises get_cost_of_service_summary (version 1). Missing values stay null
// so the UI never presents unknown cost as $0.

export interface CostByType { costType: string; total: number }

export interface AgreementCost {
  agreementId: string;
  agreementName: string;
  clientName: string | null;
  posted: { total: number; byType: CostByType[] };
  labour: {
    workedShifts: number;
    inProgressShifts: number;
    hours: number;
    postedShifts: number;
    estimateNotPosted: number;
    estimatedShifts: number;
    rateUnresolvedShifts: number;
    missingSteps: { noTimesheet: number; timesheetNotApproved: number; approvedNotPosted: number };
  };
  callouts: {
    completedJobs: number;
    postedJobs: number;
    payLineTotal: number;
    notPostedPayTotal: number;
    unresolvedPayLines: number;
    jobsWithoutPayLines: number;
  };
}

export interface CostOfServiceSummary {
  window: { from: string; to: string };
  agreements: AgreementCost[];
  unattributed: { workedShifts: number; hours: number; completedJobs: number };
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {});
const num = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);

export function normaliseCostOfService(raw: unknown): CostOfServiceSummary {
  const root = obj(raw);
  if (num(root.version) !== 1) throw new Error('Cost of service returned an unexpected format.');
  const window = obj(root.window);
  const agreements = (Array.isArray(root.agreements) ? root.agreements : []).flatMap((value): AgreementCost[] => {
    const row = obj(value);
    const agreementId = str(row.agreementId);
    if (!agreementId) return [];
    const posted = obj(row.posted);
    const labour = obj(row.labour);
    const steps = obj(labour.missingSteps);
    const callouts = obj(row.callouts);
    return [{
      agreementId,
      agreementName: str(row.agreementName) ?? 'Unnamed agreement',
      clientName: str(row.clientName),
      posted: {
        total: num(posted.total),
        byType: (Array.isArray(posted.byType) ? posted.byType : []).map((item) => {
          const entry = obj(item);
          return { costType: str(entry.costType) ?? 'other', total: num(entry.total) };
        }),
      },
      labour: {
        workedShifts: num(labour.workedShifts),
        inProgressShifts: num(labour.inProgressShifts),
        hours: num(labour.hours),
        postedShifts: num(labour.postedShifts),
        estimateNotPosted: num(labour.estimateNotPosted),
        estimatedShifts: num(labour.estimatedShifts),
        rateUnresolvedShifts: num(labour.rateUnresolvedShifts),
        missingSteps: {
          noTimesheet: num(steps.noTimesheet),
          timesheetNotApproved: num(steps.timesheetNotApproved),
          approvedNotPosted: num(steps.approvedNotPosted),
        },
      },
      callouts: {
        completedJobs: num(callouts.completedJobs),
        postedJobs: num(callouts.postedJobs),
        payLineTotal: num(callouts.payLineTotal),
        notPostedPayTotal: num(callouts.notPostedPayTotal),
        unresolvedPayLines: num(callouts.unresolvedPayLines),
        jobsWithoutPayLines: num(callouts.jobsWithoutPayLines),
      },
    }];
  });
  const unattributed = obj(root.unattributed);
  return {
    window: { from: str(window.from) ?? '', to: str(window.to) ?? '' },
    agreements,
    unattributed: {
      workedShifts: num(unattributed.workedShifts),
      hours: num(unattributed.hours),
      completedJobs: num(unattributed.completedJobs),
    },
  };
}

export interface MissingStep { key: string; text: string; href: string; action: string }

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

export function missingSteps(row: AgreementCost): MissingStep[] {
  const steps: MissingStep[] = [];
  const { missingSteps: m, rateUnresolvedShifts } = row.labour;
  if (m.noTimesheet) steps.push({ key: 'no-timesheet', text: `${plural(m.noTimesheet, 'worked shift')} ${m.noTimesheet === 1 ? 'has' : 'have'} no timesheet.`, href: '/admin/people-hr?tab=timesheets', action: 'Fill from schedule in Timesheets' });
  if (m.timesheetNotApproved) steps.push({ key: 'not-approved', text: `${plural(m.timesheetNotApproved, 'timesheet')} ${m.timesheetNotApproved === 1 ? 'is' : 'are'} awaiting approval.`, href: '/admin/people-hr?tab=timesheets', action: 'Review timesheets' });
  if (m.approvedNotPosted) steps.push({ key: 'not-posted', text: `${plural(m.approvedNotPosted, 'approved shift')} ${m.approvedNotPosted === 1 ? 'is' : 'are'} not yet posted as labour cost.`, href: '/admin/finance-money', action: 'Post in Finance > Labour costs' });
  if (rateUnresolvedShifts) steps.push({ key: 'rate', text: `${plural(rateUnresolvedShifts, 'shift')} ${rateUnresolvedShifts === 1 ? 'has' : 'have'} no applicable pay rate, so no estimate is shown for ${rateUnresolvedShifts === 1 ? 'it' : 'them'}.`, href: '/admin/rate-rules', action: 'Add a pay rule' });
  const c = row.callouts;
  if (c.unresolvedPayLines) steps.push({ key: 'callout-rate', text: `${plural(c.unresolvedPayLines, 'callout pay line')} could not be priced.`, href: '/admin/rate-rules', action: 'Add a callout pay rule' });
  if (c.jobsWithoutPayLines) steps.push({ key: 'callout-pay', text: `${plural(c.jobsWithoutPayLines, 'completed callout')} ${c.jobsWithoutPayLines === 1 ? 'has' : 'have'} no pay line yet.`, href: '/admin/people-hr?tab=timesheets', action: 'Check callout pay' });
  return steps;
}

export function monthWindow(monthsBack: number, today = new Date()): { from: string; to: string } {
  const pad = (value: number) => String(value).padStart(2, '0');
  const end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const start = new Date(today.getFullYear(), today.getMonth() - (monthsBack - 1), 1);
  const fmt = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return { from: fmt(start), to: fmt(end) };
}

const money = new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD' });
export const formatMoney = (value: number) => money.format(value);
export const formatHours = (value: number) => `${value.toLocaleString('en-NZ', { maximumFractionDigits: 2 })} h`;
export const costTypeLabel = (code: string) => code.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
