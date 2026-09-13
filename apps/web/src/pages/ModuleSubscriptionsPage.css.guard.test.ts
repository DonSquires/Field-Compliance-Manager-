import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const page = readFileSync(resolve(process.cwd(), 'src/pages/ModuleSubscriptionsPage.tsx'), 'utf8');
const css = readFileSync(resolve(process.cwd(), 'src/pages/PageStyles.css'), 'utf8');

describe('module subscriptions imports its own classes, not a borrowed unmatched one', () => {
  it('every className used by the page resolves in a stylesheet it actually imports', () => {
    expect(page).toContain("import './PageStyles.css';");
    expect(page).toContain('className="agreement-check"');
    expect(css).toContain('.agreement-check {');
  });
});
