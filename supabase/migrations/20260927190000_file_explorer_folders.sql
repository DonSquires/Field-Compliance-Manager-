-- Persistent Explorer-style folders for organisation documents.
-- Canonical entities own folders; documents retain their existing provenance and storage identity.

CREATE TABLE IF NOT EXISTS public.file_spaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  space_key text NOT NULL,
  name text NOT NULL,
  sensitivity text NOT NULL DEFAULT 'internal' CHECK (sensitivity IN ('internal','restricted')),
  default_retention_class text,
  sort_order integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, space_key)
);

CREATE TABLE IF NOT EXISTS public.file_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  space_id uuid NOT NULL REFERENCES public.file_spaces(id) ON DELETE CASCADE,
  parent_folder_id uuid REFERENCES public.file_folders(id) ON DELETE CASCADE,
  name text NOT NULL,
  folder_key text NOT NULL,
  folder_kind text NOT NULL DEFAULT 'custom' CHECK (folder_kind IN ('system','entity','custom')),
  entity_type text CHECK (entity_type IS NULL OR entity_type IN ('location','person_record','user_profile')),
  entity_id uuid,
  policy_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_order integer NOT NULL DEFAULT 100,
  client_request_id uuid,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((entity_type IS NULL) = (entity_id IS NULL)),
  UNIQUE (space_id, folder_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS file_folders_active_sibling_name_uidx
  ON public.file_folders (space_id, coalesce(parent_folder_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name))
  WHERE active;
CREATE UNIQUE INDEX IF NOT EXISTS file_folders_active_entity_uidx
  ON public.file_folders (organization_id, entity_type, entity_id)
  WHERE active AND entity_type IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS file_folders_client_request_uidx
  ON public.file_folders (organization_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS file_folders_parent_idx ON public.file_folders (space_id, parent_folder_id, sort_order, name) WHERE active;

CREATE TABLE IF NOT EXISTS public.document_placements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  space_id uuid NOT NULL REFERENCES public.file_spaces(id) ON DELETE CASCADE,
  folder_id uuid REFERENCES public.file_folders(id) ON DELETE SET NULL,
  is_primary boolean NOT NULL DEFAULT true,
  client_request_id uuid,
  placed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  placed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  removed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS document_placements_active_primary_uidx
  ON public.document_placements (document_id) WHERE is_primary AND removed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS document_placements_client_request_uidx
  ON public.document_placements (organization_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS document_placements_folder_idx
  ON public.document_placements (organization_id, space_id, folder_id, placed_at DESC)
  WHERE removed_at IS NULL;

COMMENT ON TABLE public.file_spaces IS 'Tenant-owned top-level File Explorer spaces. The organisation is the root; sensitivity controls whether ordinary operational access or HR/finance administrator access is required.';
COMMENT ON TABLE public.file_folders IS 'Persistent folders inside a file space. Entity folders link to tenant location/person projections; custom folders are created only through governed RPCs.';
COMMENT ON TABLE public.document_placements IS 'Auditable document-to-folder placement history. Exactly one active primary placement exists per tenant document.';

CREATE OR REPLACE FUNCTION public.file_restricted_access_allowed(p_organization_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS(
    SELECT 1 FROM public.user_profiles actor
    WHERE actor.id=auth.uid() AND actor.deactivated_at IS NULL
      AND actor.role IN('grand_master','master','admin')
      AND (
        actor.organization_id=p_organization_id
        OR actor.employer_organization_id=p_organization_id
        OR p_organization_id=ANY(public.get_descendant_organizations(coalesce(actor.employer_organization_id,actor.organization_id)))
      )
  );
$$;
REVOKE ALL ON FUNCTION public.file_restricted_access_allowed(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.file_restricted_access_allowed(uuid) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.file_space_access_allowed(p_organization_id uuid, p_sensitivity text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT auth.uid() IS NOT NULL
    AND public.org_access_allowed(p_organization_id)
    AND (p_sensitivity <> 'restricted' OR public.file_restricted_access_allowed(p_organization_id));
$$;
REVOKE ALL ON FUNCTION public.file_space_access_allowed(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.file_space_access_allowed(uuid,text) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.ensure_file_organization_tree(p_organization_id uuid)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_organisation_space uuid;v_people_space uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id=p_organization_id) THEN RAISE EXCEPTION 'Organization not found'; END IF;
  INSERT INTO public.file_spaces(organization_id,space_key,name,sensitivity,sort_order) VALUES
    (p_organization_id,'organisation','Organisation','internal',10),
    (p_organization_id,'contracts','Contracts','internal',20),
    (p_organization_id,'locations','Locations','internal',30),
    (p_organization_id,'people','People','restricted',40),
    (p_organization_id,'finance','Finance','restricted',50),
    (p_organization_id,'evidence','Evidence','restricted',60),
    (p_organization_id,'investigations','Investigations','restricted',70),
    (p_organization_id,'bob','Bob intake','internal',80),
    (p_organization_id,'generated','Generated outputs','internal',90)
  ON CONFLICT(organization_id,space_key) DO UPDATE SET name=excluded.name,sensitivity=excluded.sensitivity,sort_order=excluded.sort_order,active=true,updated_at=clock_timestamp();

  SELECT id INTO v_organisation_space FROM public.file_spaces WHERE organization_id=p_organization_id AND space_key='organisation';
  INSERT INTO public.file_folders(organization_id,space_id,name,folder_key,folder_kind,policy_json) VALUES
    (p_organization_id,v_organisation_space,'Company records','company_records','system',jsonb_build_object('purpose','corporate records and registrations')),
    (p_organization_id,v_organisation_space,'Health & safety','health_safety','system',jsonb_build_object('purpose','organisation health and safety documents')),
    (p_organization_id,v_organisation_space,'Policies','policies','system',jsonb_build_object('purpose','organisation policies and procedures')),
    (p_organization_id,v_organisation_space,'Unfiled','unfiled','system',jsonb_build_object('purpose','new files awaiting folder placement'))
  ON CONFLICT(space_id,folder_key) DO UPDATE SET name=excluded.name,policy_json=excluded.policy_json,active=true,updated_at=clock_timestamp();

  SELECT id INTO v_people_space FROM public.file_spaces WHERE organization_id=p_organization_id AND space_key='people';
  INSERT INTO public.file_folders(organization_id,space_id,name,folder_key,folder_kind,policy_json) VALUES
    (p_organization_id,v_people_space,'Users & staff','users_staff','system',jsonb_build_object('purpose','staff and application user folders')),
    (p_organization_id,v_people_space,'Other people','other_people','system',jsonb_build_object('purpose','tenant person records that are not staff accounts'))
  ON CONFLICT(space_id,folder_key) DO UPDATE SET name=excluded.name,policy_json=excluded.policy_json,active=true,updated_at=clock_timestamp();
END;
$$;
REVOKE ALL ON FUNCTION public.ensure_file_organization_tree(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ensure_file_organization_tree(uuid) TO postgres,service_role;

CREATE OR REPLACE FUNCTION public.upsert_file_entity_folder(
  p_organization_id uuid,p_space_key text,p_parent_key text,p_entity_type text,p_entity_id uuid,p_name text
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_space uuid;v_parent uuid;v_folder uuid;v_name text:=coalesce(nullif(trim(p_name),''),'Unnamed');
BEGIN
  PERFORM public.ensure_file_organization_tree(p_organization_id);
  SELECT id INTO v_space FROM public.file_spaces WHERE organization_id=p_organization_id AND space_key=p_space_key AND active;
  IF v_space IS NULL THEN RAISE EXCEPTION 'File space not found'; END IF;
  IF p_parent_key IS NOT NULL THEN SELECT id INTO v_parent FROM public.file_folders WHERE space_id=v_space AND folder_key=p_parent_key AND active; END IF;
  IF EXISTS(SELECT 1 FROM public.file_folders folder WHERE folder.space_id=v_space AND folder.parent_folder_id IS NOT DISTINCT FROM v_parent AND lower(folder.name)=lower(v_name) AND folder.active AND NOT (folder.entity_type=p_entity_type AND folder.entity_id=p_entity_id)) THEN
    v_name:=left(v_name,145)||' · '||left(p_entity_id::text,8);
  END IF;
  INSERT INTO public.file_folders(organization_id,space_id,parent_folder_id,name,folder_key,folder_kind,entity_type,entity_id)
  VALUES(p_organization_id,v_space,v_parent,left(v_name,160),'entity:'||p_entity_type||':'||p_entity_id::text,'entity',p_entity_type,p_entity_id)
  ON CONFLICT(organization_id,entity_type,entity_id) WHERE active AND entity_type IS NOT NULL
  DO UPDATE SET space_id=excluded.space_id,parent_folder_id=excluded.parent_folder_id,name=excluded.name,folder_key=excluded.folder_key,updated_at=clock_timestamp()
  RETURNING id INTO v_folder;
  RETURN v_folder;
END;
$$;
REVOKE ALL ON FUNCTION public.upsert_file_entity_folder(uuid,text,text,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.upsert_file_entity_folder(uuid,text,text,text,uuid,text) TO postgres,service_role;

CREATE OR REPLACE FUNCTION public.sync_file_organization_tree()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN PERFORM public.ensure_file_organization_tree(NEW.id);RETURN NEW;END;
$$;
CREATE OR REPLACE FUNCTION public.sync_file_location_folder()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN PERFORM public.upsert_file_entity_folder(NEW.organization_id,'locations',NULL,'location',NEW.id,NEW.name||coalesce(' · '||nullif(trim(NEW.address),''),''));RETURN NEW;END;
$$;
CREATE OR REPLACE FUNCTION public.sync_file_user_folder()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_person uuid;v_name text:=coalesce(nullif(trim(NEW.display_name),''),nullif(trim(NEW.email),''),'User');
BEGIN
  SELECT person.id INTO v_person FROM public.person_records person
  JOIN public.staff_profiles staff ON person.metadata->>'staff_profile_id'=staff.id::text
  WHERE coalesce(staff.user_id,staff.id)=NEW.id AND person.organization_id=NEW.organization_id LIMIT 1;
  IF v_person IS NULL THEN
    PERFORM public.upsert_file_entity_folder(NEW.organization_id,'people','users_staff','user_profile',NEW.id,v_name);
  ELSE
    PERFORM public.upsert_file_entity_folder(NEW.organization_id,'people','users_staff','person_record',v_person,v_name);
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.sync_file_person_folder()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_staff uuid;v_user uuid;v_existing uuid;v_parent text:='other_people';v_name text:=coalesce(nullif(trim(NEW.display_name),''),'Person');
BEGIN
  IF coalesce(NEW.metadata->>'staff_profile_id','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_staff:=(NEW.metadata->>'staff_profile_id')::uuid;
    SELECT coalesce(staff.user_id,staff.id) INTO v_user FROM public.staff_profiles staff WHERE staff.id=v_staff;
  END IF;
  IF v_user IS NOT NULL THEN
    v_parent:='users_staff';
    SELECT id INTO v_existing FROM public.file_folders WHERE organization_id=NEW.organization_id AND entity_type='user_profile' AND entity_id=v_user AND active LIMIT 1;
    IF v_existing IS NOT NULL THEN
      UPDATE public.file_folders SET entity_type='person_record',entity_id=NEW.id,folder_key='entity:person_record:'||NEW.id::text,name=left(v_name,160),updated_at=clock_timestamp() WHERE id=v_existing;
      RETURN NEW;
    END IF;
  END IF;
  PERFORM public.upsert_file_entity_folder(NEW.organization_id,'people',v_parent,'person_record',NEW.id,v_name);
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.sync_file_document_placement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_space uuid;v_folder uuid;v_space_key text;
BEGIN
  IF NEW.organization_id IS NULL THEN RETURN NEW; END IF;
  PERFORM public.ensure_file_organization_tree(NEW.organization_id);
  v_space_key:=CASE WHEN NEW.current_scope='quarantined' THEN 'bob' WHEN NEW.source_channel='system_generated' THEN 'generated' ELSE 'organisation' END;
  SELECT id INTO v_space FROM public.file_spaces WHERE organization_id=NEW.organization_id AND space_key=v_space_key;
  IF v_space_key='organisation' THEN SELECT id INTO v_folder FROM public.file_folders WHERE space_id=v_space AND folder_key='unfiled' AND active; END IF;
  INSERT INTO public.document_placements(organization_id,document_id,space_id,folder_id,is_primary,placed_by)
  VALUES(NEW.organization_id,NEW.id,v_space,v_folder,true,NEW.uploaded_by)
  ON CONFLICT(document_id) WHERE is_primary AND removed_at IS NULL DO NOTHING;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_file_organization_tree(),public.sync_file_location_folder(),public.sync_file_user_folder(),public.sync_file_person_folder(),public.sync_file_document_placement() FROM PUBLIC,anon,authenticated,service_role;

DROP TRIGGER IF EXISTS trg_file_organization_tree ON public.organizations;
CREATE TRIGGER trg_file_organization_tree AFTER INSERT ON public.organizations FOR EACH ROW EXECUTE FUNCTION public.sync_file_organization_tree();
DROP TRIGGER IF EXISTS trg_file_location_folder ON public.locations;
CREATE TRIGGER trg_file_location_folder AFTER INSERT OR UPDATE OF name,organization_id ON public.locations FOR EACH ROW EXECUTE FUNCTION public.sync_file_location_folder();
DROP TRIGGER IF EXISTS trg_file_user_folder ON public.user_profiles;
CREATE TRIGGER trg_file_user_folder AFTER INSERT OR UPDATE OF display_name,email,organization_id ON public.user_profiles FOR EACH ROW EXECUTE FUNCTION public.sync_file_user_folder();
DROP TRIGGER IF EXISTS trg_file_person_folder ON public.person_records;
CREATE TRIGGER trg_file_person_folder AFTER INSERT OR UPDATE OF display_name,organization_id,metadata ON public.person_records FOR EACH ROW EXECUTE FUNCTION public.sync_file_person_folder();
DROP TRIGGER IF EXISTS trg_file_document_placement ON public.documents;
CREATE TRIGGER trg_file_document_placement AFTER INSERT ON public.documents FOR EACH ROW EXECUTE FUNCTION public.sync_file_document_placement();

CREATE OR REPLACE FUNCTION public.validate_file_folder_parent()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_parent public.file_folders%rowtype;
BEGIN
  IF NEW.parent_folder_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.parent_folder_id=NEW.id THEN RAISE EXCEPTION 'A folder cannot contain itself'; END IF;
  SELECT * INTO v_parent FROM public.file_folders WHERE id=NEW.parent_folder_id;
  IF v_parent.id IS NULL OR v_parent.organization_id<>NEW.organization_id OR v_parent.space_id<>NEW.space_id THEN RAISE EXCEPTION 'Parent folder must be in the same file space'; END IF;
  IF EXISTS(WITH RECURSIVE ancestors AS(SELECT parent_folder_id FROM public.file_folders WHERE id=NEW.parent_folder_id UNION ALL SELECT folder.parent_folder_id FROM public.file_folders folder JOIN ancestors ON folder.id=ancestors.parent_folder_id) SELECT 1 FROM ancestors WHERE parent_folder_id=NEW.id) THEN RAISE EXCEPTION 'Folder nesting would create a cycle'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.validate_file_folder_parent() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS trg_validate_file_folder_parent ON public.file_folders;
CREATE TRIGGER trg_validate_file_folder_parent BEFORE INSERT OR UPDATE OF parent_folder_id,space_id,organization_id ON public.file_folders FOR EACH ROW EXECUTE FUNCTION public.validate_file_folder_parent();

DO $$ DECLARE item record;BEGIN
  FOR item IN SELECT id FROM public.organizations LOOP PERFORM public.ensure_file_organization_tree(item.id);END LOOP;
  FOR item IN SELECT id,organization_id,name,address FROM public.locations LOOP PERFORM public.upsert_file_entity_folder(item.organization_id,'locations',NULL,'location',item.id,item.name||coalesce(' · '||nullif(trim(item.address),''),''));END LOOP;
END $$;

-- Backfill user folders without invoking a trigger function outside trigger context.
DO $$ DECLARE item record;BEGIN
  FOR item IN SELECT profile.id,profile.organization_id,coalesce(nullif(trim(profile.display_name),''),nullif(trim(profile.email),''),'User') name FROM public.user_profiles profile LOOP
    PERFORM public.upsert_file_entity_folder(item.organization_id,'people','users_staff','user_profile',item.id,item.name);
  END LOOP;
  FOR item IN SELECT id,organization_id,display_name,metadata FROM public.person_records LOOP
    IF coalesce(item.metadata->>'staff_profile_id','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      UPDATE public.file_folders folder SET entity_type='person_record',entity_id=item.id,folder_key='entity:person_record:'||item.id::text,name=left(coalesce(nullif(trim(item.display_name),''),'Person'),160),updated_at=clock_timestamp()
      FROM public.staff_profiles staff WHERE staff.id=(item.metadata->>'staff_profile_id')::uuid AND coalesce(staff.user_id,staff.id)=folder.entity_id AND folder.organization_id=item.organization_id AND folder.entity_type='user_profile' AND folder.active;
      IF FOUND THEN CONTINUE; END IF;
    END IF;
    PERFORM public.upsert_file_entity_folder(item.organization_id,'people',CASE WHEN item.metadata ? 'staff_profile_id' THEN 'users_staff' ELSE 'other_people' END,'person_record',item.id,coalesce(nullif(trim(item.display_name),''),'Person'));
  END LOOP;
END $$;

INSERT INTO public.document_placements(organization_id,document_id,space_id,folder_id,is_primary,placed_by)
SELECT document.organization_id,document.id,space.id,folder.id,true,document.uploaded_by
FROM public.documents document
JOIN public.file_spaces space ON space.organization_id=document.organization_id AND space.space_key=CASE WHEN document.current_scope='quarantined' THEN 'bob' WHEN document.source_channel='system_generated' THEN 'generated' ELSE 'organisation' END
LEFT JOIN public.file_folders folder ON folder.space_id=space.id AND folder.folder_key='unfiled' AND folder.active
WHERE document.organization_id IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM public.document_placements placement WHERE placement.document_id=document.id AND placement.is_primary AND placement.removed_at IS NULL);

CREATE OR REPLACE FUNCTION public.get_file_explorer_tree(p_organization_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_sensitive boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT public.org_access_allowed(p_organization_id) THEN RAISE EXCEPTION 'File access denied'; END IF;
  v_sensitive:=public.is_admin_for_org(p_organization_id);
  RETURN jsonb_build_object(
    'organization',(SELECT jsonb_build_object('id',org.id,'name',org.name) FROM public.organizations org WHERE org.id=p_organization_id),
    'spaces',coalesce((SELECT jsonb_agg(jsonb_build_object('id',space.id,'space_key',space.space_key,'name',space.name,'sensitivity',space.sensitivity,'sort_order',space.sort_order,'document_count',(SELECT count(*) FROM public.document_placements placement WHERE placement.space_id=space.id AND placement.is_primary AND placement.removed_at IS NULL)) ORDER BY space.sort_order,space.name) FROM public.file_spaces space WHERE space.organization_id=p_organization_id AND space.active AND (space.sensitivity<>'restricted' OR v_sensitive)),'[]'::jsonb),
    'folders',coalesce((SELECT jsonb_agg(jsonb_build_object('id',folder.id,'space_id',folder.space_id,'parent_folder_id',folder.parent_folder_id,'name',folder.name,'folder_kind',folder.folder_kind,'entity_type',folder.entity_type,'entity_id',folder.entity_id,'document_count',(SELECT count(*) FROM public.document_placements placement WHERE placement.folder_id=folder.id AND placement.is_primary AND placement.removed_at IS NULL)) ORDER BY folder.name) FROM public.file_folders folder JOIN public.file_spaces space ON space.id=folder.space_id WHERE folder.organization_id=p_organization_id AND folder.active AND space.active AND (space.sensitivity<>'restricted' OR v_sensitive)),'[]'::jsonb),
    'placements',coalesce((SELECT jsonb_agg(jsonb_build_object('document_id',placement.document_id,'space_id',placement.space_id,'folder_id',placement.folder_id)) FROM public.document_placements placement JOIN public.file_spaces space ON space.id=placement.space_id WHERE placement.organization_id=p_organization_id AND placement.is_primary AND placement.removed_at IS NULL AND space.active AND (space.sensitivity<>'restricted' OR v_sensitive)),'[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.create_file_folder(p_organization_id uuid,p_space_id uuid,p_parent_folder_id uuid,p_name text,p_client_request_id uuid)
RETURNS public.file_folders
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_actor uuid:=auth.uid();v_space public.file_spaces%rowtype;v_folder public.file_folders%rowtype;v_name text:=nullif(trim(coalesce(p_name,'')),'');
BEGIN
  IF v_actor IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN RAISE EXCEPTION 'Active organization administrator required'; END IF;
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  SELECT * INTO v_folder FROM public.file_folders WHERE organization_id=p_organization_id AND client_request_id=p_client_request_id;
  IF FOUND THEN RETURN v_folder; END IF;
  IF v_name IS NULL OR char_length(v_name)>160 OR v_name IN ('.','..') OR v_name ~ '[\\/]' THEN RAISE EXCEPTION 'Folder name is required, must be 160 characters or fewer, and cannot contain slashes'; END IF;
  SELECT * INTO v_space FROM public.file_spaces WHERE id=p_space_id AND organization_id=p_organization_id AND active FOR UPDATE;
  IF v_space.id IS NULL THEN RAISE EXCEPTION 'File space not found'; END IF;
  IF NOT public.file_space_access_allowed(p_organization_id,v_space.sensitivity) THEN RAISE EXCEPTION 'Folder access denied'; END IF;
  IF p_parent_folder_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.file_folders WHERE id=p_parent_folder_id AND organization_id=p_organization_id AND space_id=p_space_id AND active) THEN RAISE EXCEPTION 'Parent folder not found in this file space'; END IF;
  IF EXISTS(SELECT 1 FROM public.file_folders WHERE space_id=p_space_id AND parent_folder_id IS NOT DISTINCT FROM p_parent_folder_id AND lower(name)=lower(v_name) AND active) THEN RAISE EXCEPTION 'A folder with this name already exists here'; END IF;
  INSERT INTO public.file_folders(organization_id,space_id,parent_folder_id,name,folder_key,folder_kind,client_request_id,created_by)
  VALUES(p_organization_id,p_space_id,p_parent_folder_id,v_name,'custom:'||p_client_request_id::text,'custom',p_client_request_id,v_actor) RETURNING * INTO v_folder;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) VALUES(p_organization_id,v_actor,'file_folder_created','file_folders',v_folder.id,jsonb_build_object('space_id',p_space_id,'parent_folder_id',p_parent_folder_id,'name',v_name));
  RETURN v_folder;
END;
$$;

CREATE OR REPLACE FUNCTION public.move_document_to_folder(p_organization_id uuid,p_document_id uuid,p_space_id uuid,p_folder_id uuid,p_client_request_id uuid)
RETURNS public.document_placements
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_actor uuid:=auth.uid();v_space public.file_spaces%rowtype;v_folder public.file_folders%rowtype;v_placement public.document_placements%rowtype;
BEGIN
  IF v_actor IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN RAISE EXCEPTION 'Active organization administrator required'; END IF;
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  SELECT * INTO v_placement FROM public.document_placements WHERE organization_id=p_organization_id AND client_request_id=p_client_request_id;
  IF FOUND THEN RETURN v_placement; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.documents WHERE id=p_document_id AND organization_id=p_organization_id) THEN RAISE EXCEPTION 'Document not found in this organization'; END IF;
  SELECT * INTO v_space FROM public.file_spaces WHERE id=p_space_id AND organization_id=p_organization_id AND active;
  IF v_space.id IS NULL THEN RAISE EXCEPTION 'Destination section not found'; END IF;
  IF NOT public.file_space_access_allowed(p_organization_id,v_space.sensitivity) THEN RAISE EXCEPTION 'Destination folder access denied'; END IF;
  IF EXISTS(SELECT 1 FROM public.document_placements placement JOIN public.file_spaces source_space ON source_space.id=placement.space_id WHERE placement.document_id=p_document_id AND placement.is_primary AND placement.removed_at IS NULL AND NOT public.file_space_access_allowed(p_organization_id,source_space.sensitivity)) THEN RAISE EXCEPTION 'Source file access denied'; END IF;
  IF p_folder_id IS NOT NULL THEN
    SELECT * INTO v_folder FROM public.file_folders WHERE id=p_folder_id AND organization_id=p_organization_id AND space_id=p_space_id AND active;
    IF v_folder.id IS NULL THEN RAISE EXCEPTION 'Destination folder not found'; END IF;
  END IF;
  UPDATE public.document_placements SET is_primary=false,removed_at=clock_timestamp() WHERE document_id=p_document_id AND is_primary AND removed_at IS NULL;
  INSERT INTO public.document_placements(organization_id,document_id,space_id,folder_id,is_primary,client_request_id,placed_by)
  VALUES(p_organization_id,p_document_id,v_space.id,v_folder.id,true,p_client_request_id,v_actor) RETURNING * INTO v_placement;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) VALUES(p_organization_id,v_actor,'document_moved_to_folder','documents',p_document_id,jsonb_build_object('folder_id',p_folder_id,'space_id',v_space.id,'placement_id',v_placement.id));
  RETURN v_placement;
END;
$$;

ALTER TABLE public.file_spaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.file_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_placements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS file_spaces_select ON public.file_spaces;
CREATE POLICY file_spaces_select ON public.file_spaces FOR SELECT TO authenticated USING(public.file_space_access_allowed(organization_id,sensitivity));
DROP POLICY IF EXISTS file_folders_select ON public.file_folders;
CREATE POLICY file_folders_select ON public.file_folders FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM public.file_spaces space WHERE space.id=file_folders.space_id AND public.file_space_access_allowed(space.organization_id,space.sensitivity)));
DROP POLICY IF EXISTS document_placements_select ON public.document_placements;
CREATE POLICY document_placements_select ON public.document_placements FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM public.file_spaces space WHERE space.id=document_placements.space_id AND public.file_space_access_allowed(space.organization_id,space.sensitivity)));

DROP POLICY IF EXISTS documents_select ON public.documents;
CREATE POLICY documents_select ON public.documents FOR SELECT TO authenticated USING(
  (organization_id IS NULL AND current_scope='global_reference')
  OR EXISTS(
    SELECT 1 FROM public.document_placements placement
    JOIN public.file_spaces space ON space.id=placement.space_id
    WHERE placement.document_id=documents.id AND placement.is_primary AND placement.removed_at IS NULL
      AND public.file_space_access_allowed(space.organization_id,space.sensitivity)
  )
);
DROP POLICY IF EXISTS documents_write ON public.documents;
CREATE POLICY documents_insert ON public.documents FOR INSERT TO authenticated WITH CHECK(organization_id IS NOT NULL AND public.is_admin_for_org(organization_id));
CREATE POLICY documents_update ON public.documents FOR UPDATE TO authenticated USING(
  EXISTS(SELECT 1 FROM public.document_placements placement JOIN public.file_spaces space ON space.id=placement.space_id WHERE placement.document_id=documents.id AND placement.is_primary AND placement.removed_at IS NULL AND public.file_space_access_allowed(space.organization_id,space.sensitivity))
) WITH CHECK(organization_id IS NOT NULL AND public.is_admin_for_org(organization_id));
CREATE POLICY documents_delete ON public.documents FOR DELETE TO authenticated USING(
  EXISTS(SELECT 1 FROM public.document_placements placement JOIN public.file_spaces space ON space.id=placement.space_id WHERE placement.document_id=documents.id AND placement.is_primary AND placement.removed_at IS NULL AND public.file_space_access_allowed(space.organization_id,space.sensitivity))
);

DROP POLICY IF EXISTS document_versions_select ON public.document_versions;
CREATE POLICY document_versions_select ON public.document_versions FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM public.documents document WHERE document.id=document_versions.document_id));
DROP POLICY IF EXISTS document_versions_write ON public.document_versions;
CREATE POLICY document_versions_write ON public.document_versions FOR ALL TO authenticated USING(EXISTS(SELECT 1 FROM public.documents document WHERE document.id=document_versions.document_id)) WITH CHECK(EXISTS(SELECT 1 FROM public.documents document WHERE document.id=document_versions.document_id));

REVOKE ALL ON TABLE public.file_spaces,public.file_folders,public.document_placements FROM PUBLIC,anon,authenticated;
GRANT SELECT ON TABLE public.file_spaces,public.file_folders,public.document_placements TO authenticated;
GRANT ALL ON TABLE public.file_spaces,public.file_folders,public.document_placements TO service_role;
REVOKE ALL ON FUNCTION public.get_file_explorer_tree(uuid),public.create_file_folder(uuid,uuid,uuid,text,uuid),public.move_document_to_folder(uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_file_explorer_tree(uuid),public.create_file_folder(uuid,uuid,uuid,text,uuid),public.move_document_to_folder(uuid,uuid,uuid,uuid,uuid) TO authenticated,service_role;

COMMENT ON FUNCTION public.get_file_explorer_tree(uuid) IS 'Returns the caller-visible organization File Explorer tree and active document placements, filtering restricted spaces by role.';
COMMENT ON FUNCTION public.create_file_folder(uuid,uuid,uuid,text,uuid) IS 'Creates an audited custom folder inside an authorized organization file space.';
COMMENT ON FUNCTION public.move_document_to_folder(uuid,uuid,uuid,uuid,uuid) IS 'Moves a tenant document to a file-space root or folder while retaining placement history and an audit receipt.';
