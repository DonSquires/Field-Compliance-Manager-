-- Excessive noise direction particulars (RMA 1991 s327(2), s327(3), s328(5)).
-- Design: docs/canon/NOISE_CONTROL_TWO_PLACE_MODEL.md. Additive: one governed
-- command writing columns 20260914110000 created; no policy or writer changed.
--
--   s327(2): the direction may be given in writing or orally  -> end_given_orally
--   s327(3): binds for 8 days OR SUCH SHORTER PERIOD as the officer specifies
--            -> end_expires_at recomputed within the council rule (<= 192 h)
--   s328(4)-(5): entry where no occupier can be identified requires a copy of
--            the written direction and an entry notice left in a prominent
--            position -> end_recipient_role = 'unoccupied_notice_left' demands
--            entry_notice_left = true

CREATE OR REPLACE FUNCTION public.record_noise_direction_particulars(
  p_client_request_id uuid,
  p_assessment_id uuid,
  p_given_orally boolean,
  p_recipient_role text,
  p_period_hours smallint DEFAULT NULL,
  p_entry_notice_left boolean DEFAULT NULL
) RETURNS TABLE(assessment_id uuid, end_given_orally boolean, end_recipient_role text, end_expires_at timestamp with time zone, entry_notice_left boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid;
  v_assessment public.noise_assessments%rowtype;
  v_receipt public.officer_command_requests%rowtype;
  v_cap smallint := 192;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  IF p_recipient_role NOT IN ('occupier', 'responsible_person', 'unoccupied_notice_left') THEN
    RAISE EXCEPTION 'recipient_role must be occupier, responsible_person or unoccupied_notice_left';
  END IF;
  SELECT p.organization_id INTO v_org FROM public.user_profiles p
  WHERE p.id = v_user AND p.deactivated_at IS NULL AND p.role IN ('officer', 'admin_officer', 'admin', 'master', 'grand_master');
  IF v_org IS NULL THEN RAISE EXCEPTION 'Active officer profile required'; END IF;

  SELECT * INTO v_receipt FROM public.officer_command_requests r WHERE r.request_id = p_client_request_id::text;
  IF FOUND AND v_receipt.actor_user_id IS DISTINCT FROM v_user THEN RAISE EXCEPTION 'client_request_id belongs to another actor'; END IF;
  IF FOUND AND v_receipt.command_status = 'completed' THEN
    RETURN QUERY SELECT (v_receipt.response->>'assessment_id')::uuid, (v_receipt.response->>'end_given_orally')::boolean,
      v_receipt.response->>'end_recipient_role', (v_receipt.response->>'end_expires_at')::timestamptz, (v_receipt.response->>'entry_notice_left')::boolean;
    RETURN;
  END IF;

  SELECT * INTO v_assessment FROM public.noise_assessments na WHERE na.id = p_assessment_id AND na.organization_id = v_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'Noise assessment not found in the officer organisation'; END IF;
  IF NOT (v_assessment.officer_user_id = v_user OR public.is_admin_for_org(v_org)) THEN
    RAISE EXCEPTION 'Only the assessing officer may record direction particulars';
  END IF;
  IF v_assessment.action_taken NOT IN ('direction_notice', 'equipment_seized') THEN
    RAISE EXCEPTION 'Direction particulars apply to an excessive noise direction or a seizure under it';
  END IF;
  -- s328(5): an unoccupied entry must leave the written direction and the entry notice.
  IF p_recipient_role = 'unoccupied_notice_left' AND NOT coalesce(p_entry_notice_left, false) THEN
    RAISE EXCEPTION 'Entry where no occupier can be identified requires the written direction and entry notice to be left (RMA s328(5))';
  END IF;
  IF p_recipient_role = 'unoccupied_notice_left' AND coalesce(p_given_orally, false) THEN
    RAISE EXCEPTION 'A direction left at an unoccupied place must be written (RMA s328(5)(a))';
  END IF;

  -- s327(3): the officer may specify a shorter period; never longer than the council rule, which is capped at the statute.
  SELECT n.end_validity_hours INTO v_cap FROM public.noise_module_config n
  WHERE n.organization_id = v_org AND n.is_current AND n.effective_from <= current_date AND (n.effective_to IS NULL OR n.effective_to >= current_date)
  ORDER BY n.effective_from DESC, n.version DESC LIMIT 1;
  IF v_cap IS NULL THEN v_cap := 192; END IF;
  IF p_period_hours IS NOT NULL AND (p_period_hours < 1 OR p_period_hours > v_cap) THEN
    RAISE EXCEPTION 'Direction period must be between 1 and % hours (RMA s327(3); council rule)', v_cap;
  END IF;

  UPDATE public.noise_assessments
  SET end_given_orally = p_given_orally,
      end_recipient_role = p_recipient_role,
      entry_notice_left = COALESCE(p_entry_notice_left, noise_assessments.entry_notice_left),
      end_expires_at = CASE
        WHEN p_period_hours IS NOT NULL THEN noise_assessments.assessed_at + make_interval(hours => p_period_hours)
        ELSE COALESCE(noise_assessments.end_expires_at, noise_assessments.assessed_at + make_interval(hours => v_cap))
      END
  WHERE id = v_assessment.id
  RETURNING * INTO v_assessment;

  INSERT INTO public.officer_command_requests (request_id, organization_id, actor_user_id, shift_id, site_id, command_type, command_status, response)
  VALUES (p_client_request_id::text, v_org, v_user, v_assessment.shift_id, v_assessment.site_id, 'record_noise_direction_particulars', 'completed',
    jsonb_build_object('assessment_id', v_assessment.id, 'end_given_orally', v_assessment.end_given_orally, 'end_recipient_role', v_assessment.end_recipient_role,
      'end_expires_at', v_assessment.end_expires_at, 'entry_notice_left', v_assessment.entry_notice_left))
  ON CONFLICT (request_id) DO UPDATE SET command_status = 'completed', response = EXCLUDED.response;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_org, v_user, 'noise_direction_particulars_recorded', 'noise_assessments', v_assessment.id,
    jsonb_build_object('client_request_id', p_client_request_id, 'end_given_orally', v_assessment.end_given_orally,
      'end_recipient_role', v_assessment.end_recipient_role, 'period_hours', p_period_hours, 'end_expires_at', v_assessment.end_expires_at,
      'entry_notice_left', v_assessment.entry_notice_left));

  RETURN QUERY SELECT v_assessment.id, v_assessment.end_given_orally, v_assessment.end_recipient_role, v_assessment.end_expires_at, v_assessment.entry_notice_left;
END;
$$;
REVOKE ALL ON FUNCTION public.record_noise_direction_particulars(uuid, uuid, boolean, text, smallint, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_noise_direction_particulars(uuid, uuid, boolean, text, smallint, boolean) TO authenticated, service_role;
COMMENT ON FUNCTION public.record_noise_direction_particulars(uuid, uuid, boolean, text, smallint, boolean) IS
  'Records how an excessive noise direction was given (oral/written, recipient), an officer-specified shorter period within the council rule (RMA s327(3)), and the s328(5) entry notice for an unoccupied place. Officer-owned, idempotent by client_request_id, audited.';
