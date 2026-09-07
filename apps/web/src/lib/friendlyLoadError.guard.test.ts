import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Raw Postgres/PostgREST error text (e.g. "JSON object requested, multiple
// (or no) rows returned") must never reach an officer/admin directly — it
// was previously concatenated straight into user-visible banners. Every
// page that loads multiple queries in parallel must summarize failures
// through describeLoadFailures instead.
const pages = [
  'pages/OfficerSchedulePage.tsx',
  'pages/OfficerDebriefPage.tsx',
  'pages/OfficerFieldReportPage.tsx',
  'pages/InvestigationPage.tsx',
  'pages/AdminHubPage.tsx',
];

describe('officer/admin load-failure banners never leak raw backend error text', () => {
  for (const page of pages) {
    it(`${page} summarizes failures via describeLoadFailures`, () => {
      const source = readFileSync(resolve(process.cwd(), 'src', page), 'utf8');
      expect(source).toContain("from '../lib/friendlyLoadError'");
      expect(source).toContain('describeLoadFailures(');
      expect(source).not.toMatch(/\$\{[a-zA-Z0-9_.]*(error|Error)[a-zA-Z0-9_.]*\.message\}/);
    });
  }
});
