/** Plain words for the live officer map: what an officer is doing, how old the last fix is, and how safe they are. */
import type { SafetyStatus } from '../hooks/useOfficerSafety';
import type { OfficerPinStatus } from './officerPinStatus';
import { plainWords } from './rosterWords';

export interface LiveShift { id: string; status: string; scheduled_start: string; scheduled_end: string; organization_id: string; organization_name: string | null; service_type: string | null; zone_id: string | null; route_name: string | null; work_unit_name: string | null }
export interface LiveWelfare { enabled: boolean | null; check_interval_minutes: number | null; last_checkin_at: string | null }
export interface LiveAlert { id: string; alert_type: string; status: string; triggered_at: string }
/** The contracted place a current shift is for, and whether the latest fix is on it. */
export interface LiveSite { id: string; name: string; on_site: boolean | null; distance_m: number | null }
export interface LiveOfficer {
  officer_id: string; officer_name: string; home_organization_id: string | null;
  gps_lat: number | null; gps_lng: number | null; accuracy_meters: number | null; heading: number | null; speed_kmh: number | null;
  activity_type: string | null; recorded_at: string | null; physical_address: string | null; detected_zone_id: string | null; zone_name: string | null;
  position_organization_id: string | null; shift: LiveShift | null; welfare: LiveWelfare | null; alert: LiveAlert | null;
  site?: LiveSite | null;
}

const distanceWords = (metres: number): string => metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(1)} km`;

/** `On site at X`, `500 m from X`, or `X` when there is no fix to measure. */
export const sitePresenceWords = (site: LiveSite): string => {
  if (site.on_site) return `on site at ${site.name}`;
  if (site.on_site === false && site.distance_m != null) return `${distanceWords(site.distance_m)} from ${site.name}`;
  return `for ${site.name}`;
};

export const STATUS_LABEL: Record<OfficerPinStatus, string> = {
  ok: 'Safety OK', due: 'Check-in due', overdue: 'Check-in overdue', alerting: 'Active alert', offline: 'GPS offline', unknown: 'Safety unknown',
};
export const clock = (value: string | null | undefined) => value ? new Date(value).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' }) : '';
const ALERT_WORDS: Record<string, string> = { sos: 'SOS', man_down: 'Man down', armed_danger: 'Armed danger', overdue: 'Check-in overdue', missed: 'Missed check-in', inactivity: 'No movement', gps_lost: 'GPS lost', manual: 'Raised by hand', investigation_overdue: 'Investigation overdue' };
export const alertWords = (type: string): string => ALERT_WORDS[type] ?? plainWords(type);

/** `3m ago`, `2h ago`, or `No fix` — how old the last position is, in the words the dispatcher uses. */
export const gpsAgeWords = (recordedAt: string | null, nowMs = Date.now()): string => {
  if (!recordedAt) return 'No fix';
  const minutes = Math.max(0, Math.floor((nowMs - new Date(recordedAt).getTime()) / 60_000));
  return minutes < 1 ? 'Just now' : minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
};

/** What the officer is doing, from the shift and the last breadcrumb. */
export const officerActivityWords = (officer: Pick<LiveOfficer, 'shift' | 'activity_type' | 'speed_kmh' | 'zone_name' | 'site'>): string => {
  const parts: string[] = [];
  if (officer.shift) parts.push(`${officer.shift.status === 'in_progress' ? 'On shift' : officer.shift.status === 'accepted' ? 'Shift accepted' : 'Shift offered'} · ${officer.shift.work_unit_name ?? officer.shift.route_name ?? plainWords(officer.shift.service_type ?? '', 'Field work')} · ${clock(officer.shift.scheduled_start)}–${clock(officer.shift.scheduled_end)}`);
  else if (officer.activity_type) parts.push(officer.activity_type === 'sos' ? 'SOS raised' : officer.activity_type === 'active_welfare_alert' ? 'Welfare alert open' : plainWords(officer.activity_type.replace('gps_update', 'position update')));
  if (officer.shift && officer.site) parts.push(sitePresenceWords(officer.site));
  else if (officer.zone_name) parts.push(`in ${officer.zone_name}`);
  if (officer.speed_kmh != null && officer.speed_kmh >= 1) parts.push(`${officer.speed_kmh.toFixed(0)} km/h`);
  return parts.join(' · ') || 'Off shift';
};

/** The safety words on the row: a headline status, and the check-in clock (next or first due) while the officer is on a running shift. */
export const safetyWords = (officer: Pick<LiveOfficer, 'welfare' | 'shift' | 'alert'>, pinStatus: OfficerPinStatus, safety: SafetyStatus | null, nowMs = Date.now()): { headline: string; detail: string | null } => {
  if (officer.alert) return { headline: STATUS_LABEL.alerting, detail: `${alertWords(officer.alert.alert_type)} ${clock(officer.alert.triggered_at)}` };
  const interval = officer.welfare?.check_interval_minutes;
  const since = officer.welfare?.last_checkin_at ?? (officer.shift && new Date(officer.shift.scheduled_start).getTime() <= nowMs ? officer.shift.scheduled_start : null);
  if (!(officer.welfare?.enabled && interval && since && safety && safety !== 'alerting')) return { headline: STATUS_LABEL[pinStatus], detail: null };
  const dueAt = clock(new Date(new Date(since).getTime() + interval * 60_000).toISOString());
  const detail = officer.welfare.last_checkin_at ? `Checked in ${clock(officer.welfare.last_checkin_at)} · next due ${dueAt}` : `No check-in yet · first due ${dueAt}`;
  // Offline GPS does not quieten an overdue check-in: both facts are said.
  if (pinStatus === 'offline' && safety !== 'ok') return { headline: `${STATUS_LABEL.offline} · ${STATUS_LABEL[safety].toLowerCase()}`, detail };
  return { headline: STATUS_LABEL[pinStatus], detail };
};
