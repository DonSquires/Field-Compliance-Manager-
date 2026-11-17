/**
 * useActiveShift.ts — Get officer's current live shift from the schema
 *
 * Canonical source is the shifts table, not the dispatch_jobs table.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';

export interface ShiftStop {
  id: string;
  shift_id: string;
  zone_id?: string;
  client_site_id?: string;
  site_name?: string;
  seq: number;
  arrival_time?: string;
  departure_time?: string;
}

export interface ActiveShift {
  id: string;
  organization_id: string;
  officer_user_id: string;
  shift_date: string;
  start_time: string;
  end_time: string;
  shift_type: 'patrol' | 'static' | 'mobile' | 'rostered' | string;
  vehicle_id?: string;
  route_id?: string;
  location_id?: string | null;
  zone_id?: string | null;
  service_agreement_module_key?: string | null;
  stops: ShiftStop[];
  status: 'scheduled' | 'published' | 'accepted' | 'declined' | 'in_progress' | 'completed' | 'cancelled';
  recovery_only?: boolean;
  service_agreement_location_id?: string | null;
  created_at: string;
  updated_at: string;
}

interface AssignedShiftRow {
  id: string;
  organization_id: string;
  officer_user_id: string;
  scheduled_start: string;
  scheduled_end: string;
  status: ActiveShift['status'];
  context_status?: string;
  service_type?: string | null;
  patrol_route_id?: string | null;
  location_id?: string | null;
  zone_id?: string | null;
  service_agreement_location_id?: string | null;
  service_agreement_module?: { module_key: string } | { module_key: string }[] | null;
  created_at?: string;
  updated_at?: string;
  shift_stops?: {
    id: string;
    shift_id: string;
    zone_id: string | null;
    site_id: string | null;
    site?: { name: string } | { name: string }[] | null;
    stop_order: number;
    actual_arrived_at: string | null;
    actual_departed_at: string | null;
  }[];
}

export function useActiveShift(userId: string, organizationId: string) {
  const [shift, setShift] = useState<ActiveShift | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const requestSequence = useRef(0);
  const scope = useRef('');

  const fetchActiveShift = useCallback(async () => {
    const requestId = ++requestSequence.current;
    const nextScope = `${userId}:${organizationId}`;
    if (scope.current !== nextScope) {
      scope.current = nextScope;
      setShift(null);
    }
    if (!userId || !organizationId) {
      setShift(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const now = new Date();
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);

      // Overdue recovery never reads place or other assignment detail.
      const recovery = await supabase.from('shifts')
        .select('id, organization_id, officer_user_id, scheduled_start, scheduled_end, status')
        .eq('officer_user_id', userId).eq('status', 'in_progress')
        .lte('scheduled_end', now.toISOString()).order('scheduled_start', { ascending: true });
      if (requestId !== requestSequence.current) return;
      if (recovery.error) throw recovery.error;
      const overdue = (Array.isArray(recovery.data) ? recovery.data : []).map((candidate) => ({
        ...candidate, context_status: 'recovery_only', shift_stops: [],
      }));
      let rows: AssignedShiftRow[] = overdue;
      if (overdue.length) {
        void Promise.resolve(supabase.rpc('get_assigned_officer_shift_context')).then((scoped) => {
          if (requestId !== requestSequence.current) return;
          const warning = scoped.error || !Array.isArray(scoped.data)
            ? 'Other assignments could not be checked.'
            : scoped.data.some((candidate: { context_status?: string }) => candidate.context_status === 'requires_review')
              ? 'Some assigned shifts need operations review; their details are unavailable.'
              : null;
          if (warning) setError((current) => new Error(`${current?.message ?? 'Your unfinished shift is overdue.'} ${warning}`));
        }).catch(() => {
          if (requestId === requestSequence.current) {
            setError((current) => new Error(`${current?.message ?? 'Your unfinished shift is overdue.'} Other assignments could not be checked.`));
          }
        });
      }
      if (!overdue.length) {
        const direct = await supabase
          .from('shifts')
          .select(`
          id,
          organization_id,
          officer_user_id,
          service_type,
          scheduled_start,
          scheduled_end,
          status,
          location_id,
          zone_id,
          service_agreement_location_id,
          service_agreement_module_id,
          service_agreement_module:service_agreement_modules!shifts_service_agreement_module_id_fkey ( module_key ),
          patrol_route_id,
          created_at,
          updated_at,
          shift_stops (
            id,
            shift_id,
            zone_id,
            site_id,
            site:site_id ( name ),
            stop_order,
            actual_arrived_at,
            actual_departed_at
          )
          `)
          .eq('officer_user_id', userId)
          .gt('scheduled_end', now.toISOString())
          .or(`status.eq.in_progress,and(scheduled_start.lte.${todayEnd.toISOString()},scheduled_end.gte.${todayStart.toISOString()})`)
          .in('status', ['accepted', 'in_progress'])
          .order('status', { ascending: false })
          .order('scheduled_start', { ascending: true });

        if (requestId !== requestSequence.current) return;
        if (direct.error && direct.error.code !== 'PGRST116') {
          throw direct.error;
        }

        const visible = Array.isArray(direct.data) ? direct.data : direct.data ? [direct.data] : [];
        const scoped = await supabase.rpc('get_assigned_officer_shift_context');
        if (requestId !== requestSequence.current) return;
        if (scoped.error || !Array.isArray(scoped.data)) {
          throw scoped.error ?? new Error('Assigned shifts could not be confirmed.');
        }
        const projection = scoped.data as AssignedShiftRow[];
        const requiresReview = projection.filter((candidate) => candidate.context_status === 'requires_review');
        if (requiresReview.length) setError(new Error('Some assigned shifts need operations review; their details are unavailable.'));
        const invalidIds = new Set(requiresReview.map((candidate) => candidate.id));
        const scopedRows = projection.filter((candidate) => candidate.officer_user_id === userId
          && ['accepted', 'in_progress'].includes(candidate.status)
          && (candidate.context_status !== 'requires_review' || candidate.status === 'in_progress')
          && (candidate.status === 'in_progress' || (Date.parse(candidate.scheduled_end) > now.getTime()
            && Date.parse(candidate.scheduled_start) <= todayEnd.getTime()
            && Date.parse(candidate.scheduled_end) >= todayStart.getTime())));
        const byId = new Map(scopedRows.map((candidate) => [candidate.id, candidate]));
        visible.filter((candidate) => !invalidIds.has(candidate.id))
          .forEach((candidate) => byId.set(candidate.id, candidate));
        rows = [...byId.values()].sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start));
      }
      const row = rows.find((candidate) => candidate.status === 'in_progress')
        ?? rows.find((candidate) => Date.parse(candidate.scheduled_start) <= now.getTime()
          && Date.parse(candidate.scheduled_end) >= now.getTime())
        ?? rows.find((candidate) => Date.parse(candidate.scheduled_start) > now.getTime());
      if (row) {
        const data = row;
        const agreementModule = Array.isArray(data.service_agreement_module)
          ? data.service_agreement_module[0]
          : data.service_agreement_module;
        const limited = data.context_status === 'recovery_only' || data.context_status === 'requires_review';
        const crossBranch = data.organization_id !== organizationId;
        if (limited && data.context_status === 'recovery_only') {
          setError((current) => new Error(`Your unfinished shift is overdue. Use shift recovery or contact operations.${current ? ` ${current.message}` : ''}`));
        }
        const shift: ActiveShift = {
          id: data.id,
          organization_id: data.organization_id,
          officer_user_id: data.officer_user_id,
          shift_date: data.scheduled_start,
          start_time: data.scheduled_start,
          end_time: data.scheduled_end,
          shift_type: limited ? 'Unfinished' : data.service_type ?? 'patrol',
          vehicle_id: undefined,
          route_id: limited ? undefined : data.patrol_route_id ?? undefined,
          location_id: limited ? null : data.location_id ?? null,
          zone_id: limited ? null : data.zone_id ?? null,
          service_agreement_module_key: limited || crossBranch ? null : agreementModule?.module_key ?? null,
          status: data.status,
          service_agreement_location_id: limited || crossBranch ? null : data.service_agreement_location_id ?? null,
          created_at: data.created_at ?? data.scheduled_start,
          updated_at: data.updated_at ?? data.created_at ?? data.scheduled_start,
          recovery_only: limited,
          stops: (limited ? [] : data.shift_stops || []).map((stop) => ({
            id: stop.id,
            shift_id: stop.shift_id,
            zone_id: stop.zone_id ?? undefined,
            client_site_id: stop.site_id ?? undefined,
            site_name: (Array.isArray(stop.site) ? stop.site[0] : stop.site)?.name ?? undefined,
            seq: stop.stop_order,
            arrival_time: stop.actual_arrived_at ?? undefined,
            departure_time: stop.actual_departed_at ?? undefined,
          })),
        };
        setShift(shift);
      } else {
        setShift(null);
      }
    } catch (err) {
      if (requestId !== requestSequence.current) return;
      console.error('Error fetching active shift:', err);
      setShift(null);
      setError(err instanceof Error ? err : new Error((err as { message?: string }).message ?? 'Shift status could not be verified.'));
    } finally {
      if (requestId === requestSequence.current) setIsLoading(false);
    }
  }, [userId, organizationId]);

  useEffect(() => {
    fetchActiveShift();
    const interval = setInterval(fetchActiveShift, 30000);
    return () => { clearInterval(interval); requestSequence.current++; };
  }, [fetchActiveShift]);

  const getCurrentZone = useCallback(() => {
    if (!shift || !shift.stops.length) return null;
    return shift.stops[0].zone_id || shift.stops[0].client_site_id;
  }, [shift]);

  return {
    shift,
    isLoading,
    error,
    refetch: fetchActiveShift,
    getCurrentZone,
  };
}
