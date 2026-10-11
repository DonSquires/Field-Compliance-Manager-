import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const monitor = readFileSync(resolve(src, 'lib/bobFrictionMonitor.ts'), 'utf8');
const app = readFileSync(resolve(src, 'App.tsx'), 'utf8');

describe('Bob runtime friction monitor', () => {
  it('runs only after authentication and removes its listeners', () => {
    expect(app).toContain('if (!hasSession) return;');
    expect(app).toContain('installBobFrictionMonitor()');
    expect(monitor).toContain("removeEventListener('error'");
    expect(monitor).toContain("removeEventListener('unhandledrejection'");
  });

  it('deduplicates within the browser session and sends no stack or request body', () => {
    expect(monitor).toContain('window.sessionStorage.getItem(sessionKey)');
    expect(monitor).toContain('window.sessionStorage.setItem(sessionKey');
    expect(monitor).not.toContain('stack:');
    expect(monitor).not.toContain('response_body');
    expect(monitor).not.toContain('request.body');
  });
});
