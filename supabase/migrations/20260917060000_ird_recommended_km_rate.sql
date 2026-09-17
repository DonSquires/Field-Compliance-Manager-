-- 20260917060000_ird_recommended_km_rate.sql
-- The default patrol-vehicle per-km charge is the IRD recommended Tier 1 petrol
-- kilometre rate used for business travel. Keep the amount in the price book
-- editable; the name makes the source and default clear to finance users.

UPDATE public.rate_rules
SET name = 'IRD recommended vehicle kilometre rate (Tier 1 petrol, default)',
    amount = 1.04,
    rate_type = 'per_km',
    service_type = NULL,
    job_type = NULL,
    effective_from = DATE '2025-04-01',
    updated_at = now()
WHERE organization_id = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid
  AND client_request_id = 'c0a80f5e-9e4b-4b6f-8d2e-202609151412'::uuid;

COMMENT ON COLUMN public.rate_rules.amount IS 'Rate amount in the rule unit. For the R&M default patrol travel rule, 1.04 NZD/km is the IRD recommended Tier 1 petrol kilometre rate effective 2025-04-01.';
