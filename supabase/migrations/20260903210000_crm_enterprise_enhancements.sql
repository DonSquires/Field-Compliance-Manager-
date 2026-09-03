-- Migration: 20260903210000_crm_enterprise_enhancements.sql
-- Enterprise CRM enhancements:
-- 1. Governed Quote Line Correction & Modification RPCs (remove_crm_quote_line, update_crm_quote_line)
-- 2. Closed-Loop Follow-Up & Task Completion Engine (completed_at/by/notes on crm_account_activities, complete_crm_follow_up)
-- 3. Account Ownership Assignment (account_owner_user_id on organizations, manage_crm_organization overload)
-- 4. Governed Invoice Line Items & Generation (add_crm_invoice_line, remove_crm_invoice_line, generate_crm_invoice_from_agreement)

-- 1. Add account_owner_user_id column to organizations
ALTER TABLE "public"."organizations"
  ADD COLUMN IF NOT EXISTS "account_owner_user_id" uuid REFERENCES "public"."user_profiles"("id") ON DELETE SET NULL;

COMMENT ON COLUMN "public"."organizations"."account_owner_user_id" IS 'Internal user/relationship manager owning this account.';

-- 2. Add follow-up completion columns to crm_account_activities
ALTER TABLE "public"."crm_account_activities"
  ADD COLUMN IF NOT EXISTS "completed_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "completed_by" uuid REFERENCES "public"."user_profiles"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "completion_notes" text;

COMMENT ON COLUMN "public"."crm_account_activities"."completed_at" IS 'Timestamp when follow-up action was completed.';

-- 3. Governed RPC: remove_crm_quote_line
CREATE OR REPLACE FUNCTION "public"."remove_crm_quote_line"(
  p_client_request_id uuid,
  p_quote_id uuid,
  p_line_id uuid,
  p_expected_status text
)
RETURNS TABLE(
  quote_id uuid,
  total_cost numeric,
  subtotal_charge numeric,
  discount_amount numeric,
  gst_amount numeric,
  total_charge numeric,
  removed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_quote public.quotes%rowtype;
  v_line public.quote_lines%rowtype;
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select q.* into v_quote from public.quotes q where q.id = p_quote_id for update;
  if not found then
    raise exception 'Quote not found';
  end if;

  if not public.is_admin_for_org(v_quote.provider_org_id) then
    raise exception 'Not authorised to price this quote';
  end if;

  if v_quote.status <> p_expected_status then
    raise exception 'Quote changed from expected status % to %', p_expected_status, v_quote.status;
  end if;

  if v_quote.status <> 'draft' then
    raise exception 'Only draft quotes can be modified';
  end if;

  select l.* into v_line from public.quote_lines l where l.id = p_line_id and l.quote_id = v_quote.id;
  if not found then
    return query select v_quote.id, v_quote.total_cost, v_quote.subtotal_charge, v_quote.discount_amount, v_quote.gst_amount, v_quote.total_charge, false;
    return;
  end if;

  delete from public.quote_lines where id = v_line.id;

  update public.quotes q set
    total_cost = totals.total_cost,
    subtotal_charge = totals.subtotal_charge,
    discount_amount = round(totals.subtotal_charge * q.discount_pct / 100, 2),
    gst_amount = round((totals.subtotal_charge - round(totals.subtotal_charge * q.discount_pct / 100, 2)) * q.gst_rate, 2),
    total_charge = round((totals.subtotal_charge - round(totals.subtotal_charge * q.discount_pct / 100, 2)) * (1 + q.gst_rate), 2),
    updated_by = v_actor,
    updated_at = now()
  from (
    select
      coalesce(sum(l.quantity * l.unit_cost), 0)::numeric(12,2) total_cost,
      coalesce(sum(l.quantity * l.unit_charge), 0)::numeric(12,2) subtotal_charge
    from public.quote_lines l
    where l.quote_id = v_quote.id
  ) totals
  where q.id = v_quote.id
  returning q.* into v_quote;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_quote.provider_org_id,
    v_actor,
    'crm_quote_line_removed',
    'quote_lines',
    v_line.id,
    jsonb_build_object(
      'quote_id', v_quote.id,
      'kind', v_line.kind,
      'description', v_line.description,
      'total_cost', v_quote.total_cost,
      'total_charge', v_quote.total_charge,
      'client_request_id', p_client_request_id
    )
  );

  return query select v_quote.id, v_quote.total_cost, v_quote.subtotal_charge, v_quote.discount_amount, v_quote.gst_amount, v_quote.total_charge, true;
