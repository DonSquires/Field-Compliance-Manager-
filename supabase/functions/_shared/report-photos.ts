// Photos for client report PDFs. The frozen activity snapshot carries storage
// references ({ b: bucket, p: path }) for the photos taken with each entry; this
// module turns the first few into small JPEGs that pdf-lib can embed cheaply.
// Stored site photos are mostly RGBA PNGs, which pdf-lib embeds losslessly at
// roughly 25 ms of CPU and 300 KB each, so they are converted to JPEG within a
// fixed CPU budget. Anything not embedded is reported as "held on file".
import { Image } from 'https://deno.land/x/imagescript@1.3.0/mod.ts';
import type { ReportPhotoRef } from './report-activity-sections.ts';

export const REPORT_PHOTO_BUCKETS: readonly string[] = ['bob-uploads', 'scans'];
export const REPORT_PHOTO_WIDTH = 320;
const REPORT_PHOTO_QUALITY = 72;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const FETCH_CONCURRENCY = 6;
const CONVERT_BUDGET_MS = 700;

interface StorageDownloader {
  storage: {
    from(bucket: string): {
      download(path: string, options?: { transform?: { width?: number; quality?: number } }): Promise<{ data: Blob | null; error: unknown }>;
    };
  };
}

export const reportPhotoKey = (ref: ReportPhotoRef) => `${ref.b}/${ref.p}`;

export const isJpeg = (bytes: Uint8Array) => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
export const isPng = (bytes: Uint8Array) => bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;

// Only buckets that hold site photos are read, and the hinted bucket is tried
// first: observation supporting evidence has lived in both over time.
function candidateBuckets(ref: ReportPhotoRef) {
  return [ref.b, ...REPORT_PHOTO_BUCKETS].filter((bucket, index, all) => REPORT_PHOTO_BUCKETS.includes(bucket) && all.indexOf(bucket) === index);
}

async function fetchPhoto(client: StorageDownloader, ref: ReportPhotoRef): Promise<Uint8Array | null> {
  if (!ref.p || /^[a-z][a-z0-9+.-]*:\/\//i.test(ref.p) || ref.p.includes('..')) return null;
  for (const bucket of candidateBuckets(ref)) {
    for (const options of [{ transform: { width: REPORT_PHOTO_WIDTH, quality: 70 } }, undefined]) {
      try {
        const { data, error } = await client.storage.from(bucket).download(ref.p, options);
        if (error || !data || data.size > MAX_SOURCE_BYTES) continue;
        return new Uint8Array(await data.arrayBuffer());
      } catch {
        continue;
      }
    }
  }
  return null;
}

async function toJpeg(bytes: Uint8Array, budget: { spentMs: number }): Promise<Uint8Array | null> {
  if (isJpeg(bytes)) return bytes;
  if (!isPng(bytes) || budget.spentMs >= CONVERT_BUDGET_MS) return null;
  const started = performance.now();
  try {
    const image = await Image.decode(bytes);
    if (!(image instanceof Image)) return null;
    if (image.width > REPORT_PHOTO_WIDTH * 1.25) image.resize(REPORT_PHOTO_WIDTH, Image.RESIZE_AUTO);
    return await image.encodeJPEG(REPORT_PHOTO_QUALITY);
  } catch {
    return null;
  } finally {
    budget.spentMs += performance.now() - started;
  }
}

/**
 * Downloads and converts report photos in report order. Returns JPEG bytes by
 * reportPhotoKey; a photo that cannot be read or would exceed the CPU budget is
 * simply absent, and the PDF says it is held on file.
 */
export async function loadReportPhotos(client: StorageDownloader, refs: ReportPhotoRef[]): Promise<Map<string, Uint8Array>> {
  const sources: Array<Uint8Array | null> = new Array(refs.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < refs.length) {
      const index = next++;
      sources[index] = await fetchPhoto(client, refs[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, refs.length) }, worker));
  const budget = { spentMs: 0 };
  const photos = new Map<string, Uint8Array>();
  for (const [index, source] of sources.entries()) {
    if (!source) continue;
    const jpeg = await toJpeg(source, budget);
    if (jpeg) photos.set(reportPhotoKey(refs[index]), jpeg);
  }
  return photos;
}
