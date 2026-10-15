DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'notice_templates_body_safe_html_check'
      AND conrelid = 'public.notice_templates'::regclass
  ) THEN
    ALTER TABLE public.notice_templates
      ADD CONSTRAINT notice_templates_body_safe_html_check
      CHECK (
        body_html !~* '<[[:space:]]*(script|iframe|object|embed)([[:space:]>]|$)'
        AND body_html !~* 'javascript[[:space:]]*:'
        AND body_html !~* '[[:space:]]on[a-z]+[[:space:]]*='
      )
      NOT VALID;
  END IF;
END
$$;

ALTER TABLE public.notice_templates
  VALIDATE CONSTRAINT notice_templates_body_safe_html_check;