import { describe, expect, it } from 'vitest';
import { extraWorkOrderInForce, extraWorkOrderState } from './extraWorkOrders';

const order = (starts_on: string, ends_on: string | null = null, review_on: string | null = null) => ({ starts_on, ends_on, review_on });

describe('extraWorkOrderState', () => {
  it('reads the order term against today', () => {
    expect(extraWorkOrderState(order('2026-10-01'), '2026-10-25')).toBe('active');
    expect(extraWorkOrderState(order('2026-11-01'), '2026-10-25')).toBe('upcoming');
    expect(extraWorkOrderState(order('2026-10-01', '2026-10-25'), '2026-10-25')).toBe('ending');
    expect(extraWorkOrderState(order('2026-10-01', '2026-10-24'), '2026-10-25')).toBe('ended');
    expect(extraWorkOrderState(order('2026-10-01', '2026-09-30'), '2026-10-25')).toBe('cancelled');
    expect(extraWorkOrderState(order('2026-10-01', null, '2026-10-20'), '2026-10-25')).toBe('review_due');
  });
});

describe('extraWorkOrderInForce', () => {
  it('includes both ends of the term', () => {
    const term = order('2026-10-01', '2026-10-31');
    expect(extraWorkOrderInForce(term, '2026-10-01')).toBe(true);
    expect(extraWorkOrderInForce(term, '2026-10-31')).toBe(true);
    expect(extraWorkOrderInForce(term, '2026-09-30')).toBe(false);
    expect(extraWorkOrderInForce(term, '2026-11-01')).toBe(false);
    expect(extraWorkOrderInForce(order('2026-10-01'), '2030-01-01')).toBe(true);
  });
});
