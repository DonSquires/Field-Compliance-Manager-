import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/ParkingOversightPage.tsx'), 'utf8');

describe('parking oversight schema parity', () => {
  it('reads the inference, signage, movement, and vehicle compliance fields already present in schema', () => {
    expect(page).toContain('movement_detected');
    expect(page).toContain('bob_classification');
    expect(page).toContain('effective_time_limit_minutes');
    expect(page).toContain('rego_status');
    expect(page).toContain('wof_status');
    expect(page).toContain('cof_status');
  });

  it('provides overdue and review-required workload views', () => {
    expect(page).toContain("type ParkingFilter = 'all' | 'active' | 'overdue' | 'review'");
    expect(page).toContain('Review required');
    expect(page).toContain('overdueCount');
    expect(page).toContain('reviewCount');
  });
});