end;
$$;

REVOKE ALL ON FUNCTION "public"."remove_crm_quote_line"(uuid,uuid,uuid,text) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."remove_crm_quote_line"(uuid,uuid,uuid,text) TO "authenticated", "service_role";

-- 4. Governed RPC: update_crm_quote_line
CREATE OR REPLACE FUNCTION "public"."update_crm_quote_line"(
  p_client_request_id uuid,
  p_quote_id uuid,
  p_line_id uuid,
  p_expected_status text,
  p_description text,
  p_quantity numeric,
  p_unit_cost numeric,
  p_unit_charge numeric
)
RETURNS TABLE(
  line_id uuid,
  quote_id uuid,
  total_cost numeric,
  subtotal_charge numeric,
  discount_amount numeric,
  gst_amount numeric,
  total_charge numeric,
  updated boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_quote public.quotes%rowtype;
  v_line public.quote_lines%rowtype;
  v_description text := nullif(trim(coalesce(p_description, '')), '');
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select q.* into v_quote from public.quotes q where q.id = p_quote_id for update;
  if not found then
    raise exception 'Quote not found';
  end if;

  if not public.is_admin_for_org(v_quote.provider_org_id) then
    raise exception 'Not authorised to price this quote';
  end if;

  if v_quote.status <> p_expected_status then
    raise exception 'Quote changed from expected status % to %', p_expected_status, v_quote.status;
  end if;

  if v_quote.status <> 'draft' then
    raise exception 'Only draft quotes can be modified';
  end if;

  if v_description is null then
    raise exception 'Line description is required';
  end if;

  if p_quantity is null or p_quantity <= 0 or p_quantity > 100000
     or p_unit_cost is null or p_unit_cost < 0 or p_unit_cost > 1000000
     or p_unit_charge is null or p_unit_charge < 0 or p_unit_charge > 1000000 then
    raise exception 'Quote line amounts are outside the accepted range';
  end if;

  select l.* into v_line from public.quote_lines l where l.id = p_line_id and l.quote_id = v_quote.id;
  if not found then
    raise exception 'Quote line not found';
  end if;

  update public.quote_lines
  set
    description = v_description,
    quantity = p_quantity,
    unit_cost = p_unit_cost,
    unit_charge = p_unit_charge
  where id = v_line.id;

  update public.quotes q set
    total_cost = totals.total_cost,
    subtotal_charge = totals.subtotal_charge,
    discount_amount = round(totals.subtotal_charge * q.discount_pct / 100, 2),
    gst_amount = round((totals.subtotal_charge - round(totals.subtotal_charge * q.discount_pct / 100, 2)) * q.gst_rate, 2),
    total_charge = round((totals.subtotal_charge - round(totals.subtotal_charge * q.discount_pct / 100, 2)) * (1 + q.gst_rate), 2),
    updated_by = v_actor,
    updated_at = now()
  from (
    select
      coalesce(sum(l.quantity * l.unit_cost), 0)::numeric(12,2) total_cost,
      coalesce(sum(l.quantity * l.unit_charge), 0)::numeric(12,2) subtotal_charge
    from public.quote_lines l
    where l.quote_id = v_quote.id
  ) totals
  where q.id = v_quote.id
  returning q.* into v_quote;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_quote.provider_org_id,
    v_actor,
    'crm_quote_line_updated',
    'quote_lines',
    v_line.id,
    jsonb_build_object(
      'quote_id', v_quote.id,
      'description', v_description,
      'quantity', p_quantity,
      'unit_cost', p_unit_cost,
      'unit_charge', p_unit_charge,
      'total_cost', v_quote.total_cost,
      'total_charge', v_quote.total_charge,
      'client_request_id', p_client_request_id
    )
  );

  return query select v_line.id, v_quote.id, v_quote.total_cost, v_quote.subtotal_charge, v_quote.discount_amount, v_quote.gst_amount, v_quote.total_charge, true;
end;
$$;

REVOKE ALL ON FUNCTION "public"."update_crm_quote_line"(uuid,uuid,uuid,text,text,numeric,numeric,numeric) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."update_crm_quote_line"(uuid,uuid,uuid,text,text,numeric,numeric,numeric) TO "authenticated", "service_role";

