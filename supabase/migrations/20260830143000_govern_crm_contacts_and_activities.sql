alter table public.crm_contacts add column if not exists client_request_id uuid;
alter table public.crm_contacts add column if not exists updated_at timestamptz not null default now();
alter table public.crm_contacts add column if not exists deactivated_at timestamptz;
alter table public.crm_contacts add column if not exists deactivated_by uuid references public.user_profiles(id);
create unique index if not exists idx_crm_contacts_client_request on public.crm_contacts(organization_id,client_request_id) where client_request_id is not null;
create unique index if not exists idx_crm_contacts_primary_active on public.crm_contacts(organization_id) where is_primary and deactivated_at is null;

create table if not exists public.crm_account_activities(
  id uuid primary key default gen_random_uuid(),
  provider_organization_id uuid not null references public.organizations(id),
  account_organization_id uuid not null references public.organizations(id),
  service_agreement_id uuid references public.service_agreements(id),
  client_request_id uuid not null,
  activity_type text not null check(activity_type in('call','email','meeting','note','task')),
  subject text not null,
  details text,
  outcome text,
  occurred_at timestamptz not null,
  follow_up_at timestamptz,
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now(),
  unique(provider_organization_id,client_request_id)
);
alter table public.crm_account_activities enable row level security;
create policy crm_account_activities_select on public.crm_account_activities for select to authenticated using(public.is_admin_for_org(provider_organization_id));
revoke insert,update,delete,truncate on public.crm_account_activities from public,anon,authenticated;
grant select on public.crm_account_activities to authenticated;
grant all on public.crm_account_activities to service_role;

