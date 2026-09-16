const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/onspace-ai-chat/index.ts'), 'utf8');
const research = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/bob-web-research/index.ts'), 'utf8');

test('Bob web research passes bounded redacted source evidence to reasoning', () => {
  assert.match(source, /const evidence = sources\.slice\(0, 5\)/);
  assert.match(source, /String\(source\.excerpt \|\| ''\)\.slice\(0, 1500\)/);
  assert.match(source, /Web research returned no safe sources/);
  assert.match(source, /source_count: sources\.length/);
  assert.match(research, /excerpt: redactPII\(s\.content\)\.slice\(0, 1500\)/);
  assert.match(research, /web_research_requires_human_invocation/);
  assert.match(research, /isSafePublicUrl/);
  assert.match(source, /module_key: agentWorkspaceContext\.agent_mode/);
});

test('Bob web research allowlists the forestry sector references below official sources (owner ruling 2026-09-16)', () => {
  const sectorBlock = research.match(/const SECTOR_REFERENCE_DOMAINS = \[([\s\S]*?)\];/);
  assert.ok(sectorBlock, 'SECTOR_REFERENCE_DOMAINS list present');
  for (const domain of ['tasmanpine.co.nz', 'onefortyone.com', 'nzfoa.org.nz', 'nzif.org.nz', 'fica.org.nz', 'scionresearch.com', 'forest360.nz', 'pfolsen.com', 'forestmanagement.co.nz', 'fmnz.co.nz', 'nzforestry.co.nz', 'matarikiforests.co.nz', 'portblakely.com']) {
    assert.ok(sectorBlock[1].includes(`'${domain}'`), `${domain} allowlisted`);
  }
  // News, social and video hosts stay open-web (0.4): they are never auto-invoke sources.
  for (const domain of ['nzherald.co.nz', 'rnz.co.nz', 'youtube.com', 'facebook.com']) {
    assert.ok(!research.includes(`'${domain}'`), `${domain} not allowlisted`);
  }
  assert.match(research, /if \(hostMatches\(host, TRUSTED_DOMAINS\)\) return OFFICIAL_TRUST;/);
  assert.match(research, /if \(hostMatches\(host, SECTOR_REFERENCE_DOMAINS\)\) return SECTOR_TRUST;/);
  assert.match(research, /const SECTOR_TRUST = 0\.8;/);
  assert.match(research, /trustScore\(u\) >= AUTO_INVOKE_MIN_TRUST/);
});