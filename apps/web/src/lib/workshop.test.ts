import { describe, expect, it } from 'vitest';
import {
  buildTemplateLinesPayload,
  describeCompletionEffect,
  isWorkOrderOpen,
  lineKindFromSelection,
  lineTotal,
  money,
  nextWorkOrderActions,
  summariseLines,
} from './workshop';

describe('workshop helpers', () => {
  it('offers exactly the moves the database ladder allows', () => {
    expect(nextWorkOrderActions('draft').map((a) => a.status)).toEqual(['approved', 'cancelled']);
    expect(nextWorkOrderActions('approved').map((a) => a.status)).toEqual(['in_progress', 'draft', 'cancelled']);
    expect(nextWorkOrderActions('in_progress').map((a) => a.status)).toEqual(['completed', 'cancelled']);
    expect(nextWorkOrderActions('completed')).toEqual([]);
    expect(nextWorkOrderActions('cancelled')).toEqual([]);
    expect(nextWorkOrderActions('in_progress').find((a) => a.status === 'completed')?.needsNote).toBe(true);
  });

  it('knows which orders are still open', () => {
    expect(isWorkOrderOpen('draft')).toBe(true);
    expect(isWorkOrderOpen('in_progress')).toBe(true);
    expect(isWorkOrderOpen('completed')).toBe(false);
  });

  it('maps a price-list pick onto a line kind', () => {
    const base = { source: 'item' as const, id: 'x', description: 'd', costType: 'materials' as const, unit: 'ea', unitCharge: 1, unitCost: 1 };
    expect(lineKindFromSelection({ ...base, kind: 'materials' })).toBe('material');
    expect(lineKindFromSelection({ ...base, kind: 'equipment' })).toBe('equipment');
    expect(lineKindFromSelection({ ...base, kind: 'labour' })).toBe('labour');
    expect(lineKindFromSelection({ ...base, kind: 'travel' })).toBe('travel');
    expect(lineKindFromSelection({ ...base, kind: 'custom' })).toBe('labour');
    expect(lineKindFromSelection(null)).toBe('material');
  });

  it('totals lines in cents and derives the margin', () => {
    expect(lineTotal(2.5, 62)).toBe(155);
    expect(lineTotal(3, 0.1)).toBe(0.3);
    const summary = summariseLines([
      { quantity: 2.5, unit_price: 62, unit_cost: 40 },
      { quantity: 3, unit_price: 95, unit_cost: 45 },
    ]);
    expect(summary.charge).toBe(440);
    expect(summary.cost).toBe(235);
    expect(summary.marginPct).toBe(46.59);
    expect(summariseLines([]).marginPct).toBeNull();
    expect(money(1234.5)).toBe('$1,234.50');
    expect(money(null)).toBe('—');
  });

  it('validates template lines before they reach the database', () => {
    expect(() => buildTemplateLinesPayload([])).toThrow(/at least one line/);
    expect(() => buildTemplateLinesPayload([{ line_kind: 'material', item_id: null, description: '', quantity: 1, unit_of_measure: null }])).toThrow(/Line 1 needs a description/);
    expect(() => buildTemplateLinesPayload([{ line_kind: 'labour', item_id: 'i', description: 'x', quantity: 0, unit_of_measure: 'hr' }])).toThrow(/quantity above zero/);
    expect(buildTemplateLinesPayload([{ line_kind: 'material', item_id: 'i', description: '  ', quantity: 2, unit_of_measure: 'm' }])).toEqual([
      { line_kind: 'material', item_id: 'i', description: null, quantity: 2, unit_of_measure: 'm' },
    ]);
  });

  it('explains what completing an order will do', () => {
    expect(describeCompletionEffect({ inventory_location_id: 'l', stock_location_name: 'Workshop', client_name: 'Oracle Client' }, [
      { line_kind: 'material', item_id: 'i' },
      { line_kind: 'labour', item_id: 'j' },
    ])).toBe('On completion: 1 stock line will be drawn down from Workshop; the lines become billable to Oracle Client on the next invoice sweep.');
    expect(describeCompletionEffect({ inventory_location_id: null, stock_location_name: null, client_name: null }, [])).toBe(
      'On completion: no stock movement (no stock location on this order); the lines stay internal (no client on this order).'
    );
  });
});
