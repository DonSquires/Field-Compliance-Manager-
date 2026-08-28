create or replace function public.sync_bob_self_memory_content()
  returns trigger
  language plpgsql
  AS $function$
BEGIN
  IF NEW.memory_text IS NULL AND NEW.content IS NOT NULL THEN
    NEW.memory_text := NEW.content;
  ELSIF NEW.content IS NULL AND NEW.memory_text IS NOT NULL THEN
    NEW.content := NEW.memory_text;
  ELSIF NEW.content IS NOT NULL AND NEW.memory_text IS NOT NULL AND NEW.content <> NEW.memory_text THEN
    NEW.memory_text := NEW.content;
  END IF;
  RETURN NEW;
END;
$function$;

grant execute on function "public"."sync_bob_self_memory_content"() to public, "anon", "authenticated", "postgres", "service_role";
