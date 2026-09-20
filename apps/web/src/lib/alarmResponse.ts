/** Alarm response ladder: signal types, intake channels, and the dispatcher's words for how a response is going. */
export type AlarmIntakeChannel = 'phone' | 'email' | 'sms' | 'radio' | 'monitoring_portal' | 'other';
export type AlarmSignalType = 'burglary' | 'panic_duress' | 'fire' | 'medical' | 'tamper' | 'power_fail' | 'unknown';
export const ALARM_SIGNAL_TYPES: { id: AlarmSignalType; label: string }[] = [
  { id: 'burglary', label: 'Burglary / intruder' }, { id: 'panic_duress', label: 'Panic / duress' }, { id: 'fire', label: 'Fire' },
  { id: 'medical', label: 'Medical' }, { id: 'tamper', label: 'Tamper' }, { id: 'power_fail', label: 'Power or line fault' }, { id: 'unknown', label: 'Unknown signal' },
];
export const ALARM_INTAKE_CHANNELS: { id: AlarmIntakeChannel; label: string }[] = [
  { id: 'phone', label: 'Phone call' }, { id: 'email', label: 'Email' }, { id: 'sms', label: 'Text message' }, { id: 'radio', label: 'Radio' }, { id: 'monitoring_portal', label: 'Monitoring portal' }, { id: 'other', label: 'Other' },
];
/** `datetime-local` value for a moment, in the browser's local time (toISOString would show UTC and be hours out in NZ). */
export const localDateTimeValue = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

export interface AlarmSignal { received_at: string; signal_type: string; intake_channel: string | null; panel_id: string | null; zone_name: string | null; zone_number: string | null; account_number: string | null; }
interface LadderStep { label: string; at: string | null; }
const clock = (value: string) => new Date(value).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' });
const minutesAfter = (from: string, to: string) => Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000));
/** The response ladder in the dispatcher's words: each step with its time and minutes since the alarm (or since the job, when no alarm is recorded). */
export const responseLadderWords = (job: { createdAt: string; dispatchedAt?: string | null; acknowledgedAt?: string | null; enRouteAt?: string | null; onSceneAt?: string | null; completedAt?: string | null; slaMinutes: number; status: string }, alarm: AlarmSignal | null, now = new Date()) => {
  const anchor = alarm?.received_at ?? job.createdAt;
  const anchorLabel = alarm ? 'the alarm' : 'the job';
  const steps: LadderStep[] = [
    ...(alarm ? [{ label: `Alarm received (${ALARM_SIGNAL_TYPES.find((type) => type.id === alarm.signal_type)?.label ?? alarm.signal_type}${alarm.intake_channel ? `, by ${ALARM_INTAKE_CHANNELS.find((channel) => channel.id === alarm.intake_channel)?.label.toLowerCase() ?? alarm.intake_channel}` : ''})`, at: alarm.received_at }] : []),
    { label: 'Job created', at: job.createdAt }, { label: 'Dispatched', at: job.dispatchedAt ?? null }, { label: 'Acknowledged', at: job.acknowledgedAt ?? null },
    { label: 'On the way', at: job.enRouteAt ?? null }, { label: 'On scene', at: job.onSceneAt ?? null }, { label: 'Completed', at: job.completedAt ?? null },
  ];
  const rows = steps.map((step) => ({ label: step.label, words: step.at ? `${clock(step.at)}${step.at !== anchor ? ` · ${minutesAfter(anchor, step.at)} min after ${anchorLabel}` : ''}` : 'Not yet' }));
  let verdict: { tone: 'ok' | 'warn' | 'stop'; text: string };
  if (job.onSceneAt) { const took = minutesAfter(anchor, job.onSceneAt); verdict = took <= job.slaMinutes ? { tone: 'ok', text: `On scene ${took} min after ${anchorLabel} — inside the ${job.slaMinutes} min target.` } : { tone: 'stop', text: `On scene ${took} min after ${anchorLabel} — ${took - job.slaMinutes} min over the ${job.slaMinutes} min target.` }; }
  else if (job.status === 'cancelled') verdict = { tone: 'warn', text: 'Cancelled before anyone was on scene.' };
  else { const elapsed = minutesAfter(anchor, now.toISOString()); verdict = elapsed <= job.slaMinutes ? { tone: 'warn', text: `Not on scene yet · ${elapsed} min since ${anchorLabel} · ${job.slaMinutes - elapsed} min left of the ${job.slaMinutes} min target.` } : { tone: 'stop', text: `Not on scene yet · ${elapsed} min since ${anchorLabel} · already ${elapsed - job.slaMinutes} min over the ${job.slaMinutes} min target.` }; }
  if (!alarm && job.status !== 'cancelled') verdict = { ...verdict, text: `${verdict.text} No alarm time is recorded, so the clock counts from when the job was created.` };
  return { rows, verdict };
};
