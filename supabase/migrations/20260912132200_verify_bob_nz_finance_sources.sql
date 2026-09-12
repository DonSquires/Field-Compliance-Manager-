UPDATE public.bob_nz_finance_sources
SET source_url = 'https://www.ird.govt.nz/managing-my-tax/record-keeping',
    status = 'active', last_verified_on = DATE '2026-09-12', review_due_on = DATE '2026-10-12', updated_at = now()
WHERE source_key = 'ird-gst-records';

UPDATE public.bob_nz_finance_sources
SET source_url = 'https://www.ird.govt.nz/income-tax/provisional-tax',
    status = 'active', last_verified_on = DATE '2026-09-12', review_due_on = DATE '2026-10-12', updated_at = now()
WHERE source_key = 'ird-provisional-tax';

UPDATE public.bob_nz_finance_sources
SET status = 'active', last_verified_on = DATE '2026-09-12', review_due_on = CASE WHEN topic = 'accounting_standards' THEN DATE '2026-12-11' ELSE DATE '2026-10-12' END, updated_at = now()
WHERE source_key IN ('ird-gst-overview', 'ird-employers', 'xrb-nz-accounting-standards', 'ird-payroll');
