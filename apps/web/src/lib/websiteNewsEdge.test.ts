import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(resolve(process.cwd(), '..', '..', 'supabase', 'functions', 'website-news', 'index.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const id = '00000000-0000-4000-8000-000000000001';

function runtime(rows: unknown[] = []) {
  const rpc = vi.fn().mockResolvedValue({ data: rows, error: null });
  const download = vi.fn().mockResolvedValue({ data: new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' }), error: null });
  const bucket = vi.fn().mockReturnValue({ download });
  let handler: (request: Request) => Promise<Response> = async () => { throw new Error('Function did not boot'); };
  runInNewContext(compiled, {
    exports: {}, require: () => ({ createClient: () => ({ rpc, storage: { from: bucket } }) }),
    Deno: { env: { get: (name: string) => name === 'SUPABASE_URL' ? 'https://fixture.invalid' : 'synthetic-service-role' },
      serve: (callback: typeof handler) => { handler = callback; } },
    URL, Response, console: { error: vi.fn() },
  });
  return { request: (query = '', method = 'GET') => handler(new Request(`https://fixture.invalid/website-news${query}`, { method })), rpc, download, bucket };
}

describe('public website news Edge boundary', () => {
  it('returns only published snapshots and removes private storage paths', async () => {
    const app = runtime([{ id, title: 'Published synthetic update', photo_path: 'private-provider/post/image.jpg' }]);
    const response = await app.request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id, title: 'Published synthetic update', image_url: `/api/website-news?image=${id}` }]);
    expect(app.rpc).toHaveBeenCalledWith('read_published_website_posts', { p_slug: null, p_id: null });
  });
  it('looks up the current published record before downloading its photo', async () => {
    const app = runtime([{ id, photo_path: 'private-provider/post/image.jpg' }]);
    const response = await app.request(`?image=${id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(app.bucket).toHaveBeenCalledWith('website-post-images');
    expect(app.download).toHaveBeenCalledWith('private-provider/post/image.jpg');
    expect(app.rpc).toHaveBeenCalledWith('read_published_website_posts', { p_slug: null, p_id: id });
  });
  it('never downloads a draft, removed image or unpublished post', async () => {
    const app = runtime();
    expect((await app.request(`?image=${id}`)).status).toBe(404);
    expect(app.download).not.toHaveBeenCalled();
  });
  it('rejects invalid, duplicate, empty and ambiguous queries without reaching the database', async () => {
    const app = runtime();
    for (const query of ['?image=../draft', '?slug=', `?image=${id}&slug=post`, '?slug=one&slug=two', '?private_path=hidden']) {
      expect((await app.request(query)).status).toBe(400);
    }
    expect((await app.request('', 'POST')).status).toBe(405);
    expect(app.rpc).not.toHaveBeenCalled();
  });
  it('surfaces database and storage failures without leaking their content', async () => {
    const app = runtime([{ id, photo_path: 'private-provider/post/image.jpg' }]);
    app.rpc.mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'private diagnostic' } });
    const failed = await app.request();
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('private diagnostic');
    app.download.mockResolvedValueOnce({ data: new Blob(['not a photo'], { type: 'text/html' }), error: null });
    expect((await app.request(`?image=${id}`)).status).toBe(503);
  });
});
