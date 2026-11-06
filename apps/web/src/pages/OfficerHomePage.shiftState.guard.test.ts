import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { serviceTypeLabel } from '../lib/officerServiceLabels';

const home = readFileSync(resolve(__dirname, 'OfficerHomePage.tsx'), 'utf8');
const shell = readFileSync(resolve(__dirname, '../shells/OfficerShell.tsx'), 'utf8');
const activeShift = readFileSync(resolve(__dirname, '../hooks/useActiveShift.ts'), 'utf8');

describe('officer home shift state', () => {
  it('only claims the officer is on shift once the shift is in progress', () => {
    expect(home).toContain("const started = shift?.status === 'in_progress'");
    expect(home).toMatch(/started \? `On shift/);
  });

  it('shows route progress only for multi-stop work', () => {
    expect(home).toContain('shiftProgress.total > 1 &&');
  });

  it('names the shift site from the stop rows', () => {
    expect(activeShift).toContain('site:site_id ( name )');
    expect(home).toContain('shiftSiteNames');
  });

  it('labels the shell subtitle with the officer-facing service name', () => {
    expect(shell).toContain('serviceTypeLabel(activeShift.shift_type).label');
    expect(serviceTypeLabel('static_guarding').label).toBe('Site Guarding');
    expect(serviceTypeLabel('unknown_kind').label).toBe('unknown kind');
  });
});
