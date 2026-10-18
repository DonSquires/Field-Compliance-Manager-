import { describe, expect, it } from 'vitest';
import { fetchDeployedBuild } from './AppUpdateNotice';

describe('fetchDeployedBuild', () => {
  it('reads the deployed build id without caching', async () => {
    let init: RequestInit | undefined;
    const fetcher = (async (_url: string, options?: RequestInit) => { init = options; return new Response(JSON.stringify({ build: 'abc1234' })); }) as typeof fetch;
    expect(await fetchDeployedBuild(fetcher)).toBe('abc1234');
    expect(init?.cache).toBe('no-store');
  });

  it('treats a missing or malformed manifest as unknown, never as a new version', async () => {
    expect(await fetchDeployedBuild((async () => new Response('nope', { status: 404 })) as typeof fetch)).toBeNull();
    expect(await fetchDeployedBuild((async () => new Response('<html>')) as typeof fetch)).toBeNull();
    expect(await fetchDeployedBuild((async () => { throw new Error('offline'); }) as typeof fetch)).toBeNull();
  });
});