create function public.crm_actor_can_manage_account(p_account_organization_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(
    select 1 from public.user_profiles actor
    join public.organizations account on account.id=p_account_organization_id
    where actor.id=auth.uid() and actor.deactivated_at is null
      and public.is_admin_for_org(actor.organization_id)
      and (account.id=actor.organization_id or account.parent_organization_id=actor.organization_id or exists(
        select 1 from public.service_agreements agreement
        where agreement.provider_organization_id=actor.organization_id
          and agreement.client_organization_id=account.id
          and agreement.invitation_status='accepted'
      ))
  );
$$;

create function public.manage_crm_contact(
  p_client_request_id uuid,p_contact_id uuid,p_account_organization_id uuid,p_expected_updated_at timestamptz,p_action text,
  p_first_name text,p_last_name text,p_role_title text default null,p_email text default null,p_phone text default null,p_mobile text default null,
  p_is_primary boolean default false,p_is_emergency boolean default false,p_notes text default null
) returns public.crm_contacts language plpgsql volatile security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_contact public.crm_contacts%rowtype;v_first text:=nullif(trim(coalesce(p_first_name,'')),'');v_last text:=nullif(trim(coalesce(p_last_name,'')),'');v_email text:=nullif(lower(trim(coalesce(p_email,''))),'');
begin
  if v_actor is null or not public.crm_actor_can_manage_account(p_account_organization_id) then raise exception 'Not authorised to manage this CRM account';end if;
  if p_action='create' then
    if p_client_request_id is null then raise exception 'client_request_id is required';end if;
    select c.* into v_contact from public.crm_contacts c where c.organization_id=p_account_organization_id and c.client_request_id=p_client_request_id;if found then return v_contact;end if;
  else
    select c.* into v_contact from public.crm_contacts c where c.id=p_contact_id and c.organization_id=p_account_organization_id for update;if not found then raise exception 'CRM contact not found';end if;
    if v_contact.updated_at<>p_expected_updated_at then raise exception 'CRM contact changed since it was opened';end if;
  end if;
  if p_action in('create','update') then
    if v_first is null or v_last is null then raise exception 'First and last name are required';end if;
    if v_email is null and nullif(trim(coalesce(p_phone,'')),'') is null and nullif(trim(coalesce(p_mobile,'')),'') is null then raise exception 'At least one contact method is required';end if;
    if v_email is not null and v_email!~'^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'A valid email address is required';end if;
    if p_is_primary then update public.crm_contacts set is_primary=false,updated_at=clock_timestamp() where organization_id=p_account_organization_id and is_primary and deactivated_at is null and id is distinct from p_contact_id;end if;
    if p_action='create' then insert into public.crm_contacts(organization_id,client_request_id,first_name,last_name,role_title,email,phone,mobile,is_primary,is_emergency,notes) values(p_account_organization_id,p_client_request_id,v_first,v_last,nullif(trim(coalesce(p_role_title,'')),''),v_email,nullif(trim(coalesce(p_phone,'')),''),nullif(trim(coalesce(p_mobile,'')),''),coalesce(p_is_primary,false),coalesce(p_is_emergency,false),nullif(trim(coalesce(p_notes,'')),'')) returning * into v_contact;
    else update public.crm_contacts set first_name=v_first,last_name=v_last,role_title=nullif(trim(coalesce(p_role_title,'')),''),email=v_email,phone=nullif(trim(coalesce(p_phone,'')),''),mobile=nullif(trim(coalesce(p_mobile,'')),''),is_primary=coalesce(p_is_primary,false),is_emergency=coalesce(p_is_emergency,false),notes=nullif(trim(coalesce(p_notes,'')),''),updated_at=clock_timestamp() where id=v_contact.id returning * into v_contact;end if;
  elsif p_action='deactivate' then
    update public.crm_contacts set is_primary=false,deactivated_at=clock_timestamp(),deactivated_by=v_actor,updated_at=clock_timestamp() where id=v_contact.id returning * into v_contact;
  else raise exception 'Unsupported CRM contact action';end if;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(p_account_organization_id,v_actor,'crm_contact_'||p_action,'crm_contacts',v_contact.id,jsonb_build_object('is_primary',v_contact.is_primary,'is_emergency',v_contact.is_emergency));
  return v_contact;
end;$$;

create function public.create_crm_account_activity(
  p_client_request_id uuid,p_account_organization_id uuid,p_service_agreement_id uuid,p_activity_type text,p_subject text,p_details text,p_outcome text,p_occurred_at timestamptz,p_follow_up_at timestamptz default null
) returns public.crm_account_activities language plpgsql volatile security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_provider uuid;v_activity public.crm_account_activities%rowtype;v_subject text:=nullif(trim(coalesce(p_subject,'')),'');
begin
  if v_actor is null or not public.crm_actor_can_manage_account(p_account_organization_id) then raise exception 'Not authorised to manage this CRM account';end if;
  select organization_id into v_provider from public.user_profiles where id=v_actor and deactivated_at is null;
  if p_client_request_id is null then raise exception 'client_request_id is required';end if;if p_activity_type not in('call','email','meeting','note','task') then raise exception 'Unsupported CRM activity type';end if;if v_subject is null then raise exception 'Activity subject is required';end if;
  if p_occurred_at is null or p_occurred_at>now()+interval '5 minutes' or p_occurred_at<now()-interval '90 days' then raise exception 'Activity time is outside the accepted window';end if;
  if p_follow_up_at is not null and p_follow_up_at<p_occurred_at then raise exception 'Follow-up cannot be before the activity';end if;
  if p_service_agreement_id is not null and not exists(select 1 from public.service_agreements a where a.id=p_service_agreement_id and a.provider_organization_id=v_provider and a.client_organization_id=p_account_organization_id) then raise exception 'Agreement does not belong to this CRM account';end if;
  select a.* into v_activity from public.crm_account_activities a where a.provider_organization_id=v_provider and a.client_request_id=p_client_request_id;if found then return v_activity;end if;
  insert into public.crm_account_activities(provider_organization_id,account_organization_id,service_agreement_id,client_request_id,activity_type,subject,details,outcome,occurred_at,follow_up_at,created_by) values(v_provider,p_account_organization_id,p_service_agreement_id,p_client_request_id,p_activity_type,v_subject,nullif(trim(coalesce(p_details,'')),''),nullif(trim(coalesce(p_outcome,'')),''),p_occurred_at,p_follow_up_at,v_actor) returning * into v_activity;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_provider,v_actor,'crm_account_activity_created','crm_account_activities',v_activity.id,jsonb_build_object('account_organization_id',p_account_organization_id,'activity_type',p_activity_type,'follow_up_at',p_follow_up_at));
  return v_activity;
