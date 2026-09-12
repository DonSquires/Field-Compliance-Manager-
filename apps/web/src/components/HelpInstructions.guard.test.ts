import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const component = readFileSync(resolve(process.cwd(), 'src/components/HelpInstructions.tsx'), 'utf8');
const admin = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');
const officer = readFileSync(resolve(process.cwd(), 'src/shells/OfficerShell.tsx'), 'utf8');
const client = readFileSync(resolve(process.cwd(), 'src/shells/ClientShell.tsx'), 'utf8');
const scan = readFileSync(resolve(process.cwd(), 'src/shells/ScanShell.tsx'), 'utf8');

describe('global help instructions', () => {
  it('provides a small accessible trigger and collapsible workflow guidance', () => {
    expect(component).toContain('help-instructions-trigger');
    expect(component).toContain('How do I use this?');
    expect(component).toContain('aria-expanded={expanded}');
    expect(component).toContain('How to use it');
    expect(component).toContain('What happens next');
    expect(component).toContain('Using Finance');
  });

  it('is available across every application shell', () => {
    for (const shell of [admin, officer, client, scan]) expect(shell).toContain('<HelpInstructions');
  });
});
