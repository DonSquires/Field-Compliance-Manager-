import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const component = readFileSync(resolve(process.cwd(), 'src/components/FinanceCard.tsx'), 'utf8');
const style = readFileSync(resolve(process.cwd(), 'src/components/FinanceCard.css'), 'utf8');
const home = readFileSync(resolve(process.cwd(), 'src/pages/FinanceBureauPage.tsx'), 'utf8');

describe('finance card system', () => {
  it('provides consistent high-definition card structure and states', () => {
    expect(component).toContain('finance-card-topline');
    expect(component).toContain('finance-card-eyebrow');
    expect(component).toContain('finance-card-action');
    expect(style).toContain('.finance-card-primary');
    expect(style).toContain('.finance-card-attention');
    expect(style).toContain('.finance-card-good');
    expect(style).toContain('min-height:170px');
  });

  it('opens the selected-tool workbench instead of stacking home task cards', () => {
    expect(home).toContain("import FinanceMoneyPage from './FinanceMoneyPage';");
    expect(home).toContain('initialWorkflow="invoices"');
    expect(home).not.toContain('<FinanceCard');
  });
});
