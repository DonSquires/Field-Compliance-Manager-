import { describe, expect, it } from 'vitest';
import {
  analyseFramePixels,
  cssFilterFor,
  enhancementReadout,
  estimateNoiseFloor,
  MONO_CHROMA_THRESHOLD,
  NEUTRAL_PLAN,
  panBy,
  planEnhancement,
  roiFor,
  zoomAt,
} from './cctvEnhance';

function frame(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = pixel(x, y);
      data.set([red, green, blue, 255], (y * width + x) * 4);
    }
  }
  return data;
}

const manual = { brightness: 100, contrast: 100, saturation: 100, detail: 100 };
let seed = 7;
const noise = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return (seed / 2 ** 31 - 0.5) * 60; };

describe('frame analysis', () => {
  it('measures a dark, low-contrast night scene as needing a lift', () => {
    const stats = analyseFramePixels(frame(96, 54, (x) => [20 + (x % 30), 22 + (x % 30), 20 + (x % 30)]), 96, 54);
    expect(stats).not.toBeNull();
    expect(stats!.p50).toBeLessThan(60);
    expect(stats!.p99).toBeLessThan(80);
    expect(stats!.mono).toBe(true);
    expect(stats!.gains).toEqual([1, 1, 1]);
    const plan = planEnhancement(stats, { zoom: 1, smoothing: 1 });
    expect(plan.gamma).toBeLessThan(1);
    // Luminance spans 20–79: a full stretch would exceed the 2.5x cap, so the cap sets the white point.
    expect(plan.whitePoint).toBeCloseTo(Math.min(1, Math.max(stats!.p99 / 255, plan.blackPoint + 0.4) + 0.02), 5);
    const stretch = 1 / (plan.whitePoint - plan.blackPoint);
    expect(stretch).toBeGreaterThan(1.8);
    expect(stretch).toBeLessThanOrEqual(2.5 + 1e-6);
    expect(plan.blackPoint).toBeGreaterThanOrEqual(0);
    expect(plan.saturation).toBe(0);
  });

  it('detects colour casts and corrects them with bounded grey-world gains', () => {
    const stats = analyseFramePixels(frame(96, 54, (x, y) => [60 + (x % 90), 100 + (y % 60), 160 + ((x + y) % 40)]), 96, 54)!;
    expect(stats.chroma).toBeGreaterThan(MONO_CHROMA_THRESHOLD);
    expect(stats.gains[0]).toBeGreaterThan(stats.gains[2]);
    expect(Math.max(...stats.gains)).toBeLessThanOrEqual(1.2);
    expect(Math.min(...stats.gains)).toBeGreaterThanOrEqual(0.85);
  });

  it('keeps a dim warm colour scene in colour while treating true infrared as mono', () => {
    const dimWarm = analyseFramePixels(frame(96, 54, (x) => { const base = 24 + (x % 20); return [base * 1.18, base, base * 0.82]; }), 96, 54)!;
    expect(dimWarm.mono).toBe(false);
    expect(dimWarm.gains[0]).toBeLessThan(1);
    expect(dimWarm.gains[2]).toBeGreaterThan(1);
    const infrared = analyseFramePixels(frame(96, 54, (x, y) => { const base = 30 + ((x * 7 + y * 3) % 90); return [base + 2, base, base + 1]; }), 96, 54)!;
    expect(infrared.mono).toBe(true);
    expect(infrared.gains).toEqual([1, 1, 1]);
  });

  it('removes the uniform pink cast produced by an IR-cut filter', () => {
    const pinkIr = analyseFramePixels(frame(96, 54, (x, y) => {
      const base = 32 + ((x * 5 + y * 3) % 70);
      return [base * 1.35, base * 0.72, base * 1.22];
    }), 96, 54)!;
    expect(pinkIr.chroma).toBeGreaterThan(MONO_CHROMA_THRESHOLD);
    expect(pinkIr.mono).toBe(true);
    const plan = planEnhancement(pinkIr, { zoom: 1, smoothing: 1 });
    expect(plan.saturation).toBe(0);
    expect(plan.gains).toEqual([1, 1, 1]);
  });

  it('keeps real magenta and mixed-colour footage in colour', () => {
    const daylightMagenta = analyseFramePixels(frame(96, 54, (x, y) => {
      const detail = (x * 3 + y * 5) % 45;
      return [205 + detail, 105 + detail / 2, 190 + detail];
    }), 96, 54)!;
    expect(daylightMagenta.mono).toBe(false);

    const mixedNightColour = analyseFramePixels(frame(96, 54, (x, y) => {
      const base = 25 + ((x + y) % 25);
      return x < 48 ? [base * 1.35, base * 0.72, base * 1.2] : [base * 0.75, base * 1.3, base * 0.8];
    }), 96, 54)!;
    expect(mixedNightColour.mono).toBe(false);
  });

  it('estimates sensor noise and trades sharpening for denoising when it is present', () => {
    const clean = analyseFramePixels(frame(96, 54, (x) => [80 + (x % 50), 80 + (x % 50), 80 + (x % 50)]), 96, 54)!;
    const noisy = analyseFramePixels(frame(96, 54, (x) => { const n = noise(); return [80 + (x % 50) + n, 80 + (x % 50) + n, 80 + (x % 50) + n]; }), 96, 54)!;
    expect(noisy.noise).toBeGreaterThan(clean.noise);
    const cleanPlan = planEnhancement(clean, { zoom: 2, smoothing: 1 });
    const noisyPlan = planEnhancement(noisy, { zoom: 2, smoothing: 1 });
    expect(noisyPlan.denoise).toBeGreaterThan(cleanPlan.denoise);
    expect(noisyPlan.sharpen).toBeLessThan(cleanPlan.sharpen);
  });

  it('rejects unusable samples and never stretches a flat scene beyond its limit', () => {
    expect(analyseFramePixels(new Uint8ClampedArray(4 * 4 * 4), 4, 4)).toBeNull();
    const flat = analyseFramePixels(frame(96, 54, () => [128, 128, 128]), 96, 54)!;
    const plan = planEnhancement(flat, { zoom: 1, smoothing: 1 });
    expect(1 / (plan.whitePoint - plan.blackPoint)).toBeLessThanOrEqual(2.5 + 1e-6);
  });

  it('separates sensor noise from scene texture with the block-wise floor and leaves daylight tonality alone', () => {
    // Coarse texture (foliage-like) with a flat sky band: the floor should stay low.
    const textured = estimateNoiseFloor(frame(128, 128, (x, y) => { const t = y < 40 ? 200 : 60 + ((x * 13 + y * 7) % 90); return [t, t, t]; }), 128, 128)!;
    seed = 11;
    const grainy = estimateNoiseFloor(frame(128, 128, (x, y) => { const t = (y < 40 ? 200 : 60 + ((x * 13 + y * 7) % 90)) + noise(); return [t, t, t]; }), 128, 128)!;
    expect(textured).toBeLessThan(0.15);
    expect(grainy).toBeGreaterThan(textured + 0.2);
    expect(estimateNoiseFloor(new Uint8ClampedArray(8 * 8 * 4), 8, 8)).toBeNull();
    const daylight = analyseFramePixels(frame(96, 54, (x, y) => [90 + (x % 120), 100 + (y % 100), 80 + ((x + y) % 110)]), 96, 54, textured)!;
    const dayPlan = planEnhancement(daylight, { zoom: 1, smoothing: 1 });
    expect(dayPlan.gamma).toBeGreaterThan(0.9);
    expect(dayPlan.gamma).toBeLessThanOrEqual(1.15);
    expect(daylight.noise).toBe(textured);
  });
});

describe('temporal smoothing and zoom geometry', () => {
  it('eases towards a new target instead of flickering', () => {
    const dark = analyseFramePixels(frame(96, 54, () => [20, 20, 20]), 96, 54);
    const bright = analyseFramePixels(frame(96, 54, (x) => [120 + (x % 100), 120 + (x % 100), 120 + (x % 100)]), 96, 54);
    const first = planEnhancement(dark, { zoom: 1, smoothing: 1 });
    const eased = planEnhancement(bright, { zoom: 1, previous: first, smoothing: 0.3 });
    const target = planEnhancement(bright, { zoom: 1, smoothing: 1 });
    expect(Math.abs(eased.gamma - first.gamma)).toBeLessThan(Math.abs(target.gamma - first.gamma));
    expect(planEnhancement(null, { zoom: 3, smoothing: 1 }).sharpen).toBeGreaterThan(planEnhancement(null, { zoom: 1, smoothing: 1 }).sharpen);
  });

  it('derives the visible region from zoom and focus and keeps it inside the frame', () => {
    expect(roiFor(1, 50, 50)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(roiFor(2, 50, 50)).toEqual({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
    expect(roiFor(4, 100, 0)).toEqual({ x: 0.75, y: 0, width: 0.25, height: 0.25 });
  });

  it('zooms about the pointer and pans without leaving the frame', () => {
    const zoomed = zoomAt({ zoom: 1, focusX: 50, focusY: 50 }, 2, 75, 25);
    expect(zoomed.zoom).toBe(2);
    const roi = roiFor(zoomed.zoom, zoomed.focusX, zoomed.focusY);
    expect(roi.x + 0.75 * roi.width).toBeCloseTo(0.75, 5);
    expect(roi.y + 0.25 * roi.height).toBeCloseTo(0.25, 5);
    const panned = panBy(zoomed, 0.5, 0.5);
    expect(panned.focusX).toBeLessThan(zoomed.focusX);
    expect(panned.focusX).toBeGreaterThanOrEqual(0);
    expect(panBy({ zoom: 1, focusX: 50, focusY: 50 }, 0.5, 0)).toEqual({ zoom: 1, focusX: 50, focusY: 50 });
  });

  it('degrades to a CSS filter and explains the active plan in words', () => {
    expect(cssFilterFor(null, manual)).toBe('brightness(1.000) contrast(1.000) saturate(1.000)');
    expect(cssFilterFor({ ...NEUTRAL_PLAN, blackPoint: 0.1, whitePoint: 0.6, gamma: 0.7, mono: true }, manual)).toMatch(/contrast\(2\.000\) saturate\(0\.000\)/);
    expect(enhancementReadout(null)).toBe('Measuring the picture…');
    expect(enhancementReadout({ ...NEUTRAL_PLAN, mono: true })).toContain('Infrared (mono)');
  });
});
