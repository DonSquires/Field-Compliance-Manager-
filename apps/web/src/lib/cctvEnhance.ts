/**
 * cctvEnhance.ts — auto digital enhancement for the CCTV review console.
 *
 * Pure analysis and planning. A small nearest-neighbour sample of the zoomed region is measured every few
 * frames; the plan it produces (levels, gamma, white balance, local contrast, denoise, sharpening) drives
 * the WebGL pipeline in cctvEnhanceRenderer.ts. Everything here is display-only: the stored evidence is
 * never rewritten, and the console labels the enhanced view so a still from it is never mistaken for the
 * original recording.
 */

export type FrameStats = {
  width: number;
  height: number;
  /** Luminance percentiles, 0–255. */
  p1: number;
  p50: number;
  p99: number;
  mean: number;
  /** Fraction of pixels crushed to black / blown to white. */
  clipLow: number;
  clipHigh: number;
  /** Brightness-weighted saturation 0–1; infrared night footage sits near zero at any exposure. */
  chroma: number;
  /** Grey-world white-balance gains, clamped. */
  gains: [number, number, number];
  /** Sensor noise estimate 0–1 (robust median Laplacian). */
  noise: number;
  mono: boolean;
};

export type EnhancementPlan = {
  blackPoint: number;
  whitePoint: number;
  /** < 1 lifts mid-tones. */
  gamma: number;
  gains: [number, number, number];
  saturation: number;
  localContrast: number;
  denoise: number;
  sharpen: number;
  mono: boolean;
};

export type ManualAdjustments = {
  brightness: number;
  contrast: number;
  saturation: number;
  detail: number;
};

export type Roi = { x: number; y: number; width: number; height: number };

export const NEUTRAL_PLAN: EnhancementPlan = {
  blackPoint: 0,
  whitePoint: 1,
  gamma: 1,
  gains: [1, 1, 1],
  saturation: 1,
  localContrast: 0,
  denoise: 0,
  sharpen: 0,
  mono: false,
};

export const MONO_CHROMA_THRESHOLD = 0.08;
const MAX_LEVEL_STRETCH = 2.5;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function percentile(histogram: Uint32Array, total: number, fraction: number): number {
  const target = total * fraction;
  let seen = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    seen += histogram[value];
    if (seen >= target) return value;
  }
  return histogram.length - 1;
}

export function analyseFramePixels(pixels: Uint8ClampedArray, width: number, height: number, noiseFloor?: number | null): FrameStats | null {
  const count = width * height;
  if (width < 8 || height < 8 || pixels.length < count * 4) return null;
  const luminance = new Float32Array(count);
  const histogram = new Uint32Array(256);
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumLum = 0;
  let chromaSum = 0;
  let maxSum = 0;
  let clipLow = 0;
  let clipHigh = 0;
  for (let index = 0; index < count; index += 1) {
    const offset = index * 4;
    const r = pixels[offset];
    const g = pixels[offset + 1];
    const b = pixels[offset + 2];
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    luminance[index] = lum;
    histogram[Math.round(lum)] += 1;
    sumR += r;
    sumG += g;
    sumB += b;
    sumLum += lum;
    const brightest = Math.max(r, g, b);
    chromaSum += brightest - Math.min(r, g, b);
    maxSum += brightest;
    if (lum <= 2) clipLow += 1;
    if (lum >= 253) clipHigh += 1;
  }
  // Fallback when no native-resolution patch is supplied: median absolute Laplacian of the sample.
  const laplacian = new Uint32Array(256);
  let interior = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const centre = luminance[index];
      const response = Math.abs(4 * centre - luminance[index - 1] - luminance[index + 1] - luminance[index - width] - luminance[index + width]) / 4;
      laplacian[Math.min(255, Math.round(response))] += 1;
      interior += 1;
    }
  }
  const medianLaplacian = interior ? percentile(laplacian, interior, 0.5) : 0;
  const sampledNoise = clamp((medianLaplacian - 0.5) / 8, 0, 1);
  const meanR = sumR / count;
  const meanG = sumG / count;
  const meanB = sumB / count;
  const grey = (meanR + meanG + meanB) / 3;
  // Brightness-weighted saturation: infrared footage is grey at any exposure, a dim colour scene is not.
  const meanChroma = chromaSum / Math.max(1, maxSum);
  const mono = meanChroma < MONO_CHROMA_THRESHOLD;
  const gain = (channel: number) => clamp(grey / Math.max(1, channel), 0.85, 1.2);
  return {
    width,
    height,
    p1: percentile(histogram, count, 0.01),
    p50: percentile(histogram, count, 0.5),
    p99: percentile(histogram, count, 0.99),
    mean: sumLum / count,
    clipLow: clipLow / count,
    clipHigh: clipHigh / count,
    chroma: meanChroma,
    gains: mono ? [1, 1, 1] : [gain(meanR), gain(meanG), gain(meanB)],
    noise: typeof noiseFloor === 'number' && Number.isFinite(noiseFloor) ? clamp(noiseFloor, 0, 1) : sampledNoise,
    mono,
  };
}

