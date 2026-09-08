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
});