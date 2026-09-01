alter table public.staff_credentials add column if not exists client_request_id uuid,add column if not exists replaces_credential_id uuid references public.staff_credentials(id) on delete restrict;
create unique index if not exists staff_credentials_client_request_idx on public.staff_credentials(organization_id,client_request_id) where client_request_id is not null;
revoke all on table public.staff_credentials from public,anon;
revoke insert,update,delete on table public.staff_credentials from authenticated;
grant select on table public.staff_credentials to authenticated;

create function public.renew_staff_credential(p_client_request_id uuid,p_source_credential_id uuid,p_expected_expiry_date date,p_credential_number text,p_issuing_authority text,p_issued_date date,p_expiry_date date,p_evidence_notes text)
returns table(credential_id uuid,staff_id uuid,verified boolean,verified_at timestamptz,created boolean) language plpgsql security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_source public.staff_credentials%rowtype;v_renewal public.staff_credentials%rowtype;v_number text:=nullif(trim(coalesce(p_credential_number,'')),'');v_authority text:=nullif(trim(coalesce(p_issuing_authority,'')),'');v_notes text:=nullif(trim(coalesce(p_evidence_notes,'')),'');
begin
  if p_client_request_id is null then raise exception 'Client request ID is required';end if;
  select c.* into v_source from public.staff_credentials c where c.id=p_source_credential_id for update;if not found then raise exception 'Source credential not found';end if;
  if not public.is_admin_for_org(v_source.organization_id) then raise exception 'Active provider administrator required';end if;
  if v_source.expiry_date is distinct from p_expected_expiry_date then raise exception 'Credential expiry changed from expected state';end if;
  if v_source.expiry_date is null then raise exception 'Only expiring credentials can be renewed';end if;
  if v_number is null or v_authority is null or v_notes is null or length(v_notes)<10 then raise exception 'Credential number, issuing authority, and evidence notes are required';end if;
  if p_issued_date is null or p_expiry_date is null or p_issued_date>p_expiry_date or p_expiry_date<=v_source.expiry_date then raise exception 'Renewal dates must establish a later valid credential';end if;
  perform pg_advisory_xact_lock(hashtextextended(p_client_request_id::text,0));
  select c.* into v_renewal from public.staff_credentials c where c.organization_id=v_source.organization_id and c.client_request_id=p_client_request_id;
  if found then if v_renewal.replaces_credential_id<>v_source.id then raise exception 'Credential renewal request identity collision';end if;return query select v_renewal.id,v_renewal.staff_id,v_renewal.verified,v_renewal.verified_at,false;return;end if;
  insert into public.staff_credentials(staff_id,organization_id,credential_type,credential_number,issuing_authority,issued_date,expiry_date,authorized_activities,verified,verified_by,verified_at,notes,client_request_id,replaces_credential_id) values(v_source.staff_id,v_source.organization_id,v_source.credential_type,v_number,v_authority,p_issued_date,p_expiry_date,v_source.authorized_activities,true,v_actor,clock_timestamp(),v_notes,p_client_request_id,v_source.id) returning * into v_renewal;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_source.organization_id,v_actor,'staff_credential_renewed','staff_credentials',v_renewal.id,jsonb_build_object('source_credential_id',v_source.id,'staff_id',v_source.staff_id,'credential_type',v_source.credential_type,'previous_expiry_date',v_source.expiry_date,'expiry_date',v_renewal.expiry_date,'evidence_notes',v_notes));
  return query select v_renewal.id,v_renewal.staff_id,v_renewal.verified,v_renewal.verified_at,true;
end;$$;
revoke all on function public.renew_staff_credential(uuid,uuid,date,text,text,date,date,text) from public,anon;
grant execute on function public.renew_staff_credential(uuid,uuid,date,text,text,date,date,text) to authenticated,service_role;