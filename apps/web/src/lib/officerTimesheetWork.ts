import { supabase } from './supabase';

export type TimesheetWorkEntry = {
  source_type: 'shift' | 'dispatch_job';
  source_id: string;
  work_status: 'completed' | 'partial';
  started_at: string;
  ended_at: string;
  calculated_minutes: number;
  label: string;
  metadata: Record<string, unknown>;
};

export async function loadOfficerTimesheetWork(periodStart: string, periodEnd: string): Promise<TimesheetWorkEntry[]> {
  const { data, error } = await supabase.rpc('get_officer_timesheet_work', { p_period_start: periodStart, p_period_end: periodEnd });
  if (error) throw error;
  return Array.isArray(data) ? data as TimesheetWorkEntry[] : [];
}

export async function submitOfficerTimesheetFromWork(clientEventId: string, periodStart: string, periodEnd: string, adjustmentHours: number, notes: string) {
  const { data, error } = await supabase.rpc('submit_officer_timesheet_from_work', {
    p_client_event_id: clientEventId,
    p_period_start: periodStart,
    p_period_end: periodEnd,
    p_adjustment_hours: adjustmentHours,
    p_notes: notes.trim() || null,
  });
  const receipt = (data as Array<{ id: string; actual_hours: number; source_count: number }> | null)?.[0];
  if (error || !receipt) throw error ?? new Error('Timesheet work receipt was not confirmed.');
  return receipt;
}
