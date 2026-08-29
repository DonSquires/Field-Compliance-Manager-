export type WelfareAlertStatus = 'pending' | 'acknowledged' | 'resolved';

export function schemaWelfareAlertStatus(status: string): WelfareAlertStatus {
  const canonical: Record<string, WelfareAlertStatus> = {
    open: 'pending',
    pending: 'pending',
    acknowledged: 'acknowledged',
    resolved: 'resolved',
  };

  return canonical[status] ?? (status as WelfareAlertStatus);
}
