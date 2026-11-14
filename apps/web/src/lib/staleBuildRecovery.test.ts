import { describe, expect, it, vi } from 'vitest';
import { installStaleBuildRecovery, isStaleBuildReloadPending, shouldReloadForStaleBuild } from './staleBuildRecovery';

const memoryStorage = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};

describe('stale build recovery', () => {
  it('reloads once, then waits out the cooldown so a broken chunk cannot loop', () => {
    const storage = memoryStorage();
    expect(shouldReloadForStaleBuild(storage, 1_000_000)).toBe(true);
    expect(shouldReloadForStaleBuild(storage, 1_030_000)).toBe(false);
    expect(shouldReloadForStaleBuild(storage, 1_061_000)).toBe(true);
  });

  it('still recovers when session storage is unavailable', () => {
    expect(shouldReloadForStaleBuild(null, 5)).toBe(true);
  });

  it('reloads without swallowing the chunk error and marks the reload as pending', () => {
    const listeners: Record<string, (event: Event) => void> = {};
    const reload = vi.fn();
    const target = {
      addEventListener: (name: string, handler: (event: Event) => void) => { listeners[name] = handler; },
      sessionStorage: memoryStorage(),
      location: { reload },
    } as unknown as Window;
    installStaleBuildRecovery(target);
    expect(isStaleBuildReloadPending()).toBe(false);
    const event = new Event('vite:preloadError', { cancelable: true });
    listeners['vite:preloadError'](event);
    expect(reload).toHaveBeenCalledTimes(1);
    // Vite resolves a prevented import to undefined, which React.lazy turns into
    // "Cannot read properties of undefined (reading 'default')" (BB-182/189/190).
    expect(event.defaultPrevented).toBe(false);
    expect(isStaleBuildReloadPending()).toBe(true);
  });
});
