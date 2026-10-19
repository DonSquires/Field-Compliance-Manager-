-- Permissive SELECT policies are ORed by PostgreSQL, which may evaluate the
-- costly task-basis policy first. Explicit CASE prevents that evaluation when
-- an existing custody/client/Bob policy already grants this same observation.
-- A OR B OR C OR D = A OR B OR C OR CASE WHEN A OR B OR C THEN true ELSE D END.
ALTER POLICY observations_task_entitlement_select ON public.observations
USING (
  CASE
    WHEN public.org_access_allowed(organization_id)
      OR public.org_access_allowed(client_org_id)
      OR (SELECT auth.uid()) = '00000000-0000-0000-0000-00000000b0b0'::uuid
    THEN true
    ELSE public.user_has_task_entitlement(auth.uid(), id)
  END
);

COMMENT ON POLICY observations_task_entitlement_select ON public.observations IS
  'Preserves the existing permissive observation read union; skips expensive task-basis resolution when custody, client access or Bob already permits the row. Otherwise the task-entitlement decision remains required.';
