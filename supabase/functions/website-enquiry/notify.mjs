// @ts-check
// Email alert to the R&M inbox for each stored website enquiry. Pure functions
// only, so the root Node tests can import this file; index.ts sends the
// message over SMTP. The enquiry is already stored before this runs, so an
// alert that fails is logged and never loses the lead.

export const DEFAULT_ALERT_RECIPIENTS = Object.freeze(['admin@remsec.co.nz', 'don@remsec.co.nz']);

export const SERVICE_LABELS = Object.freeze({
  'static-guarding': 'Static guarding, events and property protection',
  'patrols-response': 'Security patrols and alarm response',
  'cctv-surveillance': 'CCTV and monitoring',
  raptor: 'Raptor mobile surveillance',
  'gates-access': 'Security gates and access control',
  investigations: 'Covert operations and investigations',
  'forestry-rural': 'Forestry and rural security',
  'rams-permits': 'RAMS, permits and hunting bookings',
  'council-compliance': 'Council compliance and bylaw services',
  'pest-control': 'Pest control and pest management compliance',
  other: 'Something else',
});

const PREFERRED_LABELS = Object.freeze({ email: 'Email', phone: 'Phone', either: 'Email or phone' });
const IRON_EAGLE_LOGO_URL = 'https://www.fcmanager.co.nz/assets/email/iron-eagle-brand-20261102.png';
const RM_SECURITY_LOGO_URL = 'https://www.fcmanager.co.nz/assets/email/rm-security-brand-20261102.png';

// Stricter than the intake rule: only a plain address is safe as a Reply-To.
const PLAIN_ADDRESS = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

/** @param {string} value */
export function isPlainAddress(value) {
  return value.length <= 200 && PLAIN_ADDRESS.test(value);
}

/**
 * WEBSITE_ENQUIRY_NOTIFY_TO is a comma- or semicolon-separated list. Invalid
 * entries are ignored; an unset or fully invalid value uses the defaults.
 * @param {string | null | undefined} configured
 * @returns {string[]}
 */
export function resolveAlertRecipients(configured) {
  const parsed = (configured ?? '')
    .split(/[,;]/)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '' && isPlainAddress(item));
  const unique = Array.from(new Set(parsed));
  return unique.length > 0 ? unique : [...DEFAULT_ALERT_RECIPIENTS];
}

