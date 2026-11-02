-- Notifications are created by server code only.
--
-- enqueue_notification is SECURITY DEFINER and inserts into notifications
-- without checking who is calling. EXECUTE was granted to PUBLIC, anon and
-- authenticated, so anyone holding the public anon key could send any user or
-- role in any organisation a notification with any title, body and link,
-- bypassing the notifications_insert policy (organisation admins only).
--
-- Every legitimate caller already runs with more rights than the client:
-- - 38 SQL functions and triggers, all SECURITY DEFINER, so they execute it as
--   their owner;
-- - the bob-chat-bell-notify, notify-credential-expiry and
--   welfare-escalation-tick edge functions, through the service role.
-- No web or mobile code calls it. Atlas lists the same callers.
--
-- The guards fail the migration, leaving the grants unchanged, if a function
-- that calls enqueue_notification runs with the caller's rights, or if a
-- definer caller's owner would lose EXECUTE. The release lane sends the file as
-- one query, so Postgres applies it as a single implicit transaction.

DO $guard$
DECLARE
  v_fn regprocedure := 'public.enqueue_notification(uuid, text, text, text, text, uuid, text, text, jsonb, text)'::regprocedure;
  v_invoker text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO v_invoker
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND NOT p.prosecdef
     AND p.prosrc ~ '\menqueue_notification\s*\('
     AND p.oid <> v_fn;
  IF v_invoker IS NOT NULL THEN
    RAISE EXCEPTION 'enqueue_notification has caller-rights callers that would break: %', v_invoker;
  END IF;
END
$guard$;

REVOKE ALL ON FUNCTION public.enqueue_notification(uuid, text, text, text, text, uuid, text, text, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_notification(uuid, text, text, text, text, uuid, text, text, jsonb, text)
  TO service_role;

COMMENT ON FUNCTION public.enqueue_notification(uuid, text, text, text, text, uuid, text, text, jsonb, text) IS
  'Layer 4.4 single write path for notifications. Idempotent on (organization_id, dedup_key). Server only: SECURITY DEFINER functions and triggers, and edge functions with the service role. Clients cannot execute it.';

DO $verify$
DECLARE
  v_fn regprocedure := 'public.enqueue_notification(uuid, text, text, text, text, uuid, text, text, jsonb, text)'::regprocedure;
  v_blocked text;
BEGIN
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'enqueue_notification is still executable by a client role';
  END IF;
  IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot execute enqueue_notification';
  END IF;
  SELECT string_agg(p.oid::regprocedure::text || ' (owner ' || p.proowner::regrole::text || ')', ', ')
    INTO v_blocked
    FROM pg_proc p
   WHERE p.prosecdef
     AND p.prosrc ~ '\menqueue_notification\s*\('
     AND p.oid <> v_fn
     AND NOT has_function_privilege(p.proowner, v_fn, 'EXECUTE');
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION 'these definer callers would lose enqueue_notification: %', v_blocked;
  END IF;
END
$verify$;
