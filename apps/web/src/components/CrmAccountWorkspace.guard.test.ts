import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/components/CrmAccountWorkspace.tsx'), 'utf8');

describe('client portfolio hub', () => {
  it('keeps modules inside the organization portfolio context', () => {
    expect(source).toContain('Modules');
    expect(source).toContain('organizationModules.filter((module) => module.enabled)');
    expect(source).toContain('Modules radiate from this portfolio');
    expect(source).toContain('module_key.replaceAll');
  });

  it('keeps places and finance as portfolio views', () => {
    expect(source).toContain('Places <strong>{locations.length}</strong>');
    expect(source).toContain('Finance <strong>');
    expect(source).toContain('Location house 360');
  });

  it('keeps schedules in the portfolio while handing staff assignment to roster', () => {
    expect(source).toContain('Operations <strong>{deliverySchedules.length}</strong>');
    expect(source).toContain('Schedules and roster readiness stay in the portfolio context');
    expect(source).toContain("onNavigate?.('roster'");
    expect(source).toContain('deliverySchedules.map');
  });

  it('provides one portfolio readiness checklist for the next human action', () => {
    expect(source).toContain('>Readiness</button>');
    expect(source).toContain('crm-readiness-list');
    expect(source).toContain('Organization identity');
    expect(source).toContain('No recorded activation blockers');
  });

  it('shows the corporate hub status at the top of the portfolio', () => {
    expect(source).toContain('Client access');
    expect(source).toContain('Commercial agreement');
    expect(source).toContain('Schedules');
    expect(source).toContain('headlineInvitation');
    expect(source).toContain('onClick={() => setView(\'readiness\')}');
    expect(source).toContain('onClick={() => setView(\'operations\')}');
  });

  it('makes Bob portfolio scoping visible without creating a second assistant surface', () => {
    expect(source).toContain('Bob uses this portfolio context');
    expect(source).not.toContain('onspace-ai-chat');
  });
});