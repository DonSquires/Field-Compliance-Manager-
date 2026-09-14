import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260830139000_govern_crm_quote_lines.sql'), 'utf8');
const schema = readFileSync(resolve(process.cwd(), '../../supabase/schema.sql'), 'utf8');

describe('governed CRM quote lines', () => {
  it('locks and race-checks draft quote pricing', () => {
    expect(sql).toContain('where q.id=p_quote_id for update');
    expect(sql).toContain('v_quote.status<>p_expected_status');
    expect(sql).toContain('Only draft quotes can be priced');
  });

  it('validates line and client dimensions', () => {
    expect(sql).toContain("p_kind not in('labour','travel','overhead','module','custom')");
    expect(sql).toContain('Quote site must belong to the client organization');
    expect(sql).toContain('Module key is required for module lines');
  });

  it('is retry-safe and recalculates canonical totals atomically', () => {
    expect(sql).toContain('idx_quote_lines_client_request');
    expect(sql).toContain('sum(l.quantity*l.unit_cost)');
    expect(sql).toContain('sum(l.quantity*l.unit_charge)');
    expect(sql).toContain("'crm_quote_line_added'");
  });

  it('closes direct authenticated line writes', () => {
    expect(sql).toContain('revoke insert,update,delete on public.quote_lines');
    expect(schema).toMatch(/CREATE (OR REPLACE )?FUNCTION "public"\."add_crm_quote_line"/);
  });
});