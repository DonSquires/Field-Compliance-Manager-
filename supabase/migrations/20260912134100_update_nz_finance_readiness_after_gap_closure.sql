UPDATE public.bob_nz_finance_readiness_checks
SET status = 'partial', score = 45,
    evidence = 'A source-verified provisional-tax scenario plan now records the assumed taxable profit, rate, method, and estimated amount. It is not an IRD calculation or payment instruction.',
    bob_can_do = 'Prepare a transparent scenario, show assumptions, and prepare questions for the accountant.',
    human_or_provider_needed = 'An accountant or tax agent must confirm the liability, method, dates, and payment instruction.',
    measured_at = now()
WHERE source_key = 'ird-provisional-tax';

UPDATE public.bob_nz_finance_readiness_checks
SET status = 'partial', score = 40,
    evidence = 'Approved timesheets can be packaged for an approved NZ payroll provider, with resolved and unresolved rate counts. Direct IRD payday-file submission, response, and correction workflows are not implemented.',
    bob_can_do = 'Prepare and explain a payroll-provider handoff package and flag unresolved rate inputs.',
    human_or_provider_needed = 'An approved payroll system/provider must generate, review, submit, and correct payday files.',
    measured_at = now()
WHERE source_key = 'ird-payroll';
