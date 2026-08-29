export function formatComplianceReason(reason: string | null | undefined): string {
  if (!reason) return '';

  const canonical: Record<string, string> = {
    consecutive_night_limit_exceeded: 'Consecutive night limit exceeded',
    monthly_limit_exceeded: 'Monthly night limit exceeded',
    no_overnight_permitted: 'No overnight camping permitted in this zone',
    no_overnight_yet: 'No overnight stay recorded yet',
    no_scv_certificate: 'Active SCV certificate required',
    no_rules_configured: 'No compliance rules configured for this zone',
    compliant: 'Compliant',
  };

  if (canonical[reason]) {
    return canonical[reason];
  }

  return reason
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
