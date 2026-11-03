// Report pack delivery helpers shared by generate-report-pack-pdf and
// send-report-pack. Plain ESM so node:test can exercise them directly.

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const LOGO_TIMEOUT_MS = 5000;

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
 * @param {{ title?: unknown, periodStart: string, periodEnd: string }} input
 * @returns {string}
 */
export function reportPdfFilename({ title, periodStart, periodEnd }) {
  const base = emailSafeHeaderText(title || 'Report Pack')
    .replace(/[^A-Za-z0-9 _.-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim() || 'Report Pack';
  return `${base} ${periodStart} to ${periodEnd}.pdf`;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function reportLogoUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' ? parsed.toString() : null;
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
 * Loads the provider organisation's logo for the report header. A missing,
 * slow, oversized, or unsupported logo yields null so the report still renders.
 * @param {unknown} logoUrl
 * @param {typeof fetch} [fetcher]
 * @returns {Promise<{ bytes: Uint8Array, kind: 'png' | 'jpg' } | null>}
 */
export async function loadReportLogo(logoUrl, fetcher = fetch) {
  const url = reportLogoUrl(logoUrl);
  if (!url) return null;
  try {
    const response = await fetcher(url, { redirect: 'follow', signal: AbortSignal.timeout(LOGO_TIMEOUT_MS) });
    if (!response.ok) return null;
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_LOGO_BYTES) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_LOGO_BYTES) return null;
    const kind = reportLogoKind(bytes);
    return kind ? { bytes, kind } : null;
  } catch {
    return null;
  }
}
