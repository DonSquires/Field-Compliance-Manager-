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
});
