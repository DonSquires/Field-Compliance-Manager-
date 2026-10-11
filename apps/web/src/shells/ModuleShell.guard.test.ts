import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SPECIALTY_MODULES } from '../config/specialtyModules';

const shell = readFileSync(resolve(process.cwd(), 'src/shells/ModuleShell.tsx'), 'utf8');
const router = readFileSync(resolve(process.cwd(), 'src/routing/RoleRouter.tsx'), 'utf8');
const officerShell = readFileSync(resolve(process.cwd(), 'src/shells/OfficerShell.tsx'), 'utf8');
const manifest = readFileSync(resolve(process.cwd(), 'src/config/specialtyModules.ts'), 'utf8');

describe('standalone module shell contract', () => {
  it('keeps specialty pages inside a reusable module shell', () => {
    expect(shell).toContain("case 'freedom_camping'");
    expect(shell).toContain("case 'parking_enforcement'");
    expect(shell).toContain("case 'noise_control'");
    expect(shell).toContain("case 'biosecurity'");
    expect(shell).toContain("case 'access_control'");
    expect(shell).toContain('OfficerAccessControlPage');
    expect(shell).toContain('Access-control event entry is not available in the Admin portal.');
    expect(shell).toContain('ParkingOversightPage');
    expect(shell).toContain('adminView');
    expect(shell).toContain("sessionStorage.getItem('fcm.admin_officer.portal') === 'admin'");
    expect(shell).toContain('useEnabledModules');
    expect(shell).toContain('BobPanel');
    expect(shell).toContain("const checkingAccess = status === 'loading' || moduleContext.loading");
    expect(shell).toContain('if (!checkingAccess && !allowed)');
    expect(shell).toContain('Module unavailable');
    expect(manifest).toContain('standalonePath');
    expect(manifest).toContain("key: 'freedom_camping'");
    expect(shell).toContain('module.integratedKey === moduleKey');
    expect(shell).toContain('activeModule: canonicalKey');
    expect(shell).toContain('Switch standalone module');
  });

  it('exposes module URLs without bypassing role routing', () => {
    expect(router).toContain("path.startsWith('/modules/')");
    expect(router).toContain('path="/modules/:moduleKey"');
    expect(officerShell).toContain('Open standalone app');
  });

  it('renders every specialty module that advertises a standalone path', () => {
    for (const module of SPECIALTY_MODULES) {
      expect(shell, `${module.key} has a standalone path but no ModuleShell renderer`).toContain(`case '${module.key}'`);
    }
  });
});