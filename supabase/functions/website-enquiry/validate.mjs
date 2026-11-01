// @ts-check
// Pure request rules for the public website-enquiry edge function. No Deno or
// Supabase imports, so the root Node tests can import this file directly.

export const MAX_BODY_BYTES = 16 * 1024;
export const MIN_FILL_MS = 3000;

export const ALLOWED_SERVICES = Object.freeze([
  'static-guarding',
  'patrols-response',
  'cctv-surveillance',
  'raptor',
  'gates-access',
  'investigations',
  'forestry-rural',
  'rams-permits',
  'council-compliance',
  'pest-control',
  'other',
]);

export const PREFERRED_CONTACT = Object.freeze(['email', 'phone', 'either']);

const EXACT_ORIGINS = new Set([
  'https://randmsecurity.com',
  'https://www.randmsecurity.com',
  'http://localhost:4321',
  'http://127.0.0.1:4321',
]);

export const VERCEL_ORIGIN = /^https:\/\/randmsecurity-website(-[a-z0-9-]+)?\.vercel\.app$/;

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_PATTERN = /^[0-9 +()-]+$/;

/** @param {string | null | undefined} origin */
export function isAllowedOrigin(origin) {
  if (typeof origin !== 'string' || origin === '') return false;
  return EXACT_ORIGINS.has(origin) || VERCEL_ORIGIN.test(origin);
}

/**
 * Requests without an Origin header (server-to-server, the release boot
 * probe) are allowed; a present Origin must be on the allowlist.
 * @param {string | null | undefined} origin
 * @returns {'none' | 'allowed' | 'denied'}
 */
export function classifyOrigin(origin) {
  if (origin === null || origin === undefined) return 'none';
  return isAllowedOrigin(origin) ? 'allowed' : 'denied';
}

/**
 * @param {string | null} contentLength
 * @returns {boolean}
 */
export function declaredBodyTooLarge(contentLength) {
  if (contentLength === null || contentLength.trim() === '') return false;
  const declared = Number(contentLength);
  return Number.isFinite(declared) && declared > MAX_BODY_BYTES;
}

/**
 * A filled honeypot, or a form sent less than MIN_FILL_MS after it rendered,
 * is answered with success and never stored. A started_at in the future
 * (client clock ahead of ours) is not treated as a bot.
 * @param {unknown} body
 * @param {number} nowMs
 */
export function isSilentDrop(body, nowMs) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  const record = /** @type {Record<string, unknown>} */ (body);
  const honeypot = record.website;
  if (honeypot !== undefined && honeypot !== null) {
    if (typeof honeypot !== 'string' || honeypot.trim() !== '') return true;
  }
  const startedAt = record.started_at;
  if (typeof startedAt === 'number' && Number.isFinite(startedAt)) {
    const elapsed = nowMs - startedAt;
    if (elapsed >= 0 && elapsed < MIN_FILL_MS) return true;
  }
  return false;
}

/** @param {string} value */
function characterCount(value) {
  return Array.from(value).length;
}

/**
 * @param {unknown} value
 * @returns {{ kind: 'absent' } | { kind: 'invalid' } | { kind: 'text', value: string }}
 */
function readText(value) {
  if (value === undefined || value === null) return { kind: 'absent' };
  if (typeof value !== 'string' || value.includes('\u0000')) return { kind: 'invalid' };
  const trimmed = value.trim();
  return trimmed === '' ? { kind: 'absent' } : { kind: 'text', value: trimmed };
}

/**
 * @typedef {object} WebsiteEnquiry
 * @property {string} name
 * @property {string | null} email
 * @property {string | null} phone
 * @property {string | null} organisation
 * @property {string | null} location
 * @property {string[]} services
 * @property {string} message
 * @property {'email' | 'phone' | 'either'} preferred_contact
 * @property {true} privacy_ack
 * @property {string | null} source_page
 */

/**
 * @param {unknown} body
 * @returns {{ ok: true, enquiry: WebsiteEnquiry } | { ok: false, fields: Record<string, string> }}
 */
