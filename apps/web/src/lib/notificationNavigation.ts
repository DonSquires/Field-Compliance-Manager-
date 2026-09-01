import type { AppRole } from '../context/AuthContext';
import type { NotificationRecord } from '../components/NotificationCenter';

export type NotificationDestination =
  | { kind: 'admin_page'; page: string }
  | { kind: 'admin_field_ops'; area: string }
  | { kind: 'admin_hr_credential'; credentialId: string | null }
  | { kind: 'officer_module'; module: string | null }
  | { kind: 'client_page'; page: string }
  | { kind: 'bob'; conversationId: string | null };

export function resolveNotificationDestination(role: AppRole, notification: NotificationRecord): NotificationDestination | null {
  const link = notification.link_page;
  const conversationId = typeof notification.link_payload?.conversation_id === 'string' ? notification.link_payload.conversation_id : null;
  const credentialId = typeof notification.link_payload?.credential_id === 'string' ? notification.link_payload.credential_id : null;

  if (notification.category === 'bob_conversation' || link === 'bob_chat') return { kind: 'bob', conversationId };

  if (role === 'grand_master' || role === 'master' || role === 'admin' || role === 'admin_officer') {
    if (link === 'WelfareAlertsPage' || notification.category === 'welfare') return { kind: 'admin_field_ops', area: 'welfare-alerts' };
    if (link === 'open-jobs' || notification.category === 'dispatch') return { kind: 'admin_field_ops', area: 'dispatch' };
    if (link === 'roster') return { kind: 'admin_page', page: 'roster' };
    if (link === 'credential-expiry' || notification.category === 'credential_expiry') return { kind: 'admin_hr_credential', credentialId };
    if (notification.category === 'report_ready') return { kind: 'admin_page', page: 'reports' };
    if (notification.category === 'schema_change_request' || notification.category === 'bob_self_memory') return { kind: 'admin_page', page: 'approvals' };
    return null;
  }

  if (role === 'officer') {
    if (link === 'open-jobs' || link === 'roster' || notification.category === 'open_job' || notification.category === 'roster') return { kind: 'officer_module', module: null };
    if (notification.category === 'dispatch') return { kind: 'officer_module', module: 'dispatch' };
    if (notification.category === 'welfare') return { kind: 'officer_module', module: null };
    return null;
  }

  if (role === 'client_admin' || role === 'client_officer' || role === 'client_viewer') {
    if (notification.category === 'report_ready') return { kind: 'client_page', page: 'reports' };
  }
  return null;
}