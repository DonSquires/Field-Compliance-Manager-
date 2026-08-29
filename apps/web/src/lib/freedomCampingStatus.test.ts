import { describe, expect, it } from 'vitest';
import { formatComplianceReason } from './freedomCampingStatus';

describe('formatComplianceReason', () => {
  it('formats schema compliance reasons into human-readable labels', () => {
    expect(formatComplianceReason('consecutive_night_limit_exceeded')).toBe('Consecutive night limit exceeded');
    expect(formatComplianceReason('monthly_limit_exceeded')).toBe('Monthly night limit exceeded');
    expect(formatComplianceReason('no_overnight_permitted')).toBe('No overnight camping permitted in this zone');
    expect(formatComplianceReason('no_scv_certificate')).toBe('Active SCV certificate required');
    expect(formatComplianceReason('no_rules_configured')).toBe('No compliance rules configured for this zone');
    expect(formatComplianceReason('compliant')).toBe('Compliant');
  });

  it('handles unknown or custom reason strings gracefully', () => {
    expect(formatComplianceReason('custom_rule_breached')).toBe('Custom Rule Breached');
    expect(formatComplianceReason(null)).toBe('');
    expect(formatComplianceReason(undefined)).toBe('');
  });
});
