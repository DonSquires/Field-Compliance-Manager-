-- The response ladder stamps every step: a job that becomes 'dispatched' (or any later status) by any governed path
-- gets its milestone time, so 'Dispatched — Not yet' never shows for a job that is already on the way.
-- Before: dispatched_at was set only when a job was created with a resource; advance_dispatch_job_status
-- pending -> dispatched, manage_dispatch_job reassign and assign_dispatch_job_to_officer never stamped it.
create or replace function public.tg_dispatch_job_stamp_milestones() returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'dispatched' and new.dispatched_at is null then new.dispatched_at := now(); end if;
    if new.status = 'acknowledged' and new.acknowledged_at is null then new.acknowledged_at := now(); end if;
    if new.status = 'en_route' and new.en_route_at is null then new.en_route_at := now(); end if;
    if new.status = 'on_scene' and new.on_scene_at is null then new.on_scene_at := now(); end if;
    if new.status = 'completed' and new.completed_at is null then new.completed_at := now(); end if;
    -- a job that skipped straight past 'dispatched' was still dispatched at that moment
    if new.status in ('acknowledged', 'en_route', 'on_scene', 'completed') and new.dispatched_at is null then new.dispatched_at := now(); end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_dispatch_job_stamp_milestones on public.dispatch_jobs;
create trigger trg_dispatch_job_stamp_milestones before update of status on public.dispatch_jobs
for each row execute function public.tg_dispatch_job_stamp_milestones();
comment on function public.tg_dispatch_job_stamp_milestones() is 'BEFORE UPDATE OF status on dispatch_jobs: fills the milestone timestamp for the status being entered when the governed path did not.';
