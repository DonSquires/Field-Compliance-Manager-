revoke all on table public.incidents from public,anon;
revoke all on table public.incidents from authenticated;
grant select on table public.incidents to authenticated;

revoke all on table public.incident_attachments from public,anon;
revoke all on table public.incident_attachments from authenticated;
grant select on table public.incident_attachments to authenticated;

grant all on table public.incidents,public.incident_attachments to service_role;