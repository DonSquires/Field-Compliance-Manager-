import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('admin shell desktop download control', () => {
  it('keeps the component variant defined in the stylesheet it imports', () => {
    const shell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');
    const css = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.css'), 'utf8');

    expect(shell).toContain('admin-shell-icon admin-desktop-download');
    expect(css).toContain('.admin-desktop-download');
    expect(css).toContain('.admin-desktop-download:hover');
  });

  it('bounds only the admin shell and gives workbenches a zero-minimum-height flex chain', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.css'), 'utf8');
    expect(css).toContain('height: 100dvh');
    expect(css).toContain('grid-template-columns: auto minmax(0, 1fr)');
    expect(css).toContain('width: 200px');
    expect(css).toContain('width: 52px');
    expect(css).toContain('.admin-shell .admin-shell-main.is-workbench');
    expect(css).toContain('.admin-shell-main.is-workbench > .admin-shell-page');
    expect(css).toContain('--console-action: #0F172A');
    expect(css).not.toMatch(/(?:^|\})\s*(?:html|body|#root)\s*\{/);
  });
});
