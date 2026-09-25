import { createRequire } from 'node:module';

const requireFromWeb = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { chromium } = requireFromWeb('playwright');
const baseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!baseUrl || !serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

async function rpc(name, body) {
  const response = await fetch(`${baseUrl}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${name} failed (${response.status}): ${result?.message ?? 'unknown error'}`);
  return result;
}

async function compact(row, page) {
  const source = row.thumbnail ?? '';
  if (!source.startsWith('data:image/')) return false;
  const original = Buffer.from(source.slice(source.indexOf(',') + 1), 'base64');
  const compacted = await page.evaluate(async (dataUrl) => {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    const encode = (maximumWidth, quality) => {
      const scale = Math.min(1, maximumWidth / image.naturalWidth);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('2D canvas is unavailable');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', quality);
    };
    let output = encode(480, 0.62);
    if (Math.ceil((output.length - output.indexOf(',') - 1) * 0.75) > 60_000) output = encode(320, 0.5);
    return output;
  }, source);
  const output = Buffer.from(compacted.slice(compacted.indexOf(',') + 1), 'base64');
  if (output.length > 60_000) throw new Error('thumbnail remained over 60 KB after bounded recompression');
  return rpc('compact_cctv_observation_thumbnail', {
    p_observation_id: row.observation_id,
    p_thumbnail: compacted,
    p_original_bytes: original.length,
    p_compacted_bytes: output.length,
  });
}

let compacted = 0;
let failed = 0;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  for (;;) {
    const rows = await rpc('get_cctv_oversized_thumbnails', { p_limit: 5 });
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      try {
        if (await compact(row, page)) compacted += 1;
      } catch (error) {
        failed += 1;
        console.error(`thumbnail compaction failed: ${error instanceof Error ? error.message : String(error)}`);
        await rpc('compact_cctv_observation_thumbnail', {
          p_observation_id: row.observation_id,
          p_thumbnail: null,
          p_original_bytes: Buffer.byteLength(row.thumbnail ?? ''),
          p_compacted_bytes: 0,
        });
      }
    }
    console.log(`CCTV thumbnails compacted: ${compacted}; failed: ${failed}`);
  }
} finally {
  await browser.close();
}
console.log(`CCTV thumbnail compaction complete: ${compacted} compacted; ${failed} derivatives omitted (source evidence unchanged)`);