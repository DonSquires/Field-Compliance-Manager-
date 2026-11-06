CREATE TABLE IF NOT EXISTS public.staff_employee_number_counters (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  last_number bigint NOT NULL DEFAULT 0 CHECK (last_number >= 0)
);

ALTER TABLE public.staff_employee_number_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_employee_number_counters FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO public.staff_employee_number_counters (organization_id, last_number)
SELECT
  staff.organization_id,
  COALESCE(MAX((regexp_match(btrim(staff.employee_number), '^EMP-([0-9]+)$'))[1]::bigint), 0)
FROM public.staff_profiles staff
WHERE staff.organization_id IS NOT NULL
GROUP BY staff.organization_id
ON CONFLICT (organization_id) DO UPDATE
SET last_number = GREATEST(
  public.staff_employee_number_counters.last_number,
  EXCLUDED.last_number
);

CREATE OR REPLACE FUNCTION public.next_staff_employee_number(p_organization_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_number bigint;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'Staff organisation is required to assign an employee number';
  END IF;

  INSERT INTO public.staff_employee_number_counters (organization_id, last_number)
  VALUES (p_organization_id, 1)
  ON CONFLICT (organization_id) DO UPDATE
  SET last_number = public.staff_employee_number_counters.last_number + 1
  RETURNING last_number INTO v_number;

  RETURN 'EMP-' || lpad(v_number::text, GREATEST(6, length(v_number::text)), '0');
END;
$$;

REVOKE ALL ON FUNCTION public.next_staff_employee_number(uuid) FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE
  v_staff record;
  v_number text;
BEGIN
  FOR v_staff IN
    SELECT staff.id, staff.organization_id
    FROM public.staff_profiles staff
    WHERE nullif(btrim(staff.employee_number), '') IS NULL
    ORDER BY staff.organization_id, staff.id
  LOOP
    v_number := public.next_staff_employee_number(v_staff.organization_id);
    UPDATE public.staff_profiles
    SET employee_number = v_number
    WHERE id = v_staff.id;
    INSERT INTO public.audit_log (
      organization_id, actor_user_id, action, target_table, target_id, metadata
    ) VALUES (
      v_staff.organization_id,
      NULL,
      'staff_employee_number_backfilled',
      'staff_profiles',
      v_staff.id,
      jsonb_build_object('employee_number', v_number, 'assignment_source', 'organisation_counter')
    );
  END LOOP;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS staff_profiles_organization_employee_number_uidx
  ON public.staff_profiles (organization_id, employee_number)
  WHERE nullif(btrim(employee_number), '') IS NOT NULL;

CREATE OR REPLACE FUNCTION public.tg_assign_staff_employee_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_existing_suffix bigint;
BEGIN
  IF nullif(btrim(NEW.employee_number), '') IS NULL THEN
    NEW.employee_number := public.next_staff_employee_number(NEW.organization_id);
    INSERT INTO public.audit_log (
      organization_id, actor_user_id, action, target_table, target_id, metadata
    ) VALUES (
      NEW.organization_id,
      auth.uid(),
      'staff_employee_number_assigned',
      'staff_profiles',
      NEW.id,
      jsonb_build_object('employee_number', NEW.employee_number, 'assignment_source', 'organisation_counter')
    );
  ELSE
    v_existing_suffix := (regexp_match(btrim(NEW.employee_number), '^EMP-([0-9]+)$'))[1]::bigint;
    IF v_existing_suffix IS NOT NULL THEN
      INSERT INTO public.staff_employee_number_counters (organization_id, last_number)
      VALUES (NEW.organization_id, v_existing_suffix)
      ON CONFLICT (organization_id) DO UPDATE
      SET last_number = GREATEST(
        public.staff_employee_number_counters.last_number,
        EXCLUDED.last_number
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.tg_assign_staff_employee_number() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_assign_staff_employee_number ON public.staff_profiles;
CREATE TRIGGER trg_assign_staff_employee_number
BEFORE INSERT OR UPDATE OF employee_number, organization_id
ON public.staff_profiles
FOR EACH ROW
EXECUTE FUNCTION public.tg_assign_staff_employee_number();

COMMENT ON COLUMN public.staff_profiles.employee_number IS
  'Organisation-unique staff identifier. Blank values are assigned as EMP-###### at profile creation; existing identifiers are preserved.';