/**
 * Sensor noise floor from a native-resolution patch: the frame is cut into 8x8 blocks, each block's median
 * absolute Laplacian is taken, and the 10th-percentile block wins. Texture (foliage, gravel) raises most
 * blocks but not the flattest ones; sensor noise raises every block, so the flattest block tracks it.
 */
export function estimateNoiseFloor(pixels: Uint8ClampedArray, width: number, height: number): number | null {
  const block = 8;
  const columns = Math.floor(width / block);
  const rows = Math.floor(height / block);
  if (columns < 2 || rows < 2 || pixels.length < width * height * 4) return null;
  const luminance = new Float32Array(width * height);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    luminance[index] = 0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2];
  }
  const blockMedians: number[] = [];
  const responses: number[] = [];
  for (let by = 0; by < rows; by += 1) {
    for (let bx = 0; bx < columns; bx += 1) {
      responses.length = 0;
      for (let y = by * block + 1; y < (by + 1) * block - 1; y += 1) {
        for (let x = bx * block + 1; x < (bx + 1) * block - 1; x += 1) {
          const index = y * width + x;
          responses.push(Math.abs(4 * luminance[index] - luminance[index - 1] - luminance[index + 1] - luminance[index - width] - luminance[index + width]) / 4);
        }
      }
      responses.sort((a, b) => a - b);
      blockMedians.push(responses[Math.floor(responses.length / 2)]);
    }
  }
  blockMedians.sort((a, b) => a - b);
  const floor = blockMedians[Math.floor(blockMedians.length * 0.1)];
  return clamp((floor - 0.4) / 6, 0, 1);
}

function lerp(from: number, to: number, alpha: number): number {
  return from + (to - from) * alpha;
}

export function planEnhancement(stats: FrameStats | null, options: { zoom: number; previous?: EnhancementPlan | null; smoothing?: number }): EnhancementPlan {
  const zoom = clamp(options.zoom, 1, 4);
  const zoomFactor = (zoom - 1) / 3;
  let target: EnhancementPlan;
  if (!stats) {
    target = { ...NEUTRAL_PLAN, sharpen: 0.25 + 0.35 * zoomFactor, localContrast: 0.15, denoise: 0.15 * zoomFactor };
  } else {
    const low = stats.p1 / 255;
    const high = stats.p99 / 255;
    const blackPoint = Math.min(low, 0.35);
    // Never stretch a flat scene (fog, glare) by more than 2.5x; keep a little highlight headroom.
    const whitePoint = Math.min(1, Math.max(high, blackPoint + 1 / MAX_LEVEL_STRETCH) + 0.02);
    const midNormalised = clamp((stats.p50 / 255 - blackPoint) / (whitePoint - blackPoint), 0.02, 0.98);
    // Lift mid-tones in proportion to how dark the scene is; a daylight scene keeps its tonality.
    const lift = clamp((0.4 - midNormalised) / 0.3, 0, 1);
    const targetMid = midNormalised + (0.45 - midNormalised) * lift;
    let gamma = clamp(Math.log(targetMid) / Math.log(midNormalised), 0.55, 1.15);
    if (stats.clipHigh > 0.05) gamma = Math.max(gamma, 0.85);
    const compressed = clamp(1 - (high - low) / 0.7, 0, 1);
    const localContrast = clamp(0.25 + 0.3 * compressed + 0.2 * zoomFactor - 0.8 * stats.clipHigh, 0.1, 0.75);
    const denoise = clamp(stats.noise * 1.1 + 0.12 * zoomFactor, 0, 1);
    const sharpen = clamp((0.35 + 0.5 * zoomFactor) * (1 - 0.65 * stats.noise), 0.05, 1.2);
    const saturation = stats.mono ? 0 : 1 + 0.15 * (1 - clamp(stats.chroma / 0.25, 0, 1));
    target = { blackPoint, whitePoint, gamma, gains: stats.mono ? [1, 1, 1] : stats.gains, saturation, localContrast, denoise, sharpen, mono: stats.mono };
  }
  const alpha = clamp(options.smoothing ?? 0.3, 0, 1);
  const previous = options.previous;
  if (!previous || alpha >= 1) return target;
  return {
    blackPoint: lerp(previous.blackPoint, target.blackPoint, alpha),
    whitePoint: lerp(previous.whitePoint, target.whitePoint, alpha),
    gamma: lerp(previous.gamma, target.gamma, alpha),
    gains: [lerp(previous.gains[0], target.gains[0], alpha), lerp(previous.gains[1], target.gains[1], alpha), lerp(previous.gains[2], target.gains[2], alpha)],
    saturation: lerp(previous.saturation, target.saturation, alpha),
    localContrast: lerp(previous.localContrast, target.localContrast, alpha),
    denoise: lerp(previous.denoise, target.denoise, alpha),
    sharpen: lerp(previous.sharpen, target.sharpen, alpha),
    mono: target.mono,
  };
}

