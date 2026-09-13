import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const page = readFileSync(resolve(process.cwd(), 'src/pages/ModuleSubscriptionsPage.tsx'), 'utf8');

describe('module subscriptions UX safeguards', () => {
  it('requires explicit confirmation before disabling a module that gates admin pages', () => {
    expect(page).toContain('MODULE_GATED_AREAS');
    expect(page).toContain('confirmDisableKey');
    expect(page).toContain('Confirm disable');
    expect(page).toContain("role=\"alertdialog\"");
  });

  it('shows a success receipt naming what changed after a toggle', () => {
    expect(page).toContain('enabled. It now appears in your admin navigation.');
    expect(page).toContain('disabled. Its admin pages are no longer reachable for this organisation.');
  });
});
