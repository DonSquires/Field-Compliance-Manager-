/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Vercel client routing', () => {
  const config = JSON.parse(readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8')) as {
    rewrites?: Array<{ source: string; destination: string }>;
  };
  const spa = config.rewrites?.find((rewrite) => rewrite.destination === '/index.html');
  const routesToApp = (path: string) => new RegExp(`^${spa!.source}$`).test(path);

  it('serves the React entry point for direct admin workflow URLs', () => {
    expect(spa).toBeDefined();
    for (const path of ['/admin/cost-of-service', '/admin/people-hr', '/officer', '/']) expect(routesToApp(path)).toBe(true);
  });

  it('serves built assets and the installable officer app files directly', () => {
    for (const path of ['/assets/index.js', '/manifest.webmanifest', '/officer-sw.js', '/version.json']) expect(routesToApp(path)).toBe(false);
  });
});