UPDATE public.bob_nz_finance_sources
SET status = 'verify_before_relying', last_verified_on = NULL, review_due_on = NULL, updated_at = now()
WHERE status = 'verify_before_relying';
