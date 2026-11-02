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
 * @returns {{ subject: string, text: string, replyTo: string | null }}
 */
export function buildEnquiryAlert({ reference, enquiry, receivedAt, reviewUrl = null }) {
  const services = enquiry.services.map((slug) => SERVICE_LABELS[/** @type {keyof typeof SERVICE_LABELS} */ (slug)] ?? slug);
  const firstService = services[0];
  const subjectService = firstService ? `: ${firstService}${services.length > 1 ? ` +${services.length - 1}` : ''}` : '';
  const replyTo = enquiry.email && isPlainAddress(enquiry.email) ? enquiry.email : null;

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
    multiLine(enquiry.message),
    '',
    '---',
    'Reply, convert or close this enquiry in Field Compliance Manager: CRM > Website enquiries.',
  ];
  if (reviewUrl) lines.push(reviewUrl);
  if (replyTo) lines.push('Replying to this email goes to the person who sent the enquiry.');

  return {
    subject: `Website enquiry ${reference}${subjectService}`,
    text: `${lines.join('\n')}\n`,
    replyTo,
  };
}

/**
 * Base64 body for a text/plain MIME part, in 76-character CRLF lines.
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
