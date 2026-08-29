import { describe, expect, it } from 'vitest';
import { schemaWelfareAlertStatus, type WelfareAlertStatus } from './welfareAlertStatus';

describe('welfare alert schema mapping', () => {
  it('normalizes legacy UI states to the real welfare_alerts lifecycle', () => {
    expect(schemaWelfareAlertStatus('open')).toBe('pending');
    expect(schemaWelfareAlertStatus('pending')).toBe('pending');
    expect(schemaWelfareAlertStatus('acknowledged')).toBe('acknowledged');
    expect(schemaWelfareAlertStatus('resolved')).toBe('resolved');
  });

  it('keeps status typing aligned with live schema semantics', () => {
    const onlySchemaValues: WelfareAlertStatus[] = ['pending', 'acknowledged', 'resolved'];
    expect(onlySchemaValues).toContain(schemaWelfareAlertStatus('open'));
    expect(onlySchemaValues).toContain(schemaWelfareAlertStatus('pending'));
    expect(onlySchemaValues).toContain(schemaWelfareAlertStatus('acknowledged'));
    expect(onlySchemaValues).toContain(schemaWelfareAlertStatus('resolved'));
  });
});
