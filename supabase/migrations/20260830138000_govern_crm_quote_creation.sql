alter table public.quotes add column if not exists client_request_id uuid;
create unique index if not exists idx_quotes_client_request on public.quotes(provider_org_id,client_request_id) where client_request_id is not null;
revoke insert,update,delete on public.quotes from public,anon,authenticated;

create function public.create_crm_draft_quote(p_client_request_id uuid,p_client_org_id uuid,p_title text,p_target_margin_pct numeric default 0,p_valid_until date default null,p_notes text default null)
returns public.quotes language plpgsql volatile security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_provider uuid;v_quote public.quotes%rowtype;v_title text:=nullif(trim(coalesce(p_title,'')),'');
begin
  select up.organization_id into v_provider from public.user_profiles up where up.id=v_actor and up.deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) then raise exception 'Active CRM administrator required';end if;
  if p_client_request_id is null then raise exception 'client_request_id is required';end if;if v_title is null then raise exception 'Quote title is required';end if;
  if p_target_margin_pct<0 or p_target_margin_pct>=100 then raise exception 'Target margin must be between zero and 100';end if;
  if p_valid_until is not null and p_valid_until<current_date then raise exception 'Quote validity date cannot be in the past';end if;
  if not exists(select 1 from public.organizations o where o.id=p_client_org_id and o.active and (o.parent_organization_id=v_provider or exists(select 1 from public.service_agreements a where a.agreement_type='operational' and ((a.provider_organization_id=v_provider and a.client_organization_id=o.id) or (a.client_organization_id=v_provider and a.provider_organization_id=o.id))))) then raise exception 'Active client or contracted organization required';end if;
  select q.* into v_quote from public.quotes q where q.provider_org_id=v_provider and q.client_request_id=p_client_request_id;if found then return v_quote;end if;
  insert into public.quotes(provider_org_id,client_org_id,title,status,currency,target_margin_pct,valid_until,notes,client_request_id,created_by,updated_by)
  values(v_provider,p_client_org_id,v_title,'draft','NZD',p_target_margin_pct,p_valid_until,nullif(trim(coalesce(p_notes,'')),''),p_client_request_id,v_actor,v_actor) returning * into v_quote;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)values(v_provider,v_actor,'crm_draft_quote_created','quotes',v_quote.id,jsonb_build_object('client_org_id',p_client_org_id,'title',v_title,'target_margin_pct',p_target_margin_pct,'valid_until',p_valid_until));
  return v_quote;
end;$$;

revoke all on function public.create_crm_draft_quote(uuid,uuid,text,numeric,date,text) from public,anon,authenticated;
grant execute on function public.create_crm_draft_quote(uuid,uuid,text,numeric,date,text) to authenticated,service_role;
revoke all on function public.accept_quote(uuid) from public,anon;