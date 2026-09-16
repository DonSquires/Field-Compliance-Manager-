import { describe, expect, it } from 'vitest';
import {
  SAFETY_HAZARD_CLASSES,
  buildRaiseSafetyWarningArgs,
  describeWarningSource,
  hazardClassLabel,
  highestAlertLevel,
  safetyWarningTone,
  warningContactPath,
} from './safetyWarnings';

describe('safetyWarnings helpers', () => {
  it('labels hazard classes for untrained readers and falls back gracefully', () => {
    expect(hazardClassLabel('dangerous_dog')).toBe('Dangerous dog');
    expect(hazardClassLabel('something_new')).toBe('something new');
    expect(hazardClassLabel(null)).toBe('Hazard');
  });

  it('treats high and critical as danger, everything else as warning', () => {
    expect(safetyWarningTone('critical')).toBe('danger');
    expect(safetyWarningTone('high')).toBe('danger');
    expect(safetyWarningTone('medium')).toBe('warning');
    expect(safetyWarningTone(null)).toBe('warning');
  });

  it('finds the worst severity across warnings', () => {
    expect(highestAlertLevel([])).toBeNull();
    expect(highestAlertLevel([{ alert_level: 'low' }, { alert_level: 'critical' }, { alert_level: 'medium' }])).toBe('critical');
    expect(highestAlertLevel([{ alert_level: 'unrated' }])).toBe('low');
  });

  it('describes the source without leaking anything beyond the organisation name', () => {
    expect(describeWarningSource({ organization_name: 'R&M Security', is_own_organization: false })).toBe('Raised by R&M Security');
    expect(describeWarningSource({ organization_name: 'R&M Security', is_own_organization: true })).toBe('Raised by your organisation');
    expect(warningContactPath({ contact_email: ' ops@example.test ', contact_phone: null })).toEqual([' ops@example.test ']);
    expect(warningContactPath({ contact_email: null, contact_phone: '  ' })).toEqual([]);
  });

  it('shapes a valid raise_entity_flag call and rejects incomplete forms', () => {
    const args = buildRaiseSafetyWarningArgs(
      { entityType: 'vehicle', entityId: 'v-1', hazardClass: 'weapons', alertLevel: 'critical', note: '  Knife seen in the cab.  ' },
      'req-1'
    );
    expect(args).toEqual({
      p_client_request_id: 'req-1',
      p_entity_type: 'vehicle',
      p_entity_id: 'v-1',
      p_flag_type: 'safety_warning',
      p_alert_level: 'critical',
      p_reason: 'Knife seen in the cab.',
      p_hazard_class: 'weapons',
    });
    expect(() => buildRaiseSafetyWarningArgs({ entityType: 'site', entityId: 's-1', hazardClass: 'nope', alertLevel: 'high', note: 'Long enough note' }, 'r')).toThrow(/kind of hazard/);
    expect(() => buildRaiseSafetyWarningArgs({ entityType: 'site', entityId: 's-1', hazardClass: 'other', alertLevel: 'high', note: 'abc' }, 'r')).toThrow(/short note/);
    expect(SAFETY_HAZARD_CLASSES.map((entry) => entry.value)).toContain('medical_or_welfare');
  });
});
