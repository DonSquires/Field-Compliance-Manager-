export type ReportEntityKind = 'person' | 'vehicle' | 'animal';

export type ReportEvidenceImage = {
  kind: ReportEntityKind;
  src: string;
  label: string;
  timestampSeconds: number;
  sha256Hash: string;
  reviewState: string;
};

export type ImageQualityAssessment = {
  usable: boolean;
  reason: 'usable' | 'too_small' | 'near_uniform' | 'underexposed' | 'overexposed_glare' | 'dominant_colour_cast' | 'decode_failed';
};

export function assessReportImagePixels(pixels: Uint8ClampedArray, width: number, height: number): ImageQualityAssessment {
  if (width < 96 || height < 54 || pixels.length < width * height * 4) return { usable: false, reason: 'too_small' };

  let red = 0;
  let green = 0;
  let blue = 0;
  let luminance = 0;
  let luminanceSquared = 0;
  let nearBlack = 0;
  let nearWhite = 0;
  const pixelCount = width * height;
  for (let index = 0; index < pixelCount * 4; index += 4) {
    const r = pixels[index];
    const g = pixels[index + 1];
    const b = pixels[index + 2];
    const value = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    red += r;
    green += g;
    blue += b;
    luminance += value;
    luminanceSquared += value * value;
    if (value < 12) nearBlack += 1;
    if (value > 245 && Math.max(r, g, b) - Math.min(r, g, b) < 20) nearWhite += 1;
  }

  const mean = luminance / pixelCount;
  const contrast = Math.sqrt(Math.max(0, luminanceSquared / pixelCount - mean * mean));
  if (contrast < 5) return { usable: false, reason: 'near_uniform' };
  if (nearBlack / pixelCount > 0.88) return { usable: false, reason: 'underexposed' };
  if (nearWhite / pixelCount > 0.72) return { usable: false, reason: 'overexposed_glare' };

  const channelMeans = [red / pixelCount, green / pixelCount, blue / pixelCount].sort((first, second) => second - first);
  const otherChannelMean = Math.max(1, (channelMeans[1] + channelMeans[2]) / 2);
  if (channelMeans[0] / otherChannelMean >= 1.8) return { usable: false, reason: 'dominant_colour_cast' };
  return { usable: true, reason: 'usable' };
}

export async function filterUsableReportImages(images: ReportEvidenceImage[], limit = 6): Promise<ReportEvidenceImage[]> {
  const assessments = await Promise.all(images.map(async (image) => {
    if (!image.src.startsWith('data:image/')) return { image, usable: false };
    try {
      const decoded = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error('image decode failed'));
        element.src = image.src;
      });
      const canvas = document.createElement('canvas');
      canvas.width = decoded.naturalWidth;
      canvas.height = decoded.naturalHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return { image, usable: false };
      context.drawImage(decoded, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      return { image, usable: assessReportImagePixels(pixels, canvas.width, canvas.height).usable };
    } catch {
      return { image, usable: false };
    }
  }));
  return assessments.filter((entry) => entry.usable).map((entry) => entry.image).slice(0, limit);
}
