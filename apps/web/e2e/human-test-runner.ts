import { expect, type Page, type TestInfo } from '@playwright/test';
import { isWriteOrDestructiveAction } from '../src/lib/humanTestActionPolicy';

export type HumanFindingSeverity = 'info' | 'warning' | 'error';

export interface HumanFinding {
  severity: HumanFindingSeverity;
  message: string;
  url: string;
  step: string;
}

interface HumanStep {
  name: string;
  startedAt: string;
  finishedAt: string;
  url: string;
  status: 'passed' | 'failed';
  details?: string;
}

interface HumanSkippedAction {
  route: string;
  index: number;
  label: string;
  reason: 'write-or-destructive' | 'disabled' | 'covered-by-modal' | 'not-present-after-route-restore';
}

const SAFE_SAMPLE_VALUES: Record<string, string> = {
  search: 'Civic Events',
  email: 'human-test@example.invalid',
  text: 'Human test observation',
  number: '1',
};

const RESOURCE_INTENSIVE_ADMIN_ROUTES = new Set(['Client Portfolios']);

function now(): string {
  return new Date().toISOString();
}

function compact(value: string | null | undefined, max = 180): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * A human-style browser session. It records what a person could see and do,
 * rather than only asserting a predefined DOM snapshot.
 */
export class HumanTestSession {
  readonly findings: HumanFinding[] = [];
  readonly steps: HumanStep[] = [];
  readonly skippedActions: HumanSkippedAction[] = [];
  private currentStep = 'session';
  private readonly consoleErrors: string[] = [];
  private readonly abortedRequests: string[] = [];
  private readonly failedRequests: string[] = [];
  private readonly httpErrors: string[] = [];

  constructor(private readonly page: Page, private readonly testInfo: TestInfo) {
    page.on('console', (message) => {
      if (message.type() === 'error') this.consoleErrors.push(compact(message.text()));
    });
    page.on('pageerror', (error) => this.consoleErrors.push(compact(error.message)));
    page.on('requestfailed', (request) => {
      const failure = request.failure()?.errorText ?? '';
      const detail = `${request.method()} ${request.url()} ${failure}`.trim();
      if (/net::ERR_ABORTED|NS_BINDING_ABORTED|ERR_CANCELED/i.test(failure)) this.abortedRequests.push(detail);
      else this.failedRequests.push(detail);
    });
    page.on('response', (response) => {
      if (response.status() >= 400) this.httpErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    });
  }

  async step<T>(name: string, action: () => Promise<T>): Promise<T | undefined> {
    this.currentStep = name;
    const startedAt = now();
    console.log(`\n[HUMAN ${this.steps.length + 1}] ${name}`);
    try {
      const result = await action();
      this.steps.push({ name, startedAt, finishedAt: now(), url: this.page.url(), status: 'passed' });
      return result;
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      this.steps.push({ name, startedAt, finishedAt: now(), url: this.page.url(), status: 'failed', details });
      this.findings.push({ severity: 'error', message: details, url: this.page.url(), step: name });
      console.log(`[HUMAN ERROR] ${details}`);
      await this.capture(`failure-${this.steps.length}`);
      return undefined;
    }
  }

