#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

function findAppRoot(sourceDir) {
  const seen = new Set();
  let current = path.resolve(sourceDir || process.cwd());
  for (let index = 0; index < 10; index += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (fs.existsSync(path.join(current, 'apps', 'web', 'package.json'))) return path.join(current, 'apps', 'web');
    if (fs.existsSync(path.join(current, 'package.json')) && fs.existsSync(path.join(current, 'apps', 'web'))) {
      return path.join(current, 'apps', 'web');
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function resolvePlaywright(appRoot) {
  const candidates = [
    appRoot && path.join(appRoot, 'node_modules', 'playwright'),
    appRoot && path.join(appRoot, 'node_modules', '@playwright/test'),
    path.join(process.cwd(), 'apps', 'web', 'node_modules', 'playwright'),
    path.join(process.cwd(), 'apps', 'web', 'node_modules', '@playwright/test')
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // fall through to the next candidate
    }
  }
  return null;
}

async function runVisualCheck({
  appUrl,
  sourceDir,
  artifactDir,
  playwright,
  timeoutMs = 45000,
  testName = 'bob-visual-check'
}) {
  const resolvedUrl = appUrl || process.env.BOB_APP_URL || process.env.VITE_APP_URL || 'http://127.0.0.1:4173';
  const resolvedArtifactDir = artifactDir ? path.resolve(artifactDir) : path.resolve('./bob-artifacts');
  fs.mkdirSync(resolvedArtifactDir, { recursive: true });

  const appRoot = findAppRoot(sourceDir || process.cwd());
  const resolvedPlaywright = playwright || resolvePlaywright(appRoot);
  if (!resolvedPlaywright) {
    throw new Error('Playwright is not installed in the project stack. Add it under apps/web and provide BOB_APP_URL.');
  }

  const browser = await resolvedPlaywright.chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  page.on('console', message => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });

  try {
    await page.goto(resolvedUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForLoadState('networkidle', { timeout: timeoutMs });
    const title = await page.title();
    const text = await page.locator('body').innerText();
    const screenshotPath = path.join(resolvedArtifactDir, `${testName}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const manifest = {
      mode: 'playwright-visual-check',
      checkedAt: new Date().toISOString(),
      appUrl: resolvedUrl,
      sourceDir: sourceDir ? path.resolve(sourceDir) : appRoot || process.cwd(),
      status: pageErrors.length ? 'failed' : 'passed',
      title,
      textSample: String(text || '').slice(0, 4000),
      browserErrors: pageErrors.slice(0, 20),
      screenshot: screenshotPath,
      checks: ['page_load', 'dom_ready', 'network_idle', 'screenshot']
    };

    const manifestPath = path.join(resolvedArtifactDir, 'browser-check.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    if (pageErrors.length) {
      throw new Error(`browser validation failed: ${pageErrors.join('; ')}`);
    }

    return { manifestPath, screenshotPath, result: manifest };
  } finally {
    await browser.close();
  }
}

function ensureBrowserCheckInputs(args) {
  if (args.length < 2) {
    throw new Error('browser verifier requires sourceDir and artifactDir');
  }
  const sourceDir = path.resolve(args[0]);
  const artifactDir = path.resolve(args[1]);
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`source directory not found: ${sourceDir}`);
  }
  fs.mkdirSync(artifactDir, { recursive: true });
  return { sourceDir, artifactDir };
}

async function main() {
  try {
    const { sourceDir, artifactDir } = ensureBrowserCheckInputs(process.argv.slice(2));
    const result = await runVisualCheck({
      sourceDir,
      artifactDir,
      appUrl: process.env.BOB_APP_URL || process.env.VITE_APP_URL || 'http://127.0.0.1:4173'
    });
    console.log(JSON.stringify(result.result));
    process.exit(0);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { ensureBrowserCheckInputs, findAppRoot, resolvePlaywright, runVisualCheck };