-- 5. Governed RPC: complete_crm_follow_up
CREATE OR REPLACE FUNCTION "public"."complete_crm_follow_up"(
  p_client_request_id uuid,
  p_activity_id uuid,
  p_completion_notes text DEFAULT NULL
)
RETURNS TABLE(
  activity_id uuid,
  completed_at timestamptz,
  completed_by uuid,
  completed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_activity public.crm_account_activities%rowtype;
  v_notes text := nullif(trim(coalesce(p_completion_notes, '')), '');
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select a.* into v_activity from public.crm_account_activities a where a.id = p_activity_id;
  if not found then
    raise exception 'Activity not found';
  end if;

  if not public.is_admin_for_org(v_activity.provider_organization_id) then
    raise exception 'Not authorised to modify activity for this account';
  end if;

  if v_activity.completed_at is not null then
    return query select v_activity.id, v_activity.completed_at, v_activity.completed_by, true;
    return;
  end if;

  update public.crm_account_activities
  set
    completed_at = now(),
    completed_by = v_actor,
    completion_notes = coalesce(v_notes, completion_notes)
  where id = v_activity.id
  returning * into v_activity;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_activity.provider_organization_id,
    v_actor,
    'crm_follow_up_completed',
    'crm_account_activities',
    v_activity.id,
    jsonb_build_object(
      'account_organization_id', v_activity.account_organization_id,
      'subject', v_activity.subject,
      'completion_notes', v_notes,
      'client_request_id', p_client_request_id
    )
  );

  return query select v_activity.id, v_activity.completed_at, v_activity.completed_by, true;
end;
$$;

REVOKE ALL ON FUNCTION "public"."complete_crm_follow_up"(uuid,uuid,text) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."complete_crm_follow_up"(uuid,uuid,text) TO "authenticated", "service_role";

-- 6. Governed RPC: manage_crm_organization (updated with account_owner_user_id parameter)
DROP FUNCTION IF EXISTS "public"."manage_crm_organization"(uuid,uuid,timestamptz,text,text,text,text,text,text,text,text,text,text,text);

CREATE OR REPLACE FUNCTION "public"."manage_crm_organization"(
  p_client_request_id uuid,
  p_organization_id uuid,
  p_expected_updated_at timestamptz,
  p_action text,
  p_name text,
  p_organization_type text,
  p_nzbn text DEFAULT NULL,
  p_company_registration_number text DEFAULT NULL,
  p_contact_email text DEFAULT NULL,
  p_contact_phone text DEFAULT NULL,
  p_billing_email text DEFAULT NULL,
  p_billing_address text DEFAULT NULL,
  p_account_notes text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_account_owner_user_id uuid DEFAULT NULL
)
RETURNS public.organizations
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_org public.organizations%rowtype;
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_nzbn text := nullif(regexp_replace(coalesce(p_nzbn, ''), '[^0-9]', '', 'g'), '');
  v_status text;