end;$$;

drop policy if exists crm_contacts_insert on public.crm_contacts;
drop policy if exists crm_contacts_update on public.crm_contacts;
drop policy if exists crm_contacts_delete on public.crm_contacts;
drop policy if exists master_manage_contacts_insert on public.crm_contacts;
drop policy if exists master_manage_contacts_update on public.crm_contacts;
create policy crm_contacts_provider_select on public.crm_contacts for select to authenticated using(public.crm_actor_can_manage_account(organization_id));
revoke insert,update,delete,truncate on public.crm_contacts from public,anon,authenticated;
revoke all on function public.crm_actor_can_manage_account(uuid) from public,anon,authenticated;
grant execute on function public.crm_actor_can_manage_account(uuid) to authenticated,service_role;
revoke all on function public.manage_crm_contact(uuid,uuid,uuid,timestamptz,text,text,text,text,text,text,text,boolean,boolean,text) from public,anon,authenticated;
grant execute on function public.manage_crm_contact(uuid,uuid,uuid,timestamptz,text,text,text,text,text,text,text,boolean,boolean,text) to authenticated,service_role;
revoke all on function public.create_crm_account_activity(uuid,uuid,uuid,text,text,text,text,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.create_crm_account_activity(uuid,uuid,uuid,text,text,text,text,timestamptz,timestamptz) to authenticated,service_role;

create function public.manage_crm_invoice(p_invoice_id uuid,p_expected_status text,p_action text,p_reason text default null)
returns public.invoices language plpgsql volatile security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_invoice public.invoices%rowtype;v_reason text:=nullif(trim(coalesce(p_reason,'')),'');
begin
  select i.* into v_invoice from public.invoices i where i.id=p_invoice_id for update;if not found then raise exception 'Invoice not found';end if;
  if not public.is_admin_for_org(v_invoice.organization_id) then raise exception 'Not authorised to manage this invoice';end if;
  if v_invoice.status<>p_expected_status then raise exception 'Invoice changed from expected status % to %',p_expected_status,v_invoice.status;end if;
  if p_action='send' then
    if v_invoice.status<>'draft' then raise exception 'Only draft invoices can be sent';end if;
    if v_invoice.total_amount<=0 or v_invoice.subtotal<=0 then raise exception 'Invoice totals must be positive before sending';end if;
    if v_invoice.due_date<v_invoice.invoice_date then raise exception 'Invoice due date cannot precede invoice date';end if;
    update public.invoices set status='sent',sent_at=clock_timestamp(),updated_at=clock_timestamp() where id=v_invoice.id returning * into v_invoice;
  elsif p_action='mark_paid' then
    if v_invoice.status not in('sent','overdue') then raise exception 'Only sent or overdue invoices can be marked paid';end if;
    update public.invoices set status='paid',paid_at=clock_timestamp(),updated_at=clock_timestamp() where id=v_invoice.id returning * into v_invoice;
  elsif p_action='void' then
    if v_invoice.status not in('draft','sent','overdue') then raise exception 'This invoice cannot be voided';end if;if v_reason is null then raise exception 'A void reason is required';end if;
    update public.invoices set status='void',notes=concat_ws(E'\n',nullif(notes,''),'Void reason: '||v_reason),updated_at=clock_timestamp() where id=v_invoice.id returning * into v_invoice;
  else raise exception 'Unsupported invoice action';end if;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_invoice.organization_id,v_actor,'crm_invoice_'||p_action,'invoices',v_invoice.id,jsonb_build_object('previous_status',p_expected_status,'status',v_invoice.status,'reason',v_reason,'total_amount',v_invoice.total_amount));
  return v_invoice;
end;$$;

drop policy if exists invoices_insert on public.invoices;
drop policy if exists invoices_update on public.invoices;
revoke insert,update,delete,truncate on public.invoices from public,anon,authenticated;
revoke all on function public.manage_crm_invoice(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.manage_crm_invoice(uuid,text,text,text) to authenticated,service_role;