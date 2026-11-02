CREATE TABLE public.website_posts (
  id uuid PRIMARY KEY,
  provider_organization_id uuid NOT NULL REFERENCES public.organizations(id),
  slug text NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  summary text NOT NULL DEFAULT '' CHECK (char_length(summary) <= 300),
  body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 20000),
  photo_path text,
  photo_alt text NOT NULL DEFAULT '' CHECK (char_length(photo_alt) <= 240),
  published_content jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES public.user_profiles(id),
  updated_by uuid NOT NULL REFERENCES public.user_profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_request_id uuid NOT NULL,
  last_request_payload jsonb NOT NULL,
  UNIQUE (provider_organization_id, slug)
);

COMMENT ON TABLE public.website_posts IS
  'Provider-private marketing drafts. Only an explicit publish action copies validated text/photo into published_content; saving a draft never changes the public copy. Plain text, not executable HTML.';
CREATE INDEX website_posts_updated_idx
  ON public.website_posts (provider_organization_id, updated_at DESC, id);
ALTER TABLE public.website_posts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.website_posts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.website_posts TO authenticated;

CREATE FUNCTION public.website_post_admin_organization()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
  SELECT t.service_provider_organization_id
  FROM private.platform_tenancy t
  WHERE t.singleton AND auth.uid() IS NOT NULL
    AND (public.is_grand_master() OR public.is_admin_for_org(t.service_provider_organization_id))
$function$;
REVOKE ALL ON FUNCTION public.website_post_admin_organization() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.website_post_admin_organization() TO authenticated;

CREATE POLICY website_posts_admin_read ON public.website_posts FOR SELECT TO authenticated
  USING (provider_organization_id = (SELECT public.website_post_admin_organization()));

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('website-post-images', 'website-post-images', false, 5242880, ARRAY['image/jpeg']);

CREATE POLICY website_post_images_admin_insert ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'website-post-images'
  AND name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$'
  AND (storage.foldername(name))[1] = (SELECT public.website_post_admin_organization())::text
  AND EXISTS (
    SELECT 1 FROM public.website_posts p
    WHERE p.id::text = (storage.foldername(name))[2]
      AND p.provider_organization_id = (SELECT public.website_post_admin_organization())
  )
);
CREATE POLICY website_post_images_admin_read ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'website-post-images'
  AND (storage.foldername(name))[1] = (SELECT public.website_post_admin_organization())::text
);

-- Existing permissive Storage policies must not expose drafts or permit replacing a published asset.
CREATE POLICY website_post_images_anon_guard ON storage.objects AS RESTRICTIVE FOR ALL TO anon
  USING (bucket_id <> 'website-post-images') WITH CHECK (bucket_id <> 'website-post-images');
CREATE POLICY website_post_images_auth_guard ON storage.objects AS RESTRICTIVE FOR ALL TO authenticated
  USING (bucket_id <> 'website-post-images' OR (storage.foldername(name))[1] = (SELECT public.website_post_admin_organization())::text)
  WITH CHECK (bucket_id <> 'website-post-images' OR (storage.foldername(name))[1] = (SELECT public.website_post_admin_organization())::text);
CREATE POLICY website_post_images_no_replace ON storage.objects AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (bucket_id <> 'website-post-images') WITH CHECK (bucket_id <> 'website-post-images');
CREATE POLICY website_post_images_no_delete ON storage.objects AS RESTRICTIVE FOR DELETE TO authenticated
  USING (bucket_id <> 'website-post-images');

CREATE FUNCTION public.list_website_posts()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = ''
AS $function$
DECLARE v_provider uuid := public.website_post_admin_organization();
BEGIN
  IF v_provider IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'website_posts_access_denied';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(to_jsonb(p) - 'last_request_payload' - 'last_request_id' ORDER BY p.updated_at DESC, p.id)
    FROM (
      SELECT * FROM public.website_posts WHERE provider_organization_id = v_provider
      ORDER BY updated_at DESC, id LIMIT 100
    ) p
  ), '[]'::jsonb);
END
$function$;
REVOKE ALL ON FUNCTION public.list_website_posts() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_website_posts() TO authenticated;