begin
  select actor.organization_id into v_provider from public.user_profiles actor where actor.id = v_actor and actor.deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) then
    raise exception 'Active CRM administrator required';
  end if;

  if p_action = 'create' then
    if p_client_request_id is null then
      raise exception 'client_request_id is required';
    end if;
    select o.* into v_org from public.organizations o where o.parent_organization_id = v_provider and o.client_request_id = p_client_request_id;
    if found then return v_org; end if;
  else
    select o.* into v_org from public.organizations o where o.id = p_organization_id for update;
    if not found then raise exception 'Organization not found'; end if;
    if v_org.id <> v_provider and v_org.parent_organization_id is distinct from v_provider then
      raise exception 'Organization is outside your managed account hierarchy';
    end if;
    if v_org.updated_at <> p_expected_updated_at then
      raise exception 'Organization changed since it was opened';
    end if;
  end if;

  if p_action in ('create', 'update') then
    if v_name is null or char_length(v_name) > 200 then
      raise exception 'Organization name is required and must be 200 characters or fewer';
    end if;
    if p_organization_type not in ('client', 'branch', 'contractor', 'government', 'private_enterprise') then
      raise exception 'Unsupported CRM organization type';
    end if;
    if exists (
      select 1 from public.organizations o
      where o.parent_organization_id = v_provider
        and lower(trim(o.name)) = lower(v_name)
        and o.id is distinct from p_organization_id
    ) then
      raise exception 'An organization with this name already exists in your account hierarchy';
    end if;
    if v_nzbn is not null and char_length(v_nzbn) <> 13 then
      raise exception 'NZBN must contain 13 digits';
    end if;

    if p_account_owner_user_id is not null and not exists (
      select 1 from public.user_profiles u
      where u.id = p_account_owner_user_id and u.organization_id = v_provider and u.deactivated_at is null
    ) then
      raise exception 'Account owner must be an active member of your organization';
    end if;

    if p_action = 'create' then
      insert into public.organizations (
        name, organization_type, parent_organization_id, active, status,
        nzbn, company_registration_number, contact_email, contact_phone,
        billing_email, billing_address, account_notes, client_request_id,
        account_owner_user_id
      )
      values (
        v_name, p_organization_type, v_provider, false, 'prospect',
        v_nzbn, nullif(trim(coalesce(p_company_registration_number, '')), ''),
        nullif(lower(trim(coalesce(p_contact_email, ''))), ''),
        nullif(trim(coalesce(p_contact_phone, '')), ''),
        nullif(lower(trim(coalesce(p_billing_email, ''))), ''),
        nullif(trim(coalesce(p_billing_address, '')), ''),
        nullif(trim(coalesce(p_account_notes, '')), ''),
        p_client_request_id,
        p_account_owner_user_id
      )
      returning * into v_org;

      insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
      values (
        v_provider, v_actor, 'crm_organization_created', 'organizations', v_org.id,
        jsonb_build_object('name', v_org.name, 'organization_type', v_org.organization_type, 'client_request_id', p_client_request_id)
      );
    else
      update public.organizations o set
        name = v_name,
        organization_type = p_organization_type,
        nzbn = v_nzbn,
        company_registration_number = nullif(trim(coalesce(p_company_registration_number, '')), ''),
        contact_email = nullif(lower(trim(coalesce(p_contact_email, ''))), ''),
        contact_phone = nullif(trim(coalesce(p_contact_phone, '')), ''),
        billing_email = nullif(lower(trim(coalesce(p_billing_email, ''))), ''),
        billing_address = nullif(trim(coalesce(p_billing_address, '')), ''),
        account_notes = nullif(trim(coalesce(p_account_notes, '')), ''),
        account_owner_user_id = coalesce(p_account_owner_user_id, o.account_owner_user_id)
      where o.id = v_org.id
      returning * into v_org;

      insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
      values (
        v_provider, v_actor, 'crm_organization_updated', 'organizations', v_org.id,
        jsonb_build_object('name', v_org.name, 'organization_type', v_org.organization_type)
      );
    end if;

    return v_org;
  end if;

  if p_action = 'archive' then
    update public.organizations set active = false, status = 'archived' where id = v_org.id returning * into v_org;
    insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
    values (v_provider, v_actor, 'crm_organization_archived', 'organizations', v_org.id, jsonb_build_object('name', v_org.name));
    return v_org;
  end if;

  raise exception 'Unsupported manage_crm_organization action %', p_action;
end;
$$;

REVOKE ALL ON FUNCTION "public"."manage_crm_organization"(uuid,uuid,timestamptz,text,text,text,text,text,text,text,text,text,text,text,uuid) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."manage_crm_organization"(uuid,uuid,timestamptz,text,text,text,text,text,text,text,text,text,text,text,uuid) TO "authenticated", "service_role";

