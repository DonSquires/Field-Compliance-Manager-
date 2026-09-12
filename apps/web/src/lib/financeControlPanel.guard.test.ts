import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const component = readFileSync(resolve(process.cwd(), 'src/components/FinanceControlPanel.tsx'), 'utf8');
const page = readFileSync(resolve(process.cwd(), 'src/pages/FinanceMoneyPage.tsx'), 'utf8');

describe('Finance control centre', () => {
  it('uses tenant-scoped reads and governed internal finance RPCs', () => {
    expect(component).toContain("from('finance_pl_periods')");
    expect(component).toContain("from('finance_tax_periods')");
    expect(component).toContain("from('service_agreements')");
    expect(component).toContain("from('shifts')");
    expect(component).toContain('p_shift_id: selectedShiftId || null');
    expect(component).toContain("['accepted', 'in_progress']");
    expect(component).toContain("supabase.rpc('record_finance_service_cost'");
    expect(component).toContain("supabase.rpc('prepare_finance_tax_period'");
    expect(component).toContain("supabase.rpc('close_finance_pl_period'");
  });

  it('keeps bank and IRD external linking outside the control centre', () => {
    expect(component).toContain('No bank or IRD connection is used here');
    expect(page).toContain('<FinanceControlPanel />');
  });
});