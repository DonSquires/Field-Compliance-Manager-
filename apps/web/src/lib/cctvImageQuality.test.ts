import { describe, expect, it } from 'vitest';
import { assessReportImagePixels } from './cctvImageQuality';

function image(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const [red, green, blue] = pixel(x, y);
      data.set([red, green, blue, 255], offset);
    }
  }
  return data;
}

describe('assessReportImagePixels', () => {
  it('accepts a varied, balanced entity photograph', () => {
    const pixels = image(160, 90, (x, y) => [40 + (x % 100), 50 + (y % 90), 60 + ((x + y) % 80)]);
    expect(assessReportImagePixels(pixels, 160, 90)).toEqual({ usable: true, reason: 'usable' });
  });

  it('rejects blank and glare-dominated frames', () => {
    const blank = image(160, 90, () => [18, 18, 18]);
    const glare = image(160, 90, (x) => x < 140 ? [255, 255, 255] : [80, 85, 90]);
    expect(assessReportImagePixels(blank, 160, 90).usable).toBe(false);
    expect(assessReportImagePixels(glare, 160, 90).usable).toBe(false);
  });

  it('rejects severe green corruption and undersized images', () => {
    const corrupt = image(160, 90, (x, y) => y > 40 ? [0, 220, 0] : [10 + (x % 20), 15, 10]);
    expect(assessReportImagePixels(corrupt, 160, 90)).toEqual({ usable: false, reason: 'dominant_colour_cast' });
    expect(assessReportImagePixels(new Uint8ClampedArray(20 * 20 * 4), 20, 20)).toEqual({ usable: false, reason: 'too_small' });
  });
});
