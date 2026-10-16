create unique index if not exists idx_task_assignments_observation_direct_unique
  on public.task_assignments(user_id, observation_id, basis)
  where observation_id is not null and basis = 'direct_module_initiation';

create or replace function public.record_observation_direct_initiation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.officer_id is null then
    return new;
  end if;
  insert into public.task_assignments(
    user_id,
    organization_id,
    basis,
    observation_id,
    started_at,
    granted_by,
    notes
  ) values (
    new.officer_id,
    new.organization_id,
    'direct_module_initiation',
    new.id,
    new.observed_at,
    new.officer_id,
    'Automatically recorded from the officer-authored observation'
  )
  on conflict (user_id, observation_id, basis)
    where observation_id is not null and basis = 'direct_module_initiation'
  do nothing;
  return new;
end;
$$;

revoke all on function public.record_observation_direct_initiation()
  from public, anon, authenticated, service_role;
grant execute on function public.record_observation_direct_initiation()
  to postgres;

drop trigger if exists trg_observations_direct_initiation on public.observations;
create trigger trg_observations_direct_initiation
after insert on public.observations
for each row
execute function public.record_observation_direct_initiation();

insert into public.task_assignments(
  user_id,
  organization_id,
  basis,
  observation_id,
  started_at,
  granted_by,
  notes
)
select
  o.officer_id,
  o.organization_id,
  'direct_module_initiation',
  o.id,
  o.observed_at,
  o.officer_id,
  'Historical observation direct-initiation basis backfilled 2026-10-17'
from public.observations o
where o.officer_id is not null
on conflict (user_id, observation_id, basis)
  where observation_id is not null and basis = 'direct_module_initiation'
do nothing;

comment on function public.record_observation_direct_initiation()
  is 'Records the source officer direct_module_initiation basis whenever an observation is created. The observation remains the accountable source receipt.';

comment on index public.idx_task_assignments_observation_direct_unique
  is 'One durable direct-initiation receipt per officer-authored observation; prevents retry duplication while retaining ended basis history.';