-- 7. Governed Invoice Line Items & Generation RPCs
CREATE OR REPLACE FUNCTION "public"."add_crm_invoice_line"(
  p_client_request_id uuid,
  p_invoice_id uuid,
  p_description text,
  p_quantity numeric,
  p_unit_price numeric
)
RETURNS TABLE(
  line_id uuid,
  invoice_id uuid,
  subtotal numeric,
  gst_amount numeric,
  total_amount numeric,
  created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_invoice public.invoices%rowtype;
  v_line public.invoice_line_items%rowtype;
  v_description text := nullif(trim(coalesce(p_description, '')), '');
  v_next_seq integer;
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select i.* into v_invoice from public.invoices i where i.id = p_invoice_id for update;
  if not found then
    raise exception 'Invoice not found';
  end if;

  if not public.is_admin_for_org(v_invoice.organization_id) then
    raise exception 'Not authorised to manage invoices for this organization';
  end if;

  if v_invoice.status <> 'draft' then
    raise exception 'Only draft invoices can be updated';
  end if;

  if v_description is null then
    raise exception 'Line description is required';
  end if;

  if p_quantity is null or p_quantity <= 0 or p_unit_price is null or p_unit_price < 0 then
    raise exception 'Invoice line quantity and price must be positive numbers';
  end if;

  select coalesce(max(line_number), 0) + 1 into v_next_seq
  from public.invoice_line_items where invoice_id = v_invoice.id;

  insert into public.invoice_line_items (
    invoice_id, line_number, description, quantity, unit_price, line_total, organization_id
  )
  values (
    v_invoice.id, v_next_seq, v_description, p_quantity, p_unit_price, round(p_quantity * p_unit_price, 2), v_invoice.organization_id
  )
  returning * into v_line;

  update public.invoices i set
    subtotal = totals.subtotal,
    gst_amount = round(totals.subtotal * 0.15, 2),
    total_amount = round(totals.subtotal * 1.15, 2),
    updated_at = now()
  from (
    select coalesce(sum(l.line_total), 0)::numeric(12,2) subtotal
    from public.invoice_line_items l
    where l.invoice_id = v_invoice.id
  ) totals
  where i.id = v_invoice.id
  returning i.* into v_invoice;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_invoice.organization_id,
    v_actor,
    'crm_invoice_line_added',
    'invoice_line_items',
    v_line.id,
    jsonb_build_object(
      'invoice_id', v_invoice.id,
      'description', v_description,
      'quantity', p_quantity,
      'unit_price', p_unit_price,
      'line_total', v_line.line_total,
      'client_request_id', p_client_request_id
    )
  );

  return query select v_line.id, v_invoice.id, v_invoice.subtotal, v_invoice.gst_amount, v_invoice.total_amount, true;
end;
$$;

REVOKE ALL ON FUNCTION "public"."add_crm_invoice_line"(uuid,uuid,text,numeric,numeric) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."add_crm_invoice_line"(uuid,uuid,text,numeric,numeric) TO "authenticated", "service_role";

CREATE OR REPLACE FUNCTION "public"."remove_crm_invoice_line"(
  p_client_request_id uuid,
  p_invoice_id uuid,
  p_line_id uuid
)
RETURNS TABLE(
  invoice_id uuid,
  subtotal numeric,
  gst_amount numeric,
  total_amount numeric,
  removed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_invoice public.invoices%rowtype;
  v_line public.invoice_line_items%rowtype;
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select i.* into v_invoice from public.invoices i where i.id = p_invoice_id for update;
  if not found then
    raise exception 'Invoice not found';
  end if;

  if not public.is_admin_for_org(v_invoice.organization_id) then
    raise exception 'Not authorised to manage invoices for this organization';
  end if;

  if v_invoice.status <> 'draft' then
    raise exception 'Only draft invoices can be modified';
  end if;

  select l.* into v_line from public.invoice_line_items l where l.id = p_line_id and l.invoice_id = v_invoice.id;
  if not found then
    return query select v_invoice.id, v_invoice.subtotal, v_invoice.gst_amount, v_invoice.total_amount, false;
    return;
  end if;

  delete from public.invoice_line_items where id = v_line.id;

  update public.invoices i set
    subtotal = totals.subtotal,
    gst_amount = round(totals.subtotal * 0.15, 2),
    total_amount = round(totals.subtotal * 1.15, 2),
    updated_at = now()
  from (
    select coalesce(sum(l.line_total), 0)::numeric(12,2) subtotal
    from public.invoice_line_items l
    where l.invoice_id = v_invoice.id
  ) totals
  where i.id = v_invoice.id
  returning i.* into v_invoice;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_invoice.organization_id,
    v_actor,
    'crm_invoice_line_removed',
    'invoice_line_items',
    v_line.id,
    jsonb_build_object(
      'invoice_id', v_invoice.id,
      'description', v_line.description,
      'line_total', v_line.line_total,
      'client_request_id', p_client_request_id
    )
  );

  return query select v_invoice.id, v_invoice.subtotal, v_invoice.gst_amount, v_invoice.total_amount, true;
end;
$$;

REVOKE ALL ON FUNCTION "public"."remove_crm_invoice_line"(uuid,uuid,uuid) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."remove_crm_invoice_line"(uuid,uuid,uuid) TO "authenticated", "service_role";

