import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(__dirname, 'env.ts'), 'utf8');

describe('frontend environment boundaries', () => {
  it('exposes only the public PTT WebSocket origin to the browser', () => {
    expect(source).toContain("optionalEnv('VITE_PTT_SIGNAL_URL')");
    expect(source).not.toContain('PTT_SESSION_SECRET');
    expect(source).not.toContain('PTT_RELAY_TOKEN');
  });
});