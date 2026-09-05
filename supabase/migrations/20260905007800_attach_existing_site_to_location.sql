CREATE OR REPLACE FUNCTION public.attach_crm_site_to_location(p_site_id uuid,p_location_id uuid)
RETURNS public.client_sites LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_actor uuid:=auth.uid(); v_provider uuid; v_site public.client_sites%rowtype;
BEGIN
 SELECT up.organization_id INTO v_provider FROM public.user_profiles AS up WHERE up.id=v_actor AND up.deactivated_at IS NULL;
 SELECT site.* INTO v_site FROM public.client_sites AS site WHERE site.id=p_site_id FOR UPDATE;
 IF v_provider IS NULL OR NOT public.is_admin_for_org(v_provider) OR NOT public.crm_actor_can_manage_account(v_site.client_organization_id) THEN RAISE EXCEPTION 'Active CRM administrator required'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.locations AS house WHERE house.id=p_location_id AND house.organization_id=v_site.client_organization_id) THEN RAISE EXCEPTION 'Location house does not belong to the Site organization'; END IF;
 UPDATE public.client_sites SET location_id=p_location_id WHERE id=v_site.id RETURNING * INTO v_site;
 INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) VALUES(v_provider,v_actor,'crm_site_attached_to_location','client_sites',v_site.id,jsonb_build_object('location_id',p_location_id));
 RETURN v_site;
END; $$;
REVOKE ALL ON FUNCTION public.attach_crm_site_to_location(uuid,uuid) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.attach_crm_site_to_location(uuid,uuid) TO authenticated,service_role;
