-- Add agreement-place operational activity to provider-private report drafts.
-- The snapshot contains counts and recorded distance only; event narratives,
-- identities, plates, and provider financial amounts remain in their source records.
create or replace function public.generate_due_report_packs(
	p_period_start date,
	p_period_end date
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
	v_actor uuid := auth.uid();
	v_provider uuid;
	v_agreement record;
	v_count integer := 0;
	v_written integer;
	v_data jsonb;
	v_start_ts timestamptz := p_period_start::timestamptz;
	v_end_ts timestamptz := p_period_end::timestamptz + interval '1 day';
	v_sla_met integer;
	v_sla_breached integer;
	v_sla_running integer;
	v_inc_total integer;
	v_inc_by_sev jsonb;
	v_checkpoints integer;
	v_breaches integer;
	v_delivery jsonb;
	v_facilities jsonb;
	v_operational_events integer;
	v_patrol_visits integer;
	v_camera_activations integer;
	v_vehicle_observations integer;
	v_event_distance_km numeric;
	v_observation_distance_km numeric;
begin
	if p_period_start is null or p_period_end is null
		 or p_period_start > p_period_end
		 or p_period_end - p_period_start > 366 then
		raise exception 'Select a valid report period of 366 days or less';
	end if;

	select profile.organization_id
	into v_provider
	from public.user_profiles profile
	where profile.id = v_actor
		and profile.deactivated_at is null;

	if v_provider is null or not public.is_admin_for_org(v_provider) then
		raise exception 'Active provider administrator required';
	end if;

	for v_agreement in
		select agreement.id, agreement.provider_organization_id,
					 agreement.monthly_report_template_code
		from public.service_agreements agreement
		where agreement.provider_organization_id = any(public.get_descendant_organizations(v_provider))
			and agreement.monthly_report_template_code is not null
	loop
		select count(*) filter (where clock.status = 'met'),
					 count(*) filter (where clock.status = 'breached'),
					 count(*) filter (where clock.status = 'running')
		into v_sla_met, v_sla_breached, v_sla_running
		from public.sla_clocks clock
		where clock.service_agreement_id = v_agreement.id
			and clock.started_at >= v_start_ts
			and clock.started_at < v_end_ts;

		select count(*), coalesce(jsonb_object_agg(summary.severity, summary.n), '{}'::jsonb)
		into v_inc_total, v_inc_by_sev
		from (
			select incident.severity, count(*) as n
			from public.incidents incident
			where incident.organization_id = v_agreement.provider_organization_id
				and incident.occurred_at >= v_start_ts
				and incident.occurred_at < v_end_ts
			group by incident.severity
		) summary;

		select count(*) into v_checkpoints
		from public.patrol_checkpoint_visits visit
		where visit.organization_id = v_agreement.provider_organization_id
			and visit.visited_at >= v_start_ts
			and visit.visited_at < v_end_ts;

		select count(*) into v_breaches
		from public.breach_alerts alert
		where alert.organization_id = v_agreement.provider_organization_id
			and alert.created_at >= v_start_ts
			and alert.created_at < v_end_ts;

		select count(*),
					 count(*) filter (where event.event_type = 'patrol_visit'),
					 count(*) filter (where event.event_type = 'camera_activation'),
					 coalesce(sum(event.distance_km), 0)
		into v_operational_events, v_patrol_visits, v_camera_activations, v_event_distance_km
		from public.location_events event
		where event.occurred_at >= v_start_ts
			and event.occurred_at < v_end_ts
			and exists (
				select 1
				from public.service_agreement_locations link
				where link.service_agreement_id = v_agreement.id
					and link.status = 'active'
					and (
						(link.zone_id is not null and link.zone_id = event.zone_id)
						or (link.site_id is not null and link.site_id = event.client_site_id)
					)
			);

		select count(*), coalesce(sum(observation.distance_km), 0)
		into v_vehicle_observations, v_observation_distance_km
		from public.observations observation
		where observation.observed_at >= v_start_ts
			and observation.observed_at < v_end_ts
			and exists (
				select 1
				from public.service_agreement_locations link
				where link.service_agreement_id = v_agreement.id
					and link.status = 'active'
					and (
						(link.zone_id is not null and link.zone_id = observation.zone_id)
						or (link.site_id is not null and link.site_id = observation.site_id)
					)
			);

		v_delivery := public.agreement_service_delivery(
			v_agreement.id,
			p_period_start,
			p_period_end
		);

		select coalesce(jsonb_agg(jsonb_build_object(
			'siteName', place->>'place_name',
			'expected', (place->>'patrol_expected')::integer + (place->>'post_expected')::integer,
			'completed', (place->>'patrol_completed')::integer + (place->>'post_attended')::integer
		) order by place->>'place_name'), '[]'::jsonb)
		into v_facilities
		from jsonb_array_elements(v_delivery->'places') as place;

		v_data := jsonb_build_object(
			'slaMet', coalesce(v_sla_met, 0),
			'slaBreached', coalesce(v_sla_breached, 0),
			'slaRunning', coalesce(v_sla_running, 0),
			'incidentsTotal', coalesce(v_inc_total, 0),
			'incidentsBySeverity', coalesce(v_inc_by_sev, '{}'::jsonb),
			'checkpointVisits', coalesce(v_checkpoints, 0),
			'breachAlerts', coalesce(v_breaches, 0),
			'facilities', v_facilities,
			'delivery', v_delivery,
			'operationalEvents', coalesce(v_operational_events, 0),
			'patrolVisits', coalesce(v_patrol_visits, 0),
			'cameraActivations', coalesce(v_camera_activations, 0),
			'vehicleObservations', coalesce(v_vehicle_observations, 0),
			'patrolTravelKm', coalesce(v_event_distance_km, 0) + coalesce(v_observation_distance_km, 0)
		);

		insert into public.monthly_report_packs as existing (
			organization_id, service_agreement_id, template_code, period_start,
			period_end, status, data, generated_at, generated_by, updated_at
		) values (
			v_agreement.provider_organization_id,
			v_agreement.id,
			v_agreement.monthly_report_template_code,
			p_period_start,
			p_period_end,
			'draft',
			v_data,
			clock_timestamp(),
			v_actor,
			clock_timestamp()
		)
		on conflict (service_agreement_id, template_code, period_start)
		do update set
			data = excluded.data,
			status = 'draft',
			generated_at = clock_timestamp(),
			generated_by = v_actor,
			reviewed_at = null,
			reviewed_by = null,
			published_at = null,
			published_by = null,
			delivery_channel = null,
			pdf_path = null,
			pdf_mime_type = null,
			pdf_sha256 = null,
			pdf_renderer_version = null,
			delivery_error = null,
			updated_at = clock_timestamp()
		where existing.status <> 'sent';

		get diagnostics v_written = row_count;
		v_count := v_count + v_written;
	end loop;

	insert into public.audit_log (
		organization_id, actor_user_id, action, target_table, metadata
	) values (
		v_provider,
		v_actor,
		'monthly_report_packs_generated',
		'monthly_report_packs',
		jsonb_build_object(
			'period_start', p_period_start,
			'period_end', p_period_end,
			'pack_count', v_count,
			'status', 'draft'
		)
	);

	return v_count;
end;
$$;

comment on function public.generate_due_report_packs(date, date) is
	'Assembles provider-private draft report packs for eligible provider-tree agreements, including agreement-place operational activity aggregates. Sent packs are immutable; the result counts only inserted or refreshed drafts.';

revoke all on function public.generate_due_report_packs(date, date)
	from public, anon, authenticated, service_role;
grant execute on function public.generate_due_report_packs(date, date)
	to authenticated, service_role;
