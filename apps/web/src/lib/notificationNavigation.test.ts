import { describe, expect, it } from 'vitest';
import { resolveNotificationDestination } from './notificationNavigation';
import type { NotificationRecord } from '../components/NotificationCenter';

function notification(overrides: Partial<NotificationRecord>): NotificationRecord {
  return { id: 'n1', category: 'system', severity: 'info', title: 'Test', body: null, link_page: null, link_payload: null, read_at: null, created_at: new Date().toISOString(), ...overrides };
}

describe('notification navigation', () => {
  it('maps known admin operations without trusting arbitrary link strings', () => {
    expect(resolveNotificationDestination('admin', notification({ category: 'welfare', link_page: 'WelfareAlertsPage' }))).toEqual({ kind: 'admin_field_ops', area: 'welfare-alerts' });
    expect(resolveNotificationDestination('admin', notification({ category: 'schema_change_request' }))).toEqual({ kind: 'admin_page', page: 'approvals' });
    expect(resolveNotificationDestination('admin', notification({ category: 'credential_expiry', link_payload: { credential_id: 'credential-1' } }))).toEqual({ kind: 'admin_hr_credential', credentialId: 'credential-1' });
  });

  it('maps officer open work to home and client reports to reports', () => {
    expect(resolveNotificationDestination('officer', notification({ category: 'open_job', link_page: 'open-jobs' }))).toEqual({ kind: 'officer_module', module: null });
    expect(resolveNotificationDestination('client_viewer', notification({ category: 'report_ready' }))).toEqual({ kind: 'client_page', page: 'reports' });
  });

  it('returns null for unsupported links instead of guessing', () => {
    expect(resolveNotificationDestination('officer', notification({ link_page: 'obligations' }))).toBeNull();
  });
});