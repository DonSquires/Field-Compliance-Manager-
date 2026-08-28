create or replace function public.sync_invitation_status()
  returns trigger
  language plpgsql
  AS $function$
BEGIN
  -- Only sync if the invite is linked to an agreement
  IF NEW.service_agreement_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Never overwrite 'accepted' (acceptance is permanent)
  IF (SELECT invitation_status FROM public.service_agreements
      WHERE id = NEW.service_agreement_id) = 'accepted' THEN
    RETURN NEW;
  END IF;

  -- On INSERT of a pending invite: set agreement to 'invited'
  IF TG_OP = 'INSERT' AND NEW.status = 'pending' THEN
    UPDATE public.service_agreements
    SET invitation_status = 'invited'
    WHERE id = NEW.service_agreement_id;
    RETURN NEW;
  END IF;

  -- On status change FROM pending: derive the new agreement status
  IF TG_OP = 'UPDATE' AND OLD.status = 'pending' AND NEW.status != 'pending' THEN
    UPDATE public.service_agreements
    SET invitation_status = CASE NEW.status
      WHEN 'accepted' THEN 'accepted'
      WHEN 'declined' THEN 'declined'
      WHEN 'revoked' THEN 'not_invited'
      WHEN 'expired' THEN 'expired'
    END
    WHERE id = NEW.service_agreement_id;
    RETURN NEW;
  END IF;

  -- All other changes: no-op (historical invites don't affect the agreement)
  RETURN NEW;
END;
$function$;

grant execute on function "public"."sync_invitation_status"() to public, "anon", "authenticated", "postgres", "service_role";
