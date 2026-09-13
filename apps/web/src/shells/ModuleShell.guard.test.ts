import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
    expect(shell).toContain('useEnabledModules');
    expect(shell).toContain('BobPanel');
    expect(shell).toContain("status !== 'loading'");
    expect(manifest).toContain('standalonePath');
    expect(manifest).toContain("key: 'freedom_camping'");
    expect(shell).toContain('Switch standalone module');
  });

  it('exposes module URLs without bypassing role routing', () => {
    expect(router).toContain("path.startsWith('/modules/')");
    expect(router).toContain('path="/modules/:moduleKey"');
    expect(officerShell).toContain('Open standalone app');
  });
});