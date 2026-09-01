export interface WorkflowContext {
  accountId?: string;
  agreementId?: string;
  ledgerId?: string;
  locationId?: string;
  siteId?: string;
  zoneId?: string;
  workUnitId?: string;
  handoffId?: string;
}

export type NavigateWithContext = (destination: string, context?: WorkflowContext) => void;

const PARAMS: Array<[keyof WorkflowContext, string]> = [
  ['accountId', 'account'], ['agreementId', 'agreement'], ['ledgerId', 'ledger'], ['locationId', 'location'],
  ['siteId', 'site'], ['zoneId', 'zone'], ['workUnitId', 'work_unit'], ['handoffId', 'handoff'],
];

export function readWorkflowContext(search: string): WorkflowContext {
  const params = new URLSearchParams(search);
  return Object.fromEntries(PARAMS.flatMap(([key, param]) => {
    const value = params.get(param);
    return value ? [[key, value]] : [];
  })) as WorkflowContext;
}

export function workflowContextQuery(context: WorkflowContext = {}): string {
  const params = new URLSearchParams();
  for (const [key, param] of PARAMS) {
    const value = context[key];
    if (value) params.set(param, value);
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}