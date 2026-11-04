-- The invoker report-pack trigger evaluates this helper during service-role
-- updates, even when there is no user subject. Existing public/anon revokes stay.
GRANT EXECUTE ON FUNCTION public.is_report_provider_custodian_for_org(uuid) TO service_role;