CREATE FUNCTION public.manage_website_post(
  p_post_id uuid, p_expected_version integer, p_request_id uuid, p_action text,
  p_title text, p_summary text, p_body text, p_photo_path text, p_photo_alt text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_provider uuid := public.website_post_admin_organization();
  v_post public.website_posts%ROWTYPE;
  v_payload jsonb;
  v_title text := btrim(coalesce(p_title, ''));
  v_summary text := btrim(coalesce(p_summary, ''));
  v_body text := btrim(coalesce(p_body, ''));
  v_photo text := nullif(btrim(coalesce(p_photo_path, '')), '');
  v_alt text := btrim(coalesce(p_photo_alt, ''));
BEGIN
  IF v_provider IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'website_posts_access_denied';
  END IF;
  IF p_post_id IS NULL OR p_request_id IS NULL OR p_expected_version IS NULL OR p_expected_version < 0
     OR p_action IS NULL OR p_action NOT IN ('save', 'publish', 'unpublish')
     OR char_length(v_title) NOT BETWEEN 1 AND 160 OR char_length(v_summary) > 300
     OR char_length(v_body) > 20000 OR char_length(v_alt) > 240 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'website_post_invalid:fields';
  END IF;
  v_payload := jsonb_build_object(
    'actor', auth.uid(), 'version', p_expected_version, 'action', p_action,
    'title', v_title, 'summary', v_summary, 'body', v_body, 'photo', v_photo, 'alt', v_alt
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('website-post:' || p_post_id::text, 0));
  SELECT * INTO v_post FROM public.website_posts WHERE id = p_post_id FOR UPDATE;
  IF FOUND AND v_post.provider_organization_id <> v_provider THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'website_posts_access_denied';
  END IF;
  IF v_post.last_request_id = p_request_id THEN
    IF v_post.last_request_payload <> v_payload THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'website_post_invalid:request_reuse';
    END IF;
    RETURN to_jsonb(v_post) - 'last_request_payload' - 'last_request_id';
  END IF;
  IF coalesce(v_post.version, 0) <> p_expected_version THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'website_post_conflict:reload_before_saving';
  END IF;
  IF p_action = 'unpublish' AND v_post.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'website_post_invalid:not_published';
  END IF;
  IF v_photo IS NOT NULL AND (
    v_photo !~ ('^' || v_provider::text || '/' || p_post_id::text || '/[0-9a-f-]{36}\.jpg$')
    OR NOT EXISTS (
      SELECT 1 FROM storage.objects o
      WHERE o.bucket_id = 'website-post-images' AND o.name = v_photo
        AND o.metadata->>'mimetype' = 'image/jpeg'
        AND (o.metadata->>'size')::bigint BETWEEN 1 AND 5242880
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'website_post_invalid:photo';
  END IF;
  IF p_action = 'publish' AND (v_body = '' OR (v_photo IS NOT NULL AND v_alt = '')) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'website_post_invalid:publish_content';
  END IF;
  IF p_action = 'publish' AND replace(v_title || ' ' || v_summary || ' ' || v_body || ' ' || v_alt, '$10 million', ' ')
    ~* '[$][[:space:]]?[0-9]|\mper hour\M|\mhourly rate\M|\m(incl?|excl?)\.?[[:space:]]*GST\M|\mdiscount\M' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'website_post_invalid:pricing_not_permitted';
  END IF;
  IF v_post.id IS NULL THEN
    INSERT INTO public.website_posts (
      id, provider_organization_id, slug, title, created_by, updated_by, last_request_id, last_request_payload
    ) VALUES (
      p_post_id, v_provider,
      left(coalesce(nullif(trim(both '-' FROM regexp_replace(lower(v_title), '[^a-z0-9]+', '-', 'g')), ''), 'update'), 90) || '-' || p_post_id::text,
      v_title, auth.uid(), auth.uid(), p_request_id, v_payload
    ) RETURNING * INTO v_post;
    v_post.version := 0;
  END IF;
  UPDATE public.website_posts SET
    title = v_title, summary = v_summary, body = v_body, photo_path = v_photo, photo_alt = v_alt,
    published_content = CASE
      WHEN p_action = 'unpublish' THEN NULL
      WHEN p_action = 'publish' THEN jsonb_build_object(
        'id', id, 'slug', slug, 'title', v_title,
        'summary', coalesce(nullif(v_summary, ''), left(v_body, 220)),
        'body', v_body, 'photo_path', v_photo, 'photo_alt', v_alt,
        'published_at', coalesce(published_content->'published_at', to_jsonb(now())),
        'updated_at', now(), 'version', v_post.version + 1
      )
      ELSE published_content END,
    version = v_post.version + 1, updated_by = auth.uid(), updated_at = now(),
    last_request_id = p_request_id, last_request_payload = v_payload
  WHERE id = p_post_id RETURNING * INTO v_post;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_provider, auth.uid(), 'website_post_' || p_action, 'website_posts', p_post_id,
    jsonb_build_object('request_id', p_request_id, 'version', v_post.version, 'published', v_post.published_content IS NOT NULL));
  RETURN to_jsonb(v_post) - 'last_request_payload' - 'last_request_id';
END
$function$;
REVOKE ALL ON FUNCTION public.manage_website_post(uuid, integer, uuid, text, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.manage_website_post(uuid, integer, uuid, text, text, text, text, text, text)
  TO authenticated;

CREATE FUNCTION public.read_published_website_posts(p_slug text DEFAULT NULL, p_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
  SELECT coalesce(jsonb_agg(p.published_content ORDER BY p.published_content->>'published_at' DESC, p.id), '[]'::jsonb)
  FROM (
    SELECT w.id, w.published_content FROM public.website_posts w
    JOIN private.platform_tenancy t ON t.singleton AND t.service_provider_organization_id = w.provider_organization_id
    WHERE w.published_content IS NOT NULL
      AND (p_slug IS NULL OR w.slug = p_slug) AND (p_id IS NULL OR w.id = p_id)
    ORDER BY w.published_content->>'published_at' DESC, w.id LIMIT 100
  ) p
$function$;
COMMENT ON FUNCTION public.read_published_website_posts(text, uuid) IS
  'Server-only read for website-news. Returns published snapshots only; never returns draft text, actor IDs, retry payloads or unpublished images.';
REVOKE ALL ON FUNCTION public.read_published_website_posts(text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.read_published_website_posts(text, uuid) TO service_role;