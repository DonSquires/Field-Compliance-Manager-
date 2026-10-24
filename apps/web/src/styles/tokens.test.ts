import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), 'src', path), 'utf8');
const tokens = new Map([...read('styles/tokens.css').matchAll(/(--[\w-]+):\s*([^;]+);/g)]
  .map((match) => [match[1], match[2].trim()]));

function color(name: string, seen = new Set<string>()): string {
  if (seen.has(name)) throw new Error(`Cyclic token ${name}`);
  seen.add(name);
  const value = tokens.get(name);
  if (!value) throw new Error(`Missing token ${name}`);
  const alias = /^var\((--[\w-]+)\)$/.exec(value);
  return alias ? color(alias[1], seen) : value;
}

function contrast(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    if (!/^#[\da-f]{6}$/i.test(hex)) throw new Error(`Expected opaque hex color: ${hex}`);
    const linear = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255)
      .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return linear.reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  };
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

describe('shared dark token contract', () => {
  for (const path of ['pages/PageStyles.css', 'pages/ClientPortalPage.css']) {
    it(`${path} uses defined tokens rather than a local palette`, () => {
      const source = read(path);
      expect(source).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(|(?:color|background):\s*(?:white|black)\b/i);
      expect(source).not.toContain("data-theme='light'");
      for (const match of source.matchAll(/var\((--[\w-]+)/g)) {
        expect(tokens.has(match[1]), `${path}: ${match[1]}`).toBe(true);
      }
    });
  }

  for (const [text, background] of [
    ['--color-primary-text', '--color-primary'],
    ['--color-primary-text', '--color-primary-hover'],
    ['--color-action-danger-text', '--color-action-danger-bg'],
    ['--color-action-danger-text', '--color-action-danger-hover'],
    ['--color-status-critical-text', '--color-status-critical-bg'],
    ['--color-status-critical-text', '--color-bg-elevated'],
    ['--color-info', '--color-info-bg'],
    ['--color-text-muted', '--color-bg-elevated'],
    ['--color-state-selected-text', '--color-state-selected-bg'],
    ['--color-plate-text', '--color-plate-bg'],
  ]) {
    it(`${text} is readable on ${background}`, () => {
      expect(contrast(color(text), color(background))).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('keeps competing primary and danger button rules on the same foreground/background pair', () => {
    for (const path of ['styles/global.css', 'pages/PageStyles.css']) {
      const source = read(path);
      expect(source).toMatch(/\.btn-primary\s*\{[^}]*var\(--color-primary\)[^}]*color:\s*var\(--color-primary-text\)/);
      expect(source).toMatch(/\.btn-danger\s*\{[^}]*var\(--color-action-danger-bg\)[^}]*color:\s*var\(--color-action-danger-text\)/);
    }
  });

  it('does not use dark console backgrounds as text or focus-ring colors', () => {
    for (const path of ['shells/AdminShell.css', 'pages/FieldOperationsPage.css']) {
      expect(read(path)).not.toMatch(/(?:\bcolor|outline):[^;{}]*var\(--console-action\)/);
    }
  });

  it('keeps off-site safety advice and welfare telemetry on the critical-text pair', () => {
    expect(read('components/PlaceContextBanner.css')).toMatch(/\.place-context-banner\.is-outside_geofence\s*\{[^}]*color:\s*var\(--color-status-critical-text\)/);
    expect(read('shells/AdminShell.css')).toMatch(/\.admin-console-pill\.is-critical\s*\{[^}]*color:\s*var\(--color-status-critical-text\)/);
  });
});