export function validateEnquiry(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, fields: { body: 'Send the enquiry as a JSON object.' } };
  }
  const input = /** @type {Record<string, unknown>} */ (body);
  /** @type {Record<string, string>} */
  const fields = {};

  const name = readText(input.name);
  if (name.kind === 'absent') fields.name = 'Enter your name.';
  else if (name.kind === 'invalid') fields.name = 'Enter your name as plain text.';
  else if (characterCount(name.value) < 2 || characterCount(name.value) > 120) {
    fields.name = 'Your name must be between 2 and 120 characters.';
  }

  const email = readText(input.email);
  if (email.kind === 'invalid') fields.email = 'Enter a valid email address.';
  else if (email.kind === 'text') {
    if (characterCount(email.value) > 200) fields.email = 'Email address must be 200 characters or fewer.';
    else if (!EMAIL_PATTERN.test(email.value)) fields.email = 'Enter a valid email address.';
  }

  const phone = readText(input.phone);
  if (phone.kind === 'invalid') fields.phone = 'Enter a valid phone number.';
  else if (phone.kind === 'text') {
    if (characterCount(phone.value) > 40) fields.phone = 'Phone number must be 40 characters or fewer.';
    else if (!PHONE_PATTERN.test(phone.value) || !/[0-9]/.test(phone.value)) {
      fields.phone = 'Phone numbers can only use digits, spaces, +, ( ) and -.';
    }
  }

  if (email.kind === 'absent' && phone.kind === 'absent') {
    fields.email = 'Enter an email address or a phone number so we can reply.';
    fields.phone = 'Enter an email address or a phone number so we can reply.';
  }

  const organisation = readText(input.organisation);
  if (organisation.kind === 'invalid') fields.organisation = 'Enter your organisation as plain text.';
  else if (organisation.kind === 'text' && characterCount(organisation.value) > 160) {
    fields.organisation = 'Organisation must be 160 characters or fewer.';
  }

  const location = readText(input.location);
  if (location.kind === 'invalid') fields.location = 'Enter the town, area or property as plain text.';
  else if (location.kind === 'text' && characterCount(location.value) > 160) {
    fields.location = 'Location must be 160 characters or fewer.';
  }

  /** @type {string[]} */
  let services = [];
  if (input.services !== undefined && input.services !== null) {
    if (!Array.isArray(input.services)) {
      fields.services = 'Choose services from the list.';
    } else if (input.services.some((item) => typeof item !== 'string' || !ALLOWED_SERVICES.includes(item))) {
      fields.services = 'Choose services from the list.';
    } else {
      services = Array.from(new Set(/** @type {string[]} */ (input.services)));
      if (services.length > ALLOWED_SERVICES.length) fields.services = 'Choose up to 11 services.';
    }
  }

  const message = readText(input.message);
  if (message.kind === 'absent') fields.message = 'Tell us how we can help.';
  else if (message.kind === 'invalid') fields.message = 'Enter your message as plain text.';
  else if (characterCount(message.value) < 10) fields.message = 'Your message must be at least 10 characters.';
  else if (characterCount(message.value) > 4000) fields.message = 'Your message must be 4000 characters or fewer.';

  /** @type {'email' | 'phone' | 'either'} */
  let preferredContact = 'either';
  const preferred = readText(input.preferred_contact);
  if (preferred.kind === 'invalid') fields.preferred_contact = 'Choose email, phone or either.';
  else if (preferred.kind === 'text') {
    if (PREFERRED_CONTACT.includes(preferred.value)) {
      preferredContact = /** @type {'email' | 'phone' | 'either'} */ (preferred.value);
    } else {
      fields.preferred_contact = 'Choose email, phone or either.';
    }
  }

  if (input.privacy_ack !== true) {
    fields.privacy_ack = 'Please confirm you have read the privacy statement.';
  }

  const sourcePage = readText(input.source_page);
  if (sourcePage.kind === 'invalid') fields.source_page = 'Source page must be text.';
  else if (sourcePage.kind === 'text' && characterCount(sourcePage.value) > 200) {
    fields.source_page = 'Source page must be 200 characters or fewer.';
  }

  if (Object.keys(fields).length > 0) return { ok: false, fields };

  return {
    ok: true,
    enquiry: {
      name: name.kind === 'text' ? name.value : '',
      email: email.kind === 'text' ? email.value : null,
      phone: phone.kind === 'text' ? phone.value : null,
      organisation: organisation.kind === 'text' ? organisation.value : null,
      location: location.kind === 'text' ? location.value : null,
      services,
      message: message.kind === 'text' ? message.value : '',
      preferred_contact: preferredContact,
      privacy_ack: true,
      source_page: sourcePage.kind === 'text' ? sourcePage.value : null,
    },
  };
}

/** @param {{ get(name: string): string | null }} headers */
export function clientIpFromHeaders(headers) {
  // Cloudflare overwrites CF-Connecting-IP but appends to a client-supplied
  // X-Forwarded-For, so the first forwarded entry can be spoofed to dodge the limit.
  const connecting = headers.get('cf-connecting-ip')?.trim();
  if (connecting) return connecting;
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return headers.get('x-real-ip')?.trim() || 'unknown';
}

/** @param {string} value */
export async function sha256Hex(value) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Only the salted hash leaves this function; the raw IP is never stored.
 * @param {string} ip
 * @param {string} salt
 */
export function hashClient(ip, salt) {
  return sha256Hex(`${salt}:${ip}`);
}

const SERVER_FIELD_MESSAGES = Object.freeze({
  name: 'Your name must be between 2 and 120 characters.',
  email: 'Enter a valid email address, or a phone number.',
  phone: 'Enter a valid phone number, or an email address.',
  organisation: 'Organisation must be 160 characters or fewer.',
  location: 'Location must be 160 characters or fewer.',
  services: 'Choose services from the list.',
  message: 'Your message must be between 10 and 4000 characters.',
  preferred_contact: 'Choose email, phone or either.',
  privacy_ack: 'Please confirm you have read the privacy statement.',
  source_page: 'Source page must be 200 characters or fewer.',
});

/**
 * Maps a submit_website_enquiry error to the public response. Database text
 * never reaches the caller.
 * @param {{ code?: string | null, message?: string | null } | null | undefined} error
 * @returns {{ status: number, body: Record<string, unknown> }}
 */
export function mapSubmitError(error) {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? '');
  if (code === 'PT429' || message.includes('website_enquiry_rate_limited')) {
    return { status: 429, body: { ok: false, error: 'rate_limited' } };
  }
  const invalid = /website_enquiry_invalid:([a-z_]+)/.exec(message);
  const field = invalid?.[1];
  if (field && Object.prototype.hasOwnProperty.call(SERVER_FIELD_MESSAGES, field)) {
    return {
      status: 400,
      body: {
        ok: false,
        error: 'validation',
        fields: { [field]: SERVER_FIELD_MESSAGES[/** @type {keyof typeof SERVER_FIELD_MESSAGES} */ (field)] },
      },
    };
  }
  return { status: 500, body: { ok: false, error: 'unavailable' } };
}

/** @param {unknown} value */
export function isEnquiryReference(value) {
  return typeof value === 'string' && /^ENQ-[0-9A-F]{6}$/.test(value);
}
