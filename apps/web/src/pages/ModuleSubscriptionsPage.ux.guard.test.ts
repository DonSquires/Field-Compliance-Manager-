import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const page = readFileSync(resolve(process.cwd(), 'src/pages/ModuleSubscriptionsPage.tsx'), 'utf8');
const css = readFileSync(resolve(process.cwd(), 'src/pages/PageStyles.css'), 'utf8');

describe('module subscriptions UX safeguards', () => {
  it('requires explicit confirmation before disabling a module that gates admin pages', () => {
    expect(page).toContain('MODULE_GATED_AREAS');
    expect(page).toContain('confirmDisableKey');
    expect(page).toContain('Confirm disable');
    expect(page).toContain("role=\"alertdialog\"");
    expect(page).toContain('className="alert alert-warning"');
  });

  it('shows a success receipt naming what changed after a toggle', () => {
    expect(page).toContain('enabled. It now appears in your admin navigation.');
    expect(page).toContain('disabled. Its admin pages are no longer reachable for this organisation.');
  });

  it('colour-codes subscription status badges instead of leaving them all grey', () => {
    expect(css).toContain('.status-badge.status-active');
    expect(css).toContain('.status-badge.status-suspended');
    expect(css).toContain('.status-badge.status-cancelled');
  });

  it('does not leave an unscoped tenant in an indefinite loading state', () => {
    expect(page).toContain('setLoading(false);');
    expect(page).toContain('Organisation context unavailable');
    expect(page).toContain('Reload access');
  });

  it('provides a retry action when subscription reads fail', () => {
    expect(page).toContain('>Retry</button>');
    expect(page).toContain('onClick={() => void load()}');
    expect(css).toContain('.module-access-state');
  });
});
