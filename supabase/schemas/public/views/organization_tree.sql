create view "public"."organization_tree" AS  WITH RECURSIVE tree AS (
         SELECT organizations.id,
            organizations.name,
            organizations.organization_type,
            organizations.parent_organization_id,
            0 AS depth,
            organizations.id AS root_id,
            organizations.name AS path
           FROM public.organizations
          WHERE (organizations.parent_organization_id IS NULL)
        UNION ALL
         SELECT o.id,
            o.name,
            o.organization_type,
            o.parent_organization_id,
            (t.depth + 1),
            t.root_id,
            ((t.path || ' \u203a '::text) || o.name)
           FROM (public.organizations o
             JOIN tree t ON ((o.parent_organization_id = t.id)))
        )
 SELECT id,
    name,
    organization_type,
    parent_organization_id,
    depth,
    root_id,
    path
   FROM tree;

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."organization_tree" to "anon", "authenticated", "postgres", "service_role";