  async verifyDeployment(targetUrl: string): Promise<void> {
    this.currentStep = 'deployment preflight';
    const token = process.env.VERCEL_TOKEN;
    const projectId = process.env.VERCEL_PROJECT_ID;
    const expectedSha = process.env.HUMAN_TEST_EXPECTED_SHA || process.env.GITHUB_SHA || '';
    if (!token || !projectId) {
      console.log('[HUMAN DEPLOYMENT PREFLIGHT] unverified: VERCEL_TOKEN/VERCEL_PROJECT_ID not supplied');
      if (process.env.HUMAN_TEST_REQUIRE_DEPLOYMENT_MATCH === 'true') {
        this.findings.push({ severity: 'error', message: 'Deployment preflight could not verify the target deployment commit.', url: targetUrl, step: this.currentStep });
      }
      return;
    }
    const teamId = process.env.VERCEL_TEAM_ID;
    const query = new URLSearchParams({ projectId, limit: '20', target: 'production' });
    if (teamId) query.set('teamId', teamId);
    const response = await fetch(`https://api.vercel.com/v6/deployments?${query}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      this.findings.push({ severity: 'error', message: `Deployment preflight failed with HTTP ${response.status}.`, url: targetUrl, step: this.currentStep });
      return;
    }
    const body = await response.json() as { deployments?: Array<Record<string, unknown>> };
    const hostname = new URL(targetUrl).hostname;
    const deployment = (body.deployments ?? []).find((item) => {
      const aliases = Array.isArray(item.aliases) ? item.aliases.map(String) : [];
      return aliases.includes(hostname) || item.url === hostname || item.name === hostname;
    }) ?? body.deployments?.[0];
    const deployedSha = String((deployment?.meta as Record<string, unknown> | undefined)?.githubCommitSha ?? (deployment?.gitSource as Record<string, unknown> | undefined)?.sha ?? '');
    console.log(`[HUMAN DEPLOYMENT PREFLIGHT] target=${hostname} state=${String(deployment?.state ?? 'unknown')} deployed_sha=${deployedSha || 'unknown'} expected_sha=${expectedSha || 'not supplied'}`);
    if (expectedSha && deployedSha && !deployedSha.startsWith(expectedSha) && !expectedSha.startsWith(deployedSha)) {
      this.findings.push({ severity: process.env.HUMAN_TEST_REQUIRE_DEPLOYMENT_MATCH === 'true' ? 'error' : 'warning', message: `Deployment is stale: expected ${expectedSha}, serving ${deployedSha}.`, url: targetUrl, step: this.currentStep });
    }
  }

  async observe(label: string): Promise<void> {
    this.currentStep = label;
    const bodyText = compact(await this.page.locator('body').textContent(), 500);
    const headingLocator = this.page.locator('h1, h2, [role="heading"]').first();
    const heading = compact(await headingLocator.textContent({ timeout: 1000 }).catch(() => null));
    const buttons = await this.visibleLabels('button');
    const links = await this.visibleLabels('a');
    const fields = await this.page.locator('input:visible, textarea:visible, select:visible').count();
    const controls = await this.visibleControls();
    console.log(`[HUMAN OBSERVE] ${label}`);
    console.log(`  url: ${this.page.url()}`);
    console.log(`  heading: ${heading || '(none)'}`);
    console.log(`  fields: ${fields}; buttons (${buttons.length}): ${buttons.join(' | ') || '(none)'}`);
    console.log(`  links (${links.length}): ${links.join(' | ') || '(none)'}`);
    console.log(`  controls: ${JSON.stringify(controls)}`);
    console.log(`  text: ${bodyText || '(empty)'}`);
    if (!bodyText) {
      this.findings.push({ severity: 'warning', message: 'The rendered page contains no visible text.', url: this.page.url(), step: label });
    }
    await this.auditVisualUx(label);
    await this.capture(label);
  }

  private async auditVisualUx(step: string): Promise<void> {
    const audit = await this.page.evaluate(() => {
      const root = document.documentElement;
      const body = document.body;
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const visible = (element: Element) => {
        const style = window.getComputedStyle(element);
        const rect = (element as HTMLElement).getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const parseRgb = (value: string) => {
        const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
      };
      const luminance = (rgb: number[]) => rgb.map((value) => value / 255).map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
      const contrast = (foreground: string, background: string) => {
        const fg = parseRgb(foreground); const bg = parseRgb(background);
        if (!fg || !bg) return null;
        const light = Math.max(luminance(fg), luminance(bg));
        const dark = Math.min(luminance(fg), luminance(bg));
        return (light + 0.05) / (dark + 0.05);
      };
      const issues: string[] = [];
      if (root.scrollWidth > viewport.width + 2 || body.scrollWidth > viewport.width + 2) issues.push('horizontal overflow may clip content at this viewport');
      const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(visible);
      if (!headings.length) issues.push('no visible heading establishes the page hierarchy');
      if (headings.filter((heading) => (heading.textContent ?? '').trim()).length > 1 && !document.querySelector('h1')) issues.push('page has headings but no h1-level page title');
      const unnamedControls = [...document.querySelectorAll('button,a,input,textarea,select')].filter(visible).filter((element) => {
        const associatedLabel = element.closest('label') ?? [...document.querySelectorAll('label')].find((labelElement) => labelElement.htmlFor === (element as HTMLInputElement).id);
        const label = element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || element.getAttribute('placeholder') || associatedLabel?.textContent || '';
        return !label.trim();
      }).length;
      if (unnamedControls) issues.push(`${unnamedControls} visible interactive control(s) have no accessible name`);
      const missingAlt = [...document.querySelectorAll('img')].filter(visible).filter((image) => !image.hasAttribute('alt')).length;
      if (missingAlt) issues.push(`${missingAlt} visible image(s) have no alt text`);
      const smallText = [...document.querySelectorAll('body *')].filter(visible).filter((element) => {
        const style = window.getComputedStyle(element);
        return Number.parseFloat(style.fontSize) < 12 && (element.textContent ?? '').trim().length > 0;
      }).length;
      if (smallText > 3) issues.push(`${smallText} visible text element(s) are below 12px and may be difficult to scan`);
      const bodyStyle = window.getComputedStyle(body);
      const bodyContrast = contrast(bodyStyle.color, bodyStyle.backgroundColor);
      if (bodyContrast !== null && bodyContrast < 4.5) issues.push(`body text contrast is approximately ${bodyContrast.toFixed(1)}:1`);
      const fixedOverlays = [...document.querySelectorAll('*')].filter(visible).filter((element) => window.getComputedStyle(element).position === 'fixed').filter((element) => {
        const rect = (element as HTMLElement).getBoundingClientRect();
        return rect.width > viewport.width * 0.6 && rect.height > viewport.height * 0.35;
      });
      if (fixedOverlays.length && !document.querySelector('[role="dialog"][aria-modal="true"]')) issues.push('large fixed overlay has no modal semantics; check whether it should block or be repositioned');
      const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
      if (dialogs.some((dialog) => !dialog.getAttribute('aria-labelledby') && !dialog.textContent?.trim())) issues.push('visible dialog has no clear title or content');
      return { issues, viewport, fontFamily: bodyStyle.fontFamily };
    });
    console.log(`[HUMAN UX AUDIT] ${step} viewport=${audit.viewport.width}x${audit.viewport.height} font=${audit.fontFamily}`);
    for (const issue of audit.issues) {
      console.log(`[HUMAN UX FINDING] ${issue}`);
      this.findings.push({ severity: 'warning', message: `UX/layout: ${issue}`, url: this.page.url(), step });
    }
  }

  async clickSafe(label: string | RegExp): Promise<boolean> {
    const candidate = this.page.getByRole('button', { name: label }).or(this.page.getByRole('link', { name: label })).first();
    if (!(await candidate.isVisible({ timeout: 1500 }).catch(() => false))) return false;
    const name = compact(await candidate.textContent()) || String(label);
    if (isWriteOrDestructiveAction(name)) {
      console.log(`[HUMAN SKIP] Unsafe action: ${name}`);
      return false;
    }
    await candidate.click();
    await this.page.waitForLoadState('domcontentloaded').catch(() => undefined);
    await this.page.waitForTimeout(150);
    console.log(`[HUMAN CLICK] ${name}`);
    return true;
  }

  async fillSafeField(): Promise<boolean> {
    const field = this.page.locator('input:visible, textarea:visible').filter({ hasNot: this.page.locator('[type="password"]') }).first();
    if (!(await field.isVisible({ timeout: 1000 }).catch(() => false))) return false;
    const type = (await field.getAttribute('type') ?? 'text').toLowerCase();
    if (['password', 'file', 'hidden', 'checkbox', 'radio', 'button', 'submit'].includes(type)) return false;
    const name = `${await field.getAttribute('aria-label') ?? ''} ${await field.getAttribute('placeholder') ?? ''} ${await field.getAttribute('name') ?? ''}`.toLowerCase();
    let value = SAFE_SAMPLE_VALUES.text;
    if (type === 'date') value = '2026-09-12';
    else if (type === 'datetime-local') value = '2026-09-12T10:00';
    else if (type === 'time') value = '10:00';
    else if (type === 'number' || name.includes('number')) value = SAFE_SAMPLE_VALUES.number;
    else if (type === 'email' || name.includes('email')) value = SAFE_SAMPLE_VALUES.email;
    else if (name.includes('search')) value = SAFE_SAMPLE_VALUES.search;
    await field.fill(value);
    console.log(`[HUMAN TYPE] ${name.trim() || 'field'} (${type}) = ${value}`);
    return true;
  }

  async walkVisibleAdminNavigation(): Promise<void> {
    const navItems = this.page.locator('button.admin-nav-item:visible');
    const count = await navItems.count();
    console.log(`[HUMAN NAV] Found ${count} visible admin navigation items`);
    for (let index = 0; index < count; index += 1) {
      const item = navItems.nth(index);
      const label = compact(await item.textContent());
      if (!label || isWriteOrDestructiveAction(label)) continue;
      if (RESOURCE_INTENSIVE_ADMIN_ROUTES.has(label)) {
        this.findings.push({ severity: 'warning', message: `${label} was not opened during the broad navigation sweep because it is resource-intensive in the constrained browser runner.`, url: this.page.url(), step: 'admin navigation' });
        console.log(`[HUMAN NAV] skipped resource-intensive route: ${label}`);
        continue;
      }
      await item.click();
      await this.page.waitForTimeout(100);
      await this.observe(`admin navigation: ${label}`);
    }
  }

  async walkSafeTabsAndFields(): Promise<void> {
    const tabs = this.page.locator('[role="tab"]:visible');
    const tabCount = await tabs.count();
    for (let index = 0; index < tabCount; index += 1) {
      const tab = tabs.nth(index);
      const label = compact(await tab.textContent());
      if (!label || isWriteOrDestructiveAction(label)) continue;
      await tab.click();
      await this.page.waitForTimeout(150);
      await this.observe(`tab: ${label}`);
    }
    await this.fillSafeField();
  }

  async walkEveryVisibleButton(route: string): Promise<void> {
    await this.navigateTo(route);
    await this.page.waitForLoadState('domcontentloaded');
    await this.page.waitForTimeout(250);
    const pageButtons = this.page.locator('[data-app-content]').first().locator('button:visible');
    const buttons = await pageButtons.evaluateAll((elements) => {
      const occurrences = new Map<string, number>();
      return elements.map((element, index) => {
        const label = (element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '').replace(/\s+/g, ' ').trim();
        const occurrence = occurrences.get(label) ?? 0;
        occurrences.set(label, occurrence + 1);
        return { index, label, occurrence, disabled: (element as HTMLButtonElement).disabled };
      });
    });
    console.log(`[HUMAN BUTTON AUDIT] ${route}: ${buttons.length} visible page-content buttons; shell controls are covered by role navigation checks`);
    for (const button of buttons) {
      await this.navigateTo(route);
      await this.page.waitForLoadState('domcontentloaded');
      await this.page.waitForTimeout(150);
      const candidates = this.page.locator('[data-app-content]').first().locator('button:visible');
      const indexedButton = candidates.nth(button.index);
      const currentLabel = (await indexedButton.textContent().catch(() => null) ?? '').replace(/\s+/g, ' ').trim();
      const label = button.label || currentLabel || `button-${button.index}`;
      if (isWriteOrDestructiveAction(label)) {
        this.skippedActions.push({ route, index: button.index, label, reason: 'write-or-destructive' });
        console.log(`[HUMAN BUTTON SKIP] ${route} #${button.index} ${label || '(unnamed)'}: write/destructive action requires governed evidence`);
        continue;
      }
      let candidate = await this.findButtonByLabel(label, button.occurrence);
      if (!candidate) {
        await this.navigateTo(route);
        await this.page.waitForLoadState('domcontentloaded');
        await this.page.waitForTimeout(100);
        candidate = await this.findButtonByLabel(label, button.occurrence);
      }
      if (!candidate) {
        this.skippedActions.push({ route, index: button.index, label, reason: 'not-present-after-route-restore' });
        console.log(`[HUMAN BUTTON SKIP] ${route} #${button.index} ${label}: not present after route restore`);
        continue;
      }
      if (await candidate.isDisabled().catch(() => true)) {
        this.skippedActions.push({ route, index: button.index, label, reason: 'disabled' });
        console.log(`[HUMAN BUTTON SKIP] ${route} #${button.index} ${label}: disabled state verified`);
        continue;
      }
      const activeModal = this.page.locator('[role="dialog"][aria-modal="true"]:visible').last();
      if (await activeModal.isVisible({ timeout: 100 }).catch(() => false)
          && !(await candidate.evaluate((element) => Boolean(element.closest('[role="dialog"][aria-modal="true"]'))))) {
        this.skippedActions.push({ route, index: button.index, label, reason: 'covered-by-modal' });
        console.log(`[HUMAN BUTTON SKIP] ${route} #${button.index} ${label}: covered by an active modal`);
        continue;
      }
      await this.step(`button ${route} #${button.index}: ${label}`, async () => {
        await candidate.click({ timeout: 2000 });
        await this.page.waitForTimeout(100);
        const renderedText = compact(await this.page.locator('body').textContent(), 500);
        if (!renderedText) throw new Error(`Page became blank after clicking ${label}.`);
        console.log(`[HUMAN BUTTON RESULT] ${label} -> ${this.page.url()}`);
        await this.dismissSafeDialog();
        const bobPanel = this.page.getByLabel('Bob agent workspace');
        if (!route.includes('/bob') && await bobPanel.isVisible({ timeout: 250 }).catch(() => false)) {
          await bobPanel.getByRole('button', { name: 'Close Bob' }).click({ timeout: 2000 });
          await expect(bobPanel).toBeHidden({ timeout: 2000 });
        }
        const onRoute = () => {
          const current = new URL(this.page.url());
          const target = new URL(route, current);
          return current.pathname === target.pathname && current.search === target.search;
        };
        if (!onRoute()) {
          await this.navigateTo(route);
          await this.page.waitForLoadState('domcontentloaded');
        }
      });
    }
  }

  private async navigateTo(route: string): Promise<void> {
    const target = new URL(route, this.page.url());
    const current = new URL(this.page.url());
    const routeFamily = (pathname: string) => ['/admin', '/officer', '/client'].find((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
    const targetFamily = routeFamily(target.pathname);
    const currentFamily = routeFamily(current.pathname);
    if (target.origin === current.origin && targetFamily && targetFamily === currentFamily) {
      const destination = `${target.pathname}${target.search}${target.hash}`;
      const resetRoutes: Record<string, string[]> = {
        '/admin': ['/admin/hub', '/admin/approvals'],
        '/officer': ['/officer/schedule', '/officer/report'],
        '/client': ['/client', '/client/delivery'],
      };
      const intermediate = (resetRoutes[targetFamily] ?? []).find((path) => path !== target.pathname) ?? `${targetFamily}/`;
      await this.page.evaluate(async ({ intermediatePath, destinationPath }) => {
        const navigate = (path: string) => {
          window.history.pushState({}, '', path);
          window.dispatchEvent(new PopStateEvent('popstate'));
        };
        navigate(intermediatePath);
        await new Promise((resolve) => window.setTimeout(resolve, 40));
        navigate(destinationPath);
      }, { intermediatePath: intermediate, destinationPath: destination });
      await this.page.waitForTimeout(100);
      return;
    }
    await this.page.goto(route, { waitUntil: 'domcontentloaded', timeout: 10_000 });
  }

  private async findButtonByLabel(label: string, occurrence = 0) {
    const labels = await this.page.locator('[data-app-content]').first().locator('button:visible').evaluateAll((elements) => elements.map((element) => (element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '').replace(/\s+/g, ' ').trim()));
    const matchingIndexes = labels.flatMap((candidate, index) => candidate === label ? [index] : []);
    const index = matchingIndexes[occurrence] ?? -1;
    return index === -1 ? null : this.page.locator('[data-app-content]').first().locator('button:visible').nth(index);
  }

  private async dismissSafeDialog(): Promise<void> {
    const dialog = this.page.locator('[role="dialog"][aria-modal="true"]:visible').last();
    if (!(await dialog.isVisible({ timeout: 250 }).catch(() => false))) return;
    if (await dialog.getAttribute('aria-label') === 'Bob agent workspace') return;

    const heading = compact(await dialog.locator('h1, h2, h3').first().textContent().catch(() => null));
    const buttons = await dialog.getByRole('button').evaluateAll((elements) => elements.map((element) => (element.getAttribute('aria-label') || element.textContent || '').replace(/\s+/g, ' ').trim()));
    console.log(`[HUMAN DIALOG] ${heading || '(untitled)'}; buttons: ${buttons.join(' | ') || '(none)'}`);

    const dismiss = dialog.getByRole('button', { name: /^(?:cancel|back|not now|close(?:\b.*)?)$/i }).first();
    if (!(await dismiss.isVisible().catch(() => false))) {
      throw new Error(`Modal dialog "${heading || 'untitled'}" has no safe Cancel, Close, or Not now action.`);
    }
    await dismiss.click({ timeout: 2000 });
    await expect(dialog).toBeHidden({ timeout: 2000 });
  }

  async capture(label: string): Promise<void> {
    const safeLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'page';
    const path = this.testInfo.outputPath('human', `${String(this.steps.length + 1).padStart(2, '0')}-${safeLabel}.png`);
    await this.page.screenshot({ path, fullPage: true }).catch(() => undefined);
    await this.testInfo.attach(`human-${safeLabel}`, { path, contentType: 'image/png' }).catch(() => undefined);
  }

  async finish(): Promise<void> {
    for (const message of this.consoleErrors) {
      // The fixture server intentionally does not provide Supabase Realtime.
      // Keep real application errors fatal while ignoring that expected noise.
      if (/127\.0\.0\.1:54321\/realtime\/v1\/websocket.*ERR_CONNECTION_REFUSED/i.test(message)) continue;
      const severity = /ERR_INSUFFICIENT_RESOURCES/i.test(message) ? 'warning' : 'error';
      this.findings.push({ severity, message: `Browser console error: ${message}`, url: this.page.url(), step: this.currentStep });
    }
    for (const message of this.failedRequests) {
      this.findings.push({ severity: 'warning', message: `Failed request: ${message}`, url: this.page.url(), step: this.currentStep });
    }
    for (const message of this.httpErrors) {
      this.findings.push({ severity: 'error', message: `HTTP error response: ${message}`, url: this.page.url(), step: this.currentStep });
    }
    const uniqueFailedRequests = [...new Set(this.failedRequests)];
    const uniqueAbortedRequests = [...new Set(this.abortedRequests)];
    console.log(`[HUMAN REQUEST SUMMARY] ${this.failedRequests.length} failed requests (${uniqueFailedRequests.length} unique); ${this.abortedRequests.length} navigation-aborted (${uniqueAbortedRequests.length} unique); sample: ${uniqueFailedRequests.slice(0, 12).join(' | ') || '(none)'}`);
    const report = {
      generatedAt: now(),
      project: this.testInfo.project.name,
      title: this.testInfo.title,
      finalUrl: this.page.url(),
      steps: this.steps,
      findings: this.findings,
      skippedActions: this.skippedActions,
      consoleErrors: this.consoleErrors,
      abortedRequests: this.abortedRequests,
      failedRequests: this.failedRequests,
      httpErrors: this.httpErrors,
    };
    await this.testInfo.attach('human-test-report.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
    const errors = this.findings.filter((finding) => finding.severity === 'error');
    console.log(`\n[HUMAN SUMMARY] ${this.steps.length} steps, ${this.findings.length} findings, ${errors.length} errors`);
    expect(errors, 'Human test found browser errors or failed interactions').toEqual([]);
  }

  private async visibleLabels(selector: string): Promise<string[]> {
    return this.page.locator(`${selector}:visible`).evaluateAll((elements) => elements.map((element) => (element.textContent ?? element.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean));
  }

  private async visibleControls(): Promise<Array<{ kind: string; label: string; disabled: boolean; action: 'safe' | 'write-or-destructive' }>> {
    const controls = await this.page.locator('button:visible, a:visible, input:visible, textarea:visible, select:visible').evaluateAll((elements) => elements.map((element) => {
      const control = element as HTMLInputElement;
      const parentLabel = element.closest('label')?.textContent ?? '';
      const label = (element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || control.placeholder || parentLabel).replace(/\s+/g, ' ').trim();
      return { kind: element.tagName.toLowerCase(), label, disabled: Boolean(control.disabled) };
    }));
    return controls.map((control) => ({
      ...control,
      action: isWriteOrDestructiveAction(control.label) ? 'write-or-destructive' : 'safe',
    }));
  }
}
