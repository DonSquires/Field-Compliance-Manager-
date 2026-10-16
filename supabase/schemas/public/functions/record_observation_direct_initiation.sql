create or replace function public.record_observation_direct_initiation()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  if new.officer_id is null then
    return new;
  end if;
  insert into public.task_assignments(
    user_id, organization_id, basis, observation_id, started_at, granted_by, notes
  ) values (
    new.officer_id, new.organization_id, 'direct_module_initiation',
    new.id, new.observed_at, new.officer_id,
    'Automatically recorded from the officer-authored observation'
  )
  on conflict (user_id, observation_id, basis)
    where observation_id is not null and basis = 'direct_module_initiation'
  do nothing;
  return new;
end;
$function$;

revoke all on function public.record_observation_direct_initiation()
  from public, anon, authenticated, service_role;
grant execute on function public.record_observation_direct_initiation()
  to postgres;

comment on function public.record_observation_direct_initiation()
  is 'Records the source officer direct_module_initiation basis whenever an observation is created. The observation remains the accountable source receipt.';
