REVOKE SELECT ON TABLE public.staff_documents
  FROM PUBLIC, anon;

DROP POLICY IF EXISTS staff_documents_select ON public.staff_documents;
CREATE POLICY staff_documents_select
ON public.staff_documents
FOR SELECT
TO authenticated
USING (public.is_admin_for_org(organization_id));


DROP POLICY IF EXISTS staff_documents_insert ON public.staff_documents;
CREATE POLICY staff_documents_insert
ON public.staff_documents
FOR INSERT
TO authenticated
WITH CHECK (public.is_admin_for_org(organization_id));

DROP POLICY IF EXISTS staff_documents_update ON public.staff_documents;
CREATE POLICY staff_documents_update
ON public.staff_documents
FOR UPDATE
TO authenticated
USING (public.is_admin_for_org(organization_id))
WITH CHECK (public.is_admin_for_org(organization_id));

DROP POLICY IF EXISTS staff_documents_delete ON public.staff_documents;
CREATE POLICY staff_documents_delete
ON public.staff_documents
FOR DELETE
TO authenticated
USING (public.is_admin_for_org(organization_id));
