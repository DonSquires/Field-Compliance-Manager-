import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/BreachReviewPage.tsx'), 'utf8');

describe('Breach alert lifecycle filters', () => {
  it('exposes every schema-supported status in the review queue', () => {
    for (const status of ['open', 'acknowledged', 'actioned', 'dismissed', 'resolved', 'exempt_homeless']) {
      expect(page).toContain(`setStatusFilter('${status}')`);
    }
  });
});