CREATE OR REPLACE FUNCTION "public"."generate_crm_invoice_from_agreement"(
  p_client_request_id uuid,
  p_service_agreement_id uuid,
  p_service_period_start date,
  p_service_period_end date
)
RETURNS TABLE(
  invoice_id uuid,
  invoice_number text,
  client_organization_id uuid,
  subtotal numeric,
  gst_amount numeric,
  total_amount numeric,
  line_item_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_agreement public.service_agreements%rowtype;
  v_invoice public.invoices%rowtype;
  v_inv_number text;
  v_count integer := 0;
  v_qline record;
  v_comm public.crm_commercial_settings%rowtype;
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select sa.* into v_agreement from public.service_agreements sa where sa.id = p_service_agreement_id;
  if not found then
    raise exception 'Service agreement not found';
  end if;

  if not public.is_admin_for_org(v_agreement.provider_organization_id) then
    raise exception 'Not authorised to invoice for this agreement';
  end if;

  select 'INV-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substring(gen_random_uuid()::text, 1, 4)) into v_inv_number;

  insert into public.invoices (
    organization_id, client_organization_id, service_agreement_id,
    invoice_number, invoice_date, due_date, status,
    service_period_start, service_period_end, created_by
  )
  values (
    v_agreement.provider_organization_id, v_agreement.client_organization_id, v_agreement.id,
    v_inv_number, current_date, (current_date + interval '14 days')::date, 'draft',
    p_service_period_start, p_service_period_end, v_actor
  )
  returning * into v_invoice;

  -- 1. Try to copy line items from accepted quotes for this agreement
  for v_qline in (
    select ql.description, ql.quantity, ql.unit_charge
    from public.quotes q
    join public.quote_lines ql on ql.quote_id = q.id
    where q.service_agreement_id = v_agreement.id and q.status = 'accepted'
  ) loop
    v_count := v_count + 1;
    insert into public.invoice_line_items (
      invoice_id, line_number, description, quantity, unit_price, line_total, organization_id
    )
    values (
      v_invoice.id, v_count, v_qline.description, v_qline.quantity, v_qline.unit_charge,
      round(v_qline.quantity * v_qline.unit_charge, 2), v_invoice.organization_id
    );
  end loop;

  -- 2. If no quote lines exist, check crm_commercial_settings
  if v_count = 0 then
    select cs.* into v_comm from public.crm_commercial_settings cs where cs.service_agreement_id = v_agreement.id;
    if found and v_comm.base_rate_per_hour is not null then
      v_count := 1;
      insert into public.invoice_line_items (
        invoice_id, line_number, description, quantity, unit_price, line_total, organization_id
      )
      values (
        v_invoice.id, 1, 'Monthly Service Agreement Base Retainer', 1, v_comm.base_rate_per_hour,
        v_comm.base_rate_per_hour, v_invoice.organization_id
      );
    else
      -- Fallback default service line item
      v_count := 1;
      insert into public.invoice_line_items (
        invoice_id, line_number, description, quantity, unit_price, line_total, organization_id
      )
      values (
        v_invoice.id, 1, 'Field Compliance & Safety Service Retainer (' || to_char(p_service_period_start, 'Mon YYYY') || ')', 1, 500.00,
        500.00, v_invoice.organization_id
      );
    end if;
  end if;

  -- Recompute totals
  update public.invoices i set
    subtotal = totals.subtotal,
    gst_amount = round(totals.subtotal * 0.15, 2),
    total_amount = round(totals.subtotal * 1.15, 2),
    updated_at = now()
  from (
    select coalesce(sum(l.line_total), 0)::numeric(12,2) subtotal
    from public.invoice_line_items l
    where l.invoice_id = v_invoice.id
  ) totals
  where i.id = v_invoice.id
  returning i.* into v_invoice;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_invoice.organization_id,
    v_actor,
    'crm_invoice_generated_from_agreement',
    'invoices',
    v_invoice.id,
    jsonb_build_object(
      'service_agreement_id', v_agreement.id,
      'invoice_number', v_invoice.invoice_number,
      'subtotal', v_invoice.subtotal,
      'total_amount', v_invoice.total_amount,
      'line_item_count', v_count,
      'client_request_id', p_client_request_id
    )
  );

  return query select v_invoice.id, v_invoice.invoice_number, v_invoice.client_organization_id, v_invoice.subtotal, v_invoice.gst_amount, v_invoice.total_amount, v_count;
end;
$$;

REVOKE ALL ON FUNCTION "public"."generate_crm_invoice_from_agreement"(uuid,uuid,date,date) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."generate_crm_invoice_from_agreement"(uuid,uuid,date,date) TO "authenticated", "service_role";
