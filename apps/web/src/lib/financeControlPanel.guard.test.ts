import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const component = readFileSync(resolve(process.cwd(), 'src/components/FinanceControlPanel.tsx'), 'utf8');
const page = readFileSync(resolve(process.cwd(), 'src/pages/FinanceMoneyPage.tsx'), 'utf8');
const attributionMigration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20261009120000_guard_finance_cost_attribution.sql'), 'utf8');

describe('Finance control centre', () => {
  it('uses tenant-scoped reads and governed internal finance RPCs', () => {
    expect(component).toContain("from('finance_pl_periods')");
    expect(component).toContain("from('finance_tax_periods')");
    expect(component).toContain("from('service_agreements')");
    expect(component).toContain("from('shifts')");
    expect(component).toContain('p_shift_id: selectedShiftId || null');
    expect(component).toContain("['accepted', 'in_progress']");
    expect(component).toContain('labourNeedsShift');
    expect(component).toContain("Choose the officer's shift before saving a wage cost.");
    expect(component).toContain("from('service_agreement_locations')");
    expect(component).toContain("from('service_agreement_modules')");
    expect(component).toContain("const nextAgreementId = selectedShiftAgreementId ?? ''");
    expect(component).toContain('setAgreementId(nextAgreementId)');
    expect(component).toContain('p_work_unit_id: selectedShift?.work_unit_id ?? null');
    expect(component).toContain("setSourceReference('')");
    expect(component).toContain('if (!sourceReference.trim())');
    expect(component).not.toContain('E2E browser finance control');
    expect(component).not.toContain("|| 'Browser finance control'");
    expect(component).toContain('Select the customer agreement linked to this shift');
    expect(component).toContain("supabase.rpc('record_finance_service_cost'");
    expect(component).toContain("supabase.rpc('create_finance_pl_period'");
    expect(component).toContain("supabase.rpc('create_finance_tax_period'");
    expect(component).toContain("supabase.rpc('prepare_finance_tax_period'");
    expect(component).toContain("supabase.rpc('close_finance_pl_period'");
  });

  it('keeps bank and IRD external linking outside the control centre', () => {
    expect(component).toContain('Nothing here touches your bank or IRD');
    expect(page).toMatch(/\(\['cost', 'tax', 'close', 'periods'\] as Workflow\[\]\)\.includes\(workflow\) && <FinanceControlPanel key=\{workflow\} mode=/);
  });

  it('guards agreement, shift, work-unit, dispatch, investigation, period, and source attribution at the cost table', () => {
    expect(attributionMigration).toContain('CREATE OR REPLACE FUNCTION public.finance_service_cost_attribution_guard()');
    expect(attributionMigration).toContain('CREATE TRIGGER finance_service_costs_attribution_guard');
    expect(attributionMigration).toContain('v_shift.service_agreement_location_id');
    expect(attributionMigration).toContain('v_shift.service_agreement_module_id');
    expect(attributionMigration).toContain('v_work_unit.service_agreement_location_id');
    expect(attributionMigration).toContain('v_work_unit.service_agreement_module_id');
    expect(attributionMigration).toContain('v_linked_agreement_id IS DISTINCT FROM NEW.service_agreement_id');
    expect(attributionMigration).toContain('Finance cost source reference is required');
  });
});