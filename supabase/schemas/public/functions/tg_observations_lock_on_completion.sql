create or replace function public.tg_observations_lock_on_completion()
  returns trigger
  language plpgsql
  AS $function$
begin
  -- Transition-based: only fire when photo_captured_at goes NULL -> NOT NULL.
  -- Never fires if photo_captured_at was already set, or if it stays null.
  if (old.photo_captured_at is null and new.photo_captured_at is not null) then
    -- Write-once: only set locked_at if not already set (idempotent).
    if new.locked_at is null then
      new.locked_at := now();
    end if;
  end if;
  return new;
end;
$function$;

grant execute on function "public"."tg_observations_lock_on_completion"() to public, "anon", "authenticated", "postgres", "service_role";
