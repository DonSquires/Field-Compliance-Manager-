revoke all on function public.complete_shift_stop(uuid,text,double precision,double precision) from public,anon,authenticated;
grant execute on function public.complete_shift_stop(uuid,text,double precision,double precision) to service_role;
