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
    expect(resolveNotificationDestination('admin', notification({ category: 'document_review', link_page: 'approvals' }))).toEqual({ kind: 'admin_page', page: 'approvals' });
    expect(resolveNotificationDestination('admin', notification({ category: 'document_review', link_page: 'document-studio' }))).toEqual({ kind: 'admin_page', page: 'document-studio' });
    expect(resolveNotificationDestination('admin', notification({ category: 'crm_client', link_page: 'crm', link_payload: { account_organization_id: 'client-1', agreement_id: 'a-1' } }))).toEqual({ kind: 'admin_crm_account', accountId: 'client-1' });
    expect(resolveNotificationDestination('grand_master', notification({ category: 'builder_job', link_page: 'builder', link_payload: { job_id: 'job-1' } }))).toEqual({ kind: 'admin_page', page: 'builder' });
  });

  it('maps officer open work to home and client reports to reports', () => {
    expect(resolveNotificationDestination('officer', notification({ category: 'open_job', link_page: 'open-jobs' }))).toEqual({ kind: 'officer_module', module: null });
    expect(resolveNotificationDestination('officer', notification({ category: 'report_reviewed', link_payload: { report_id: 'report-1' } }))).toEqual({ kind: 'officer_report', reportId: 'report-1' });
    expect(resolveNotificationDestination('officer', notification({ category: 'leave_decision', link_payload: { leave_request_id: 'leave-1' } }))).toEqual({ kind: 'officer_leave', leaveRequestId: 'leave-1' });
    expect(resolveNotificationDestination('officer', notification({ category: 'timesheet_decision', link_payload: { timesheet_id: 'timesheet-1' } }))).toEqual({ kind: 'officer_timesheet', timesheetId: 'timesheet-1' });
    expect(resolveNotificationDestination('officer', notification({ category: 'roster', link_page: 'schedule', link_payload: { roster_slot_id: 'slot-1' } }))).toEqual({ kind: 'officer_schedule', rosterSlotId: 'slot-1' });
    expect(resolveNotificationDestination('officer', notification({ category: 'dispatch', link_page: 'dispatch', link_payload: { dispatch_job_id: 'job-1' } }))).toEqual({ kind: 'officer_dispatch', dispatchJobId: 'job-1' });
    expect(resolveNotificationDestination('officer', notification({ category: 'breach_decision', link_payload: { breach_alert_id: 'breach-1' } }))).toEqual({ kind: 'officer_breach', breachAlertId: 'breach-1' });
    expect(resolveNotificationDestination('officer', notification({ category: 'debrief_followup', link_payload: { debrief_id: 'debrief-1' } }))).toEqual({ kind: 'officer_debrief', debriefId: 'debrief-1' });
    expect(resolveNotificationDestination('officer', notification({ category: 'noise_review', link_payload: { assessment_id: 'noise-1' } }))).toEqual({ kind: 'officer_noise', assessmentId: 'noise-1' });
    expect(resolveNotificationDestination('client_viewer', notification({ category: 'report_ready' }))).toEqual({ kind: 'client_page', page: 'reports' });
    expect(resolveNotificationDestination('officer', notification({ category: 'builder_job', link_page: 'builder' }))).toBeNull();
  });

  it('returns null for unsupported links instead of guessing', () => {
    expect(resolveNotificationDestination('officer', notification({ link_page: 'obligations' }))).toBeNull();
  });
});