import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = existsSync(resolve(process.cwd(), 'src')) ? process.cwd() : resolve(process.cwd(), '../..');
const app = readFileSync(resolve(root, 'src/App.tsx'), 'utf8');
const page = readFileSync(resolve(root, 'src/pages/PublicDisputePage.tsx'), 'utf8');

describe('public dispute submission', () => {
  it('is reachable without the authenticated wildcard route', () => {
    expect(app).toContain('<Route path="/dispute" element={<PublicDisputePage />} />');
  });

  it('submits only to the public dispute endpoint with required claimant grounds', () => {
    expect(page).toContain("functions.invoke('submit-dispute'");
    expect(page).toContain('grounds.length === 0');
    expect(page).toContain('submitter_name: form.name.trim()');
    expect(page).not.toContain("from('organizations')");
  });
});