// Report pack delivery helpers shared by generate-report-pack-pdf and
// send-report-pack. Plain ESM so node:test can exercise them directly.

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
export const MAX_LOGO_PIXELS = 4096;
const FETCH_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;

const ASCII_REPLACEMENTS = [
  [/[\u2010-\u2015\u2212]/g, '-'],
  [/[\u2018\u2019\u201A\u2032]/g, "'"],
  [/[\u201C\u201D\u201E\u2033]/g, '"'],
  [/\u2026/g, '...'],
  [/[\u00B7\u2022]/g, '-'],
  [/[\x00-\x1F\x7F\u00A0\u2000-\u200B\u2028\u2029\u202F\u205F\u3000]/g, ' '],
];

/**
 * Email header text that the SMTP library will not re-encode. denomailer
 * 1.6.0 breaks the header block when it quoted-printable encodes a non-ASCII
 * subject (and anything already starting with "=?"), so the subject must stay
 * printable ASCII.
 * @param {unknown} value
 * @returns {string}
 */
export function emailSafeHeaderText(value) {
  let text = typeof value === 'string' ? value : '';
  for (const [pattern, replacement] of ASCII_REPLACEMENTS) text = text.replace(pattern, replacement);
  text = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  text = text.replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
  while (text.startsWith('=?')) text = text.slice(2).trim();
  return text;
}

/**
 * @param {{ title?: unknown, periodStart: string, periodEnd: string }} input
 * @returns {string}
 */
export function reportEmailSubject({ title, periodStart, periodEnd }) {
  const safeTitle = emailSafeHeaderText(title) || 'Report Pack';
  return emailSafeHeaderText(`${safeTitle} - ${periodStart} to ${periodEnd}`).slice(0, 200);
}

/**
 * denomailer writes `filename=` unquoted, so the name must be a MIME token
 * (no spaces or tspecials) for mail clients to read it whole.
 * @param {{ title?: unknown, periodStart: string, periodEnd: string }} input
 * @returns {string}
 */
export function reportPdfFilename({ title, periodStart, periodEnd }) {
  const token = (value) => emailSafeHeaderText(value)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  const base = token(title || '').slice(0, 80).replace(/[-.]+$/, '') || 'Report-Pack';
  return `${base}_${token(periodStart)}_to_${token(periodEnd)}.pdf`;
}

/**
 * @param {string} text
 * @returns {string}
 */
function base64Lines(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return (btoa(binary).match(/.{1,76}/g) ?? ['']).join('\r\n');
}

/**
 * MIME bodies for denomailer's `mimeContent`. Base64 is used instead of the
 * library's quoted-printable path because that path never dot-stuffs: a
 * soft-wrapped line starting with "." loses the dot at the SMTP server, which
 * can corrupt the signed download link.
 * @param {string} html
 * @returns {Array<{ mimeType: string, content: string, transferEncoding: string }>}
 */
export function reportEmailMimeContent(html) {
  return [
    { mimeType: 'text/plain; charset="utf-8"', content: base64Lines(htmlToPlainText(html)), transferEncoding: 'base64' },
    { mimeType: 'text/html; charset="utf-8"', content: base64Lines(html), transferEncoding: 'base64' },
  ];
}

/**
 * @param {string} html
 * @returns {string}
 */
export function htmlToPlainText(html) {
  return html
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<\/(p|h[1-6]|tr|li|table)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]*\n[ \t\n]*/g, '\n')
    .replace(/[ ]{2,}/g, ' ')
    .trim();
}

/**
 * Public https URL only: no IP literals, localhost, or internal names.
 * @param {unknown} value
 * @returns {string | null}
 */
export function reportLogoUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    const host = parsed.hostname.toLowerCase();
    if (!host.includes('.') || host.startsWith('[') || /^[\d.]+$/.test(host)) return null;
    if (host === 'localhost' || /\.(localhost|local|internal|lan|home|corp)$/.test(host)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * @param {Uint8Array} bytes
 * @returns {'png' | 'jpg' | null}
 */
export function reportLogoKind(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  return null;
}

/**
 * PNG width/height from the IHDR chunk; pdf-lib decodes PNG pixels, so a tiny
 * compressed file with huge dimensions must be rejected before embedding.
 * @param {Uint8Array} bytes
 * @returns {{ width: number, height: number } | null}
 */
export function pngDimensions(bytes) {
  if (reportLogoKind(bytes) !== 'png' || bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * Reads a response body, cancelling as soon as it exceeds `maxBytes`.
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<Uint8Array | null>}
 */
export async function readCappedBody(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Fetches up to `maxBytes`; returns null on any failure, timeout, or overflow.
 * @param {string} url
 * @param {{ maxBytes: number, fetcher?: typeof fetch, timeoutMs?: number }} options
 * @returns {Promise<Uint8Array | null>}
 */
export async function fetchCappedBytes(url, { maxBytes, fetcher = fetch, timeoutMs = FETCH_TIMEOUT_MS }) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetcher(url, { signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    return await readCappedBody(response, maxBytes);
  } catch {
    return null;
  }
}

/**
 * Loads the provider organisation's logo for the report header. Redirects are
 * followed manually so every hop must also be a public https URL. A missing,
 * slow, oversized, or unsupported logo yields null so the report still renders.
 * @param {unknown} logoUrl
 * @param {typeof fetch} [fetcher]
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ bytes: Uint8Array, kind: 'png' | 'jpg' } | null>}
 */
export async function loadReportLogo(logoUrl, fetcher = fetch, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  let url = reportLogoUrl(logoUrl);
  if (!url) return null;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await fetcher(url, { redirect: 'manual', signal });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        const location = response.headers.get('location');
        url = location ? reportLogoUrl(new URL(location, url).toString()) : null;
        if (!url) return null;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return null;
      }
      const bytes = await readCappedBody(response, MAX_LOGO_BYTES);
      if (!bytes?.length) return null;
      const kind = reportLogoKind(bytes);
      if (!kind) return null;
      const size = pngDimensions(bytes);
      if (size && (size.width > MAX_LOGO_PIXELS || size.height > MAX_LOGO_PIXELS)) return null;
      return { bytes, kind };
    }
    return null;
  } catch {
    return null;
  }
}
