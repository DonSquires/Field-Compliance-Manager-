create function public.manage_crm_quote(p_quote_id uuid,p_expected_status text,p_action text,p_reason text default null)
returns table(quote_id uuid,quote_status text,service_agreement_id uuid) language plpgsql volatile security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_quote public.quotes%rowtype;v_reason text:=nullif(trim(coalesce(p_reason,'')),'');v_margin numeric;v_agreement uuid;
begin
  select q.* into v_quote from public.quotes q where q.id=p_quote_id for update;if not found then raise exception 'Quote not found';end if;
  if not public.is_admin_for_org(v_quote.provider_org_id) then raise exception 'Not authorised to manage this quote';end if;
  if v_quote.status<>p_expected_status then raise exception 'Quote changed from expected status % to %',p_expected_status,v_quote.status;end if;
  if p_action='send' then
    if v_quote.status<>'draft' then raise exception 'Only draft quotes can be sent';end if;
    if v_quote.valid_until is not null and v_quote.valid_until<current_date then raise exception 'Expired quotes cannot be sent';end if;
    if not exists(select 1 from public.quote_lines l where l.quote_id=v_quote.id and l.kind='labour' and l.quantity>0 and l.unit_charge>0) then raise exception 'At least one positively priced labour line is required';end if;
    if v_quote.subtotal_charge<=0 or v_quote.total_charge<=0 then raise exception 'Quote totals must be positive before sending';end if;
    v_margin:=case when v_quote.subtotal_charge=0 then 0 else (v_quote.subtotal_charge-v_quote.total_cost)*100/v_quote.subtotal_charge end;
    if v_margin<v_quote.target_margin_pct then raise exception 'Achieved margin % is below target %',round(v_margin,2),v_quote.target_margin_pct;end if;
    update public.quotes q set status='sent',updated_by=v_actor where q.id=v_quote.id returning q.* into v_quote;
  elsif p_action='accept' then
    if v_quote.status<>'sent' then raise exception 'Only sent quotes can be accepted';end if;
    if v_quote.valid_until is not null and v_quote.valid_until<current_date then raise exception 'Expired quotes cannot be accepted';end if;
    select public.accept_quote(v_quote.id) into v_agreement;select q.* into v_quote from public.quotes q where q.id=v_quote.id;
  elsif p_action='decline' then
    if v_quote.status<>'sent' then raise exception 'Only sent quotes can be declined';end if;if v_reason is null then raise exception 'Decline reason is required';end if;
    update public.quotes q set status='declined',notes=concat_ws(E'\n',nullif(q.notes,''),'Declined: '||v_reason),updated_by=v_actor where q.id=v_quote.id returning q.* into v_quote;
  else raise exception 'Unsupported quote action';end if;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)values(v_quote.provider_org_id,v_actor,case p_action when 'send' then 'crm_quote_sent' when 'accept' then 'crm_quote_accepted' else 'crm_quote_declined' end,'quotes',v_quote.id,jsonb_build_object('client_org_id',v_quote.client_org_id,'previous_status',p_expected_status,'status',v_quote.status,'service_agreement_id',v_quote.service_agreement_id,'reason',case when p_action='decline' then v_reason else null end));
  return query select v_quote.id,v_quote.status,v_quote.service_agreement_id;
end;$$;

revoke all on function public.accept_quote(uuid) from public,anon,authenticated;
grant execute on function public.accept_quote(uuid) to service_role;
revoke all on function public.manage_crm_quote(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.manage_crm_quote(uuid,text,text,text) to authenticated,service_role;