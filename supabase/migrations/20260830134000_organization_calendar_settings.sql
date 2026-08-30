create table public.organization_calendar_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  country_code text not null default 'NZ',
  region_code text,
  updated_by uuid references public.user_profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint organization_calendar_country_check check(country_code='NZ'),
  constraint organization_calendar_region_check check(region_code is null or region_code in('AUK','BOP','CAN','CIT','GIS','HKB','MBH','MWT','NSN','NTL','OTA','STL','TAS','TKI','WKO','WGN','WTC'))
);

alter table public.organization_calendar_settings enable row level security;
create policy organization_calendar_settings_select on public.organization_calendar_settings for select to authenticated using(public.org_access_allowed(organization_id));
revoke all on public.organization_calendar_settings from public,anon,authenticated;
grant select on public.organization_calendar_settings to authenticated;
grant all on public.organization_calendar_settings to service_role;

create function public.set_organization_calendar_region(p_organization_id uuid,p_region_code text)
returns public.organization_calendar_settings language plpgsql volatile security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_row public.organization_calendar_settings%rowtype;v_region text:=nullif(upper(trim(coalesce(p_region_code,''))), '');
begin
  if not public.is_admin_for_org(p_organization_id) then raise exception 'Not authorised to configure this organization calendar';end if;
  if v_region is not null and v_region not in('AUK','BOP','CAN','CIT','GIS','HKB','MBH','MWT','NSN','NTL','OTA','STL','TAS','TKI','WKO','WGN','WTC') then raise exception 'Unsupported New Zealand holiday region';end if;
  insert into public.organization_calendar_settings(organization_id,region_code,updated_by) values(p_organization_id,v_region,v_actor)
  on conflict(organization_id) do update set region_code=excluded.region_code,updated_by=v_actor,updated_at=clock_timestamp()
  returning * into v_row;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(p_organization_id,v_actor,'organization_calendar_region_set','organization_calendar_settings',p_organization_id,jsonb_build_object('country_code','NZ','region_code',v_region));
  return v_row;
end;$$;
revoke all on function public.set_organization_calendar_region(uuid,text) from public,anon;
grant execute on function public.set_organization_calendar_region(uuid,text) to authenticated,service_role;