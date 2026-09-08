-- The welfare tick is a fail-safe backend control and must be active.

do $$
declare
	v_job_id bigint;
begin
	select jobid into v_job_id
	from cron.job
	where jobname = 'welfare-escalation-tick-every-minute'
	limit 1;

	if v_job_id is null then
		raise exception 'Welfare escalation cron job is missing';
	end if;

	perform cron.alter_job(v_job_id, active => true);
end;
$$;
