CREATE OR REPLACE FUNCTION public.finance_service_cost_attribution_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agreement public.service_agreements%rowtype;
  v_period public.finance_pl_periods%rowtype;
  v_shift public.shifts%rowtype;
  v_work_unit public.roster_work_units%rowtype;
  v_linked_agreement_id uuid;
  v_work_unit_id uuid := NEW.work_unit_id;
BEGIN
  SELECT * INTO v_agreement
  FROM public.service_agreements
  WHERE id = NEW.service_agreement_id
    AND provider_organization_id = NEW.organization_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Service agreement is not owned by the finance organization'; END IF;
  IF NEW.client_organization_id IS DISTINCT FROM v_agreement.client_organization_id THEN
    RAISE EXCEPTION 'Finance cost client must match the selected service agreement';
  END IF;

  SELECT * INTO v_period
  FROM public.finance_pl_periods
  WHERE id = NEW.pl_period_id
    AND organization_id = NEW.organization_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'P&L period is not available in the finance organization'; END IF;
  IF v_period.status IN ('closed', 'archived') THEN
    RAISE EXCEPTION 'P&L period is unavailable for finance cost entry';
  END IF;
  IF nullif(trim(coalesce(NEW.source_reference, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Finance cost source reference is required';
  END IF;

  IF NEW.shift_id IS NOT NULL THEN
    SELECT * INTO v_shift
    FROM public.shifts
    WHERE id = NEW.shift_id
      AND organization_id = NEW.organization_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Shift is not available in the finance organization'; END IF;
    IF NEW.work_unit_id IS NOT NULL
      AND v_shift.work_unit_id IS NOT NULL
      AND NEW.work_unit_id IS DISTINCT FROM v_shift.work_unit_id THEN
      RAISE EXCEPTION 'Finance cost work unit must match the selected shift';
    END IF;
    v_work_unit_id := coalesce(v_work_unit_id, v_shift.work_unit_id);

    IF NEW.dispatch_job_id IS NULL THEN
      IF v_shift.service_agreement_location_id IS NOT NULL THEN
        SELECT service_agreement_id INTO v_linked_agreement_id
        FROM public.service_agreement_locations
        WHERE id = v_shift.service_agreement_location_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Shift location agreement could not be verified'; END IF;
        IF v_linked_agreement_id IS DISTINCT FROM NEW.service_agreement_id THEN
          RAISE EXCEPTION 'Finance cost agreement must match the shift location agreement';
        END IF;
      END IF;
      IF v_shift.service_agreement_module_id IS NOT NULL THEN
        SELECT service_agreement_id INTO v_linked_agreement_id
        FROM public.service_agreement_modules
        WHERE id = v_shift.service_agreement_module_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Shift module agreement could not be verified'; END IF;
        IF v_linked_agreement_id IS DISTINCT FROM NEW.service_agreement_id THEN
          RAISE EXCEPTION 'Finance cost agreement must match the shift module agreement';
        END IF;
      END IF;
    END IF;
  END IF;

  IF v_work_unit_id IS NOT NULL THEN
    SELECT * INTO v_work_unit
    FROM public.roster_work_units
    WHERE id = v_work_unit_id
      AND organization_id = NEW.organization_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Work unit is not available in the finance organization'; END IF;
    NEW.work_unit_id := v_work_unit_id;
    NEW.cost_centre_id := coalesce(NEW.cost_centre_id, v_work_unit.cost_centre_id);

    IF NEW.dispatch_job_id IS NULL THEN
      IF v_work_unit.service_agreement_location_id IS NOT NULL THEN
        SELECT service_agreement_id INTO v_linked_agreement_id
        FROM public.service_agreement_locations
        WHERE id = v_work_unit.service_agreement_location_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Work unit location agreement could not be verified'; END IF;
        IF v_linked_agreement_id IS DISTINCT FROM NEW.service_agreement_id THEN
          RAISE EXCEPTION 'Finance cost agreement must match the work unit location agreement';
        END IF;
      END IF;
      IF v_work_unit.service_agreement_module_id IS NOT NULL THEN
        SELECT service_agreement_id INTO v_linked_agreement_id
        FROM public.service_agreement_modules
        WHERE id = v_work_unit.service_agreement_module_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Work unit module agreement could not be verified'; END IF;
        IF v_linked_agreement_id IS DISTINCT FROM NEW.service_agreement_id THEN
          RAISE EXCEPTION 'Finance cost agreement must match the work unit module agreement';
        END IF;
      END IF;
    END IF;
  END IF;

  IF NEW.dispatch_job_id IS NOT NULL THEN
    SELECT service_agreement_id INTO v_linked_agreement_id
    FROM public.dispatch_jobs
    WHERE id = NEW.dispatch_job_id
      AND organization_id = NEW.organization_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Dispatch job is not available in the finance organization'; END IF;
    IF v_linked_agreement_id IS NOT NULL
      AND v_linked_agreement_id IS DISTINCT FROM NEW.service_agreement_id THEN
      RAISE EXCEPTION 'Finance cost agreement must match the dispatch job agreement';
    END IF;
  END IF;

  IF NEW.investigation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.investigations
    WHERE id = NEW.investigation_id
      AND organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Investigation is not available in the finance organization';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.finance_service_cost_attribution_guard() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS finance_service_costs_attribution_guard ON public.finance_service_costs;
CREATE TRIGGER finance_service_costs_attribution_guard
BEFORE INSERT OR UPDATE OF organization_id, pl_period_id, service_agreement_id, client_organization_id, work_unit_id, shift_id, dispatch_job_id, investigation_id, source_reference
ON public.finance_service_costs
FOR EACH ROW
EXECUTE FUNCTION public.finance_service_cost_attribution_guard();