/** CSS approximation used when the GPU path is unavailable; gamma and local contrast cannot be expressed in CSS. */
export function cssFilterFor(plan: EnhancementPlan | null, manual: ManualAdjustments): string {
  let brightness = manual.brightness / 100;
  let contrast = manual.contrast / 100;
  let saturation = manual.saturation / 100;
  if (plan) {
    const stretch = clamp(1 / Math.max(0.05, plan.whitePoint - plan.blackPoint), 1, 2.2);
    contrast *= stretch;
    brightness *= clamp(Math.pow(0.5, plan.gamma - 1) * (1 - plan.blackPoint * 0.5), 0.7, 1.8);
    saturation *= plan.mono ? 0 : plan.saturation;
  }
  return `brightness(${brightness.toFixed(3)}) contrast(${contrast.toFixed(3)}) saturate(${saturation.toFixed(3)})`;
}

/** Source region shown at a zoom with the transform-origin at (focusX%, focusY%). */
export function roiFor(zoom: number, focusX: number, focusY: number): Roi {
  const scale = clamp(zoom, 1, 4);
  const width = 1 / scale;
  const fx = clamp(focusX / 100, 0, 1);
  const fy = clamp(focusY / 100, 0, 1);
  return { x: fx * (1 - width), y: fy * (1 - width), width, height: width };
}

export type ZoomState = { zoom: number; focusX: number; focusY: number };

/** Re-zoom so the frame point under the pointer (tile coordinates, 0–100) stays under the pointer. */
export function zoomAt(current: ZoomState, zoom: number, pointX: number, pointY: number): ZoomState {
  const next = clamp(zoom, 1, 4);
  const axis = (focus: number, point: number) => {
    const f = clamp(focus / 100, 0, 1);
    const s = clamp(point / 100, 0, 1);
    const framePoint = f + (s - f) / current.zoom;
    if (next === 1) return framePoint * 100;
    return clamp((s - framePoint * next) / (1 - next), 0, 1) * 100;
  };
  return { zoom: next, focusX: axis(current.focusX, pointX), focusY: axis(current.focusY, pointY) };
}

/** Drag the zoomed view by a fraction of the tile (positive moves the picture right / down). */
export function panBy(current: ZoomState, deltaX: number, deltaY: number): ZoomState {
  if (current.zoom <= 1) return current;
  const shift = (focus: number, delta: number) => clamp(focus / 100 + delta / (1 - current.zoom), 0, 1) * 100;
  return { zoom: current.zoom, focusX: shift(current.focusX, deltaX), focusY: shift(current.focusY, deltaY) };
}

export function enhancementReadout(plan: EnhancementPlan | null): string {
  if (!plan) return 'Measuring the picture…';
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  const gains = plan.gains.map((gain) => gain.toFixed(2)).join('/');
  return `${plan.mono ? 'Infrared (mono) · ' : ''}levels ${percent(plan.blackPoint)}–${percent(plan.whitePoint)} · gamma ${plan.gamma.toFixed(2)} · white balance ${gains} · local contrast ${percent(plan.localContrast)} · denoise ${percent(plan.denoise)} · sharpen ${percent(plan.sharpen)}`;
}
