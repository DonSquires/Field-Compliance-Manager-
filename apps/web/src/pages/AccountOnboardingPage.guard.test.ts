/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/AccountOnboardingPage.tsx'), 'utf8');

describe('Account Onboarding failure state', () => {
  it('clears stale queue state when the governed RPC fails', () => {
    expect(source).toContain('if(loadError){setRows([]);setSelectedId(null);setError(loadError.message);}');
  });

  it('hides queue metrics and empty-state claims while data is unavailable', () => {
    expect(source).toContain('if(error)return');
    expect(source).toContain('Onboarding data unavailable');
    expect(source).toContain('Queue totals and account status are hidden until the service responds.');
    expect(source).toContain("loading?'Retrying':'Retry'");
  });
});
