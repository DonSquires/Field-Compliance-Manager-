-- Friction packets (runtime errors and people's change requests) are written only by the
-- bob-triage-report function, which redacts the envelope and decides routing. Until now the
-- insert/update policies let any organisation member write a packet straight through the REST
-- API (or rewrite their own packet's routing), including repair_risk='routine' +
-- automation_status='queued', which builder_claim_routine_repairs turns into an unattended
-- Builder job. Close direct writes; reviewers may change only the review columns.

ALTER TABLE public.bob_friction_packets
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS review_note text;

ALTER TABLE public.bob_friction_packets
  DROP CONSTRAINT IF EXISTS bob_friction_packets_review_note_length;
ALTER TABLE public.bob_friction_packets
  ADD CONSTRAINT bob_friction_packets_review_note_length CHECK (review_note IS NULL OR char_length(review_note) <= 1000);

COMMENT ON COLUMN public.bob_friction_packets.reviewed_by IS 'Who last changed the review disposition (stamped by trigger, not client-supplied).';
COMMENT ON COLUMN public.bob_friction_packets.reviewed_at IS 'When the review disposition last changed (stamped by trigger).';
COMMENT ON COLUMN public.bob_friction_packets.review_note IS 'Reviewer note for the disposition; the evidence envelope itself stays immutable.';

CREATE OR REPLACE FUNCTION public.bob_friction_packets_stamp_review()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if NEW.disposition is distinct from OLD.disposition or NEW.review_note is distinct from OLD.review_note then
    NEW.reviewed_by := auth.uid();
    NEW.reviewed_at := now();
  elsif auth.role() <> 'service_role' then
    NEW.reviewed_by := OLD.reviewed_by;
    NEW.reviewed_at := OLD.reviewed_at;
  end if;
  return NEW;
end;
$function$;
REVOKE ALL ON FUNCTION public.bob_friction_packets_stamp_review() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_bob_friction_packets_stamp_review ON public.bob_friction_packets;
CREATE TRIGGER trg_bob_friction_packets_stamp_review
  BEFORE UPDATE ON public.bob_friction_packets
  FOR EACH ROW EXECUTE FUNCTION public.bob_friction_packets_stamp_review();

DROP POLICY IF EXISTS bob_friction_packets_insert ON public.bob_friction_packets;
DROP POLICY IF EXISTS bob_friction_packets_update ON public.bob_friction_packets;
CREATE POLICY bob_friction_packets_review_update ON public.bob_friction_packets
  FOR UPDATE TO authenticated
  USING (org_access_allowed(organization_id) AND (is_grand_master() OR is_admin_for_org(organization_id)))
  WITH CHECK (org_access_allowed(organization_id) AND (is_grand_master() OR is_admin_for_org(organization_id)));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES, MAINTAIN ON public.bob_friction_packets FROM anon, authenticated;
REVOKE SELECT ON public.bob_friction_packets FROM anon;
GRANT UPDATE (disposition, review_note) ON public.bob_friction_packets TO authenticated;

ALTER TABLE public.bob_friction_packets ADD CONSTRAINT bob_user_reports_require_review
  CHECK (envelope #> '{during,user_report}' IS NULL OR repair_risk IN ('significant', 'protected'));