/** @param {string | null | undefined} value */
function singleLine(value) {
  return (value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/** @param {string} value */
function multiLine(value) {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim();
}

/** @param {string} value */
function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** @param {string | null} value */
function safeReviewHref(value) {
  if (!value || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

/** @param {Date} date */
function aucklandTime(date) {
  return new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'Pacific/Auckland',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

/**
 * @typedef {object} EnquiryAlertInput
 * @property {string} reference
 * @property {import('./validate.mjs').WebsiteEnquiry} enquiry
 * @property {Date} receivedAt
 * @property {string | null} [reviewUrl]
 */

/**
 * @param {EnquiryAlertInput} input
 * @returns {{ subject: string, text: string, html: string, replyTo: string | null, invalidReviewUrl: boolean }}
 */
export function buildEnquiryAlert({ reference, enquiry, receivedAt, reviewUrl = null }) {
  const services = enquiry.services.map((slug) => SERVICE_LABELS[/** @type {keyof typeof SERVICE_LABELS} */ (slug)] ?? slug);
  const firstService = services[0];
  const subjectService = firstService ? `: ${firstService}${services.length > 1 ? ` +${services.length - 1}` : ''}` : '';
  const replyTo = enquiry.email && isPlainAddress(enquiry.email) ? enquiry.email : null;
  const reviewHref = safeReviewHref(reviewUrl);
  const invalidReviewUrl = Boolean(reviewUrl && !reviewHref);
  const message = multiLine(enquiry.message);

  /** @type {Array<[string, string]>} */
  const rows = [
    ['Reference', reference],
    ['Received', aucklandTime(receivedAt)],
    ['Name', singleLine(enquiry.name)],
    ['Email', singleLine(enquiry.email) || 'Not given'],
    ['Phone', singleLine(enquiry.phone) || 'Not given'],
    ['Preferred contact', PREFERRED_LABELS[enquiry.preferred_contact] ?? 'Email or phone'],
    ['Organisation', singleLine(enquiry.organisation) || 'Not given'],
    ['Location', singleLine(enquiry.location) || 'Not given'],
    ['Services', services.length > 0 ? services.join('; ') : 'Not chosen'],
    ['Sent from page', singleLine(enquiry.source_page) || 'Not recorded'],
  ];

  const lines = [
    'A new enquiry has arrived from the R&M website.',
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    'Message:',
    message,
    '',
    '---',
    'Reply, convert or close this enquiry in Field Compliance Manager: CRM > Website enquiries.',
  ];
  if (reviewUrl && reviewHref) lines.push(reviewUrl);
  if (invalidReviewUrl) lines.push('Review link unavailable; ask an administrator to check SITE_URL.');
  if (replyTo) lines.push('Replying to this email goes to the person who sent the enquiry.');

  const detailRows = rows.map(([label, value]) => `
    <tr>
      <th scope="row" align="left" valign="top" style="padding:8px 12px 8px 0;color:#b8cad4;font-weight:600;white-space:nowrap;">${escapeHtml(label)}</th>
      <td valign="top" style="padding:8px 0;color:#f5f9fb;overflow-wrap:anywhere;word-break:break-word;">${escapeHtml(value)}</td>
    </tr>`).join('');
  const reviewLink = reviewUrl && reviewHref
    ? `<p style="margin:12px 0 0;"><a href="${escapeHtml(reviewHref)}" style="color:#55d7de;word-break:break-all;">${escapeHtml(reviewUrl)}</a></p>`
    : invalidReviewUrl
      ? '<p style="margin:12px 0 0;">Review link unavailable; ask an administrator to check SITE_URL.</p>'
      : '';
  const replyHint = replyTo
    ? '<p style="margin:12px 0 0;">Replying to this email goes to the person who sent the enquiry.</p>'
    : '';
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#07131b;color:#f5f9fb;font-family:Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#07131b;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#0c202b;">
        <tr><td style="padding:20px 16px 24px;background:#07131b;border-bottom:3px solid #14c8d4;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
            <td align="left" valign="middle" style="padding-right:8px;"><img src="${IRON_EAGLE_LOGO_URL}" alt="Iron Eagle Security" width="110" height="57" style="display:block;width:110px;max-width:100%;height:auto;border:0;"></td>
            <td align="right" valign="middle"><img src="${RM_SECURITY_LOGO_URL}" alt="R&amp;M Security and Investigations" width="142" height="42" style="display:block;width:142px;max-width:100%;height:auto;border:0;"></td>
          </tr></table>
          <div style="margin-top:20px;font-size:12px;font-weight:700;letter-spacing:1px;color:#55d7de;">FCM</div>
          <div style="font-size:20px;line-height:1.3;font-weight:700;color:#f5f9fb;">Field Compliance Manager</div>
          <div style="margin-top:4px;font-size:13px;color:#b8cad4;">Website enquiry</div>
        </td></tr>
        <tr><td style="padding:24px;font-size:15px;line-height:1.5;">
          <p style="margin:0 0 18px;font-size:18px;font-weight:700;">A new enquiry has arrived from the R&amp;M website.</p>
          <table width="100%" cellspacing="0" cellpadding="0" style="font-size:14px;line-height:1.4;border-collapse:collapse;">${detailRows}
          </table>
          <div style="margin-top:20px;padding:16px;background:#112c3a;">
            <div style="margin-bottom:8px;color:#b8cad4;font-size:13px;font-weight:700;">Message</div>
            <div style="color:#f5f9fb;overflow-wrap:anywhere;word-break:break-word;">${escapeHtml(message).replace(/\n/g, '<br>')}</div>
          </div>
          <div style="margin-top:24px;padding-top:16px;border-top:1px solid #31515f;color:#b8cad4;font-size:13px;">
            <p style="margin:0;">Reply, convert or close this enquiry in Field Compliance Manager: CRM &gt; Website enquiries.</p>${reviewLink}${replyHint}
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return {
    subject: `Website enquiry ${reference}${subjectService}`,
    text: `${lines.join('\n')}\n`,
    html,
    replyTo,
    invalidReviewUrl,
  };
}

/**
 * Base64 body for a text MIME part, in 76-character CRLF lines.
 * denomailer's own quoted-printable path wraps every 74 characters without
 * dot-stuffing, so visitor text could start a line with "." and end the SMTP
 * DATA block early. Base64 never contains "." or bare line feeds.
 * @param {string} text
 */
export function encodeBase64Body(text) {
  const bytes = new TextEncoder().encode(text.replace(/\r?\n/g, '\r\n'));
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  const encoded = btoa(binary);
  return (encoded.match(/.{1,76}/g) ?? ['']).join('\r\n');
}

/**
 * @param {{ text: string, html: string }} message
 * @returns {Array<{ mimeType: string, content: string, transferEncoding: 'base64' }>}
 */
export function buildAlertMimeContent(message) {
  return [
    { mimeType: 'text/plain; charset="utf-8"', content: encodeBase64Body(message.text), transferEncoding: 'base64' },
    { mimeType: 'text/html; charset="utf-8"', content: encodeBase64Body(message.html), transferEncoding: 'base64' },
  ];
}
