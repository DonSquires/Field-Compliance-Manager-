/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/AccountOnboardingPage.tsx'), 'utf8');

describe('Account Onboarding failure state', () => {
  it('clears stale queue state when the governed RPC fails', () => {
    expect(source).toContain('if(queueError){setRows([]);setSelectedId(null);setLoadError(queueError.message);}');
  });

  it('hides queue metrics and empty-state claims while data is unavailable', () => {
    expect(source).toContain('if(loadError)return');
    expect(source).toContain('Onboarding data unavailable');
    expect(source).toContain('Queue totals and account status are hidden until the service responds.');
    expect(source).toContain("loading?'Retrying':'Retry'");
  });

  it('keeps governed action rejections inside the loaded workspace', () => {
    expect(source).toContain('if(actionError)setError(actionError.message)');
    expect(source).toContain('{error&&<div className="onboarding-message is-error"');
  });
});
