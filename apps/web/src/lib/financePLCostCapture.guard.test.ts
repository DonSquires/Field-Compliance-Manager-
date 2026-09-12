import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260912120000_finance_pl_periods_and_cost_capture.sql'), 'utf8');

describe('finance P&L periods and cost capture', () => {
  it('models periods, service costs, snapshots, and variance', () => {
    for (const table of ['finance_pl_periods', 'finance_service_costs', 'finance_pl_snapshots', 'finance_cost_variance']) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`);
    }
    expect(migration).toContain("status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','locked','closed','archived'))");
    expect(migration).toContain("cost_type text NOT NULL CHECK (cost_type IN ('labour','vehicle','materials','equipment','overhead','depreciation','other'))");
    expect(migration).toContain('service_agreement_id uuid NOT NULL REFERENCES public.service_agreements');
  });

  it('captures costs from timesheets, assets, inventory, and depreciation', () => {
    expect(migration).toContain("source_document_type text NOT NULL CHECK (source_document_type IN ('timesheet','asset_check','inventory_transaction','asset_maintenance','depreciation_schedule','estimate','manual'))");
    expect(migration).toContain('dispatch_job_id uuid');
    expect(migration).toContain('investigation_id uuid');
    expect(migration).toContain('total_labour');
    expect(migration).toContain('total_depreciation');
  });

  it('governs period closing and cost recording as service-only operations', () => {
    expect(migration).toContain('close_finance_pl_period(p_pl_period_id uuid)');
    expect(migration).toContain('record_finance_service_cost');
    expect(migration).toContain('Cannot record costs in a closed P&L period');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.close_finance_pl_period');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.record_finance_service_cost');
    expect(migration).toContain('public.org_access_allowed(organization_id)');
  });
});
