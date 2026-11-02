// @ts-check
// HTTP handling for the public website-enquiry edge function. Only Web
// standard APIs are used, so the root Node tests can drive the handler with a
// fake submit function. index.ts wires the Supabase service-role client.
import {
  MAX_BODY_BYTES,
  classifyOrigin,
  clientIpFromHeaders,
  declaredBodyTooLarge,
  hashClient,
  isAllowedOrigin,
  isEnquiryReference,
  isSilentDrop,
  mapSubmitError,
  validateEnquiry,
} from './validate.mjs';

const ALLOW_HEADERS = 'authorization, x-client-info, apikey, content-type';
const UNAVAILABLE = Object.freeze({ ok: false, error: 'unavailable' });

/**
 * @param {string | null} origin
 * @param {boolean} withJson
 * @param {Record<string, string>} [extra]
 */
function responseHeaders(origin, withJson, extra = {}) {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    Vary: 'Origin',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  if (withJson) headers.set('Content-Type', 'application/json; charset=utf-8');
  if (origin && isAllowedOrigin(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', ALLOW_HEADERS);
    headers.set('Access-Control-Max-Age', '86400');
  }
  return headers;
}

/**
 * @param {number} status
 * @param {unknown} body
 * @param {string | null} origin
 * @param {Record<string, string>} [extra]
 */
function json(status, body, origin, extra) {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders(origin, true, extra) });
}

/** @param {Record<string, string>} fields */
function validation(fields) {
  return { ok: false, error: 'validation', fields };
}

/**
 * Reads at most MAX_BODY_BYTES; returns null when the body is larger.
 * Throws on invalid UTF-8.
 * @param {Request} req
 * @returns {Promise<string | null>}
 */
async function readLimitedText(req) {
  if (!req.body) return '';
  const reader = req.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
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
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/**
 * @typedef {{ code?: string | null, message?: string | null }} SubmitError
 * @typedef {object} WebsiteEnquiryHandlerDeps
 * @property {(args: Record<string, unknown>) => Promise<{ data: unknown, error: SubmitError | null }>} submit
 * @property {() => Promise<string>} salt
 * @property {() => number} [now]
 * @property {(message: string, detail?: unknown) => void} [logError]
 * @property {(alert: { reference: string, enquiry: import('./validate.mjs').WebsiteEnquiry, receivedAt: Date }) => Promise<void>} [notify]
 *   Sends the R&M email alert for a stored enquiry. It runs after the lead is
 *   saved; a failure is logged and never changes the response.
 * @property {(task: Promise<void>) => void} [background]
 *   Keeps the alert running after the response is sent (EdgeRuntime.waitUntil).
 *   Without it the handler waits for the alert before responding.
 */

/**
 * @param {WebsiteEnquiryHandlerDeps} deps
 * @returns {(req: Request) => Promise<Response>}
 */
export function createWebsiteEnquiryHandler(deps) {
  const now = deps.now ?? (() => Date.now());
  const logError = deps.logError ?? ((message, detail) => console.error(message, detail));

  return async function handleWebsiteEnquiry(req) {
    const origin = req.headers.get('origin');
    const originClass = classifyOrigin(origin);
    try {
      if (originClass === 'denied') return json(403, { ok: false, error: 'origin' }, null);
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders(origin, false) });
      if (req.method !== 'POST') {
        return json(405, { ok: false, error: 'method_not_allowed' }, origin, { Allow: 'POST, OPTIONS' });
      }
      if (declaredBodyTooLarge(req.headers.get('content-length'))) {
        return json(413, { ok: false, error: 'too_large' }, origin);
      }

      let text;
      try {
        text = await readLimitedText(req);
      } catch {
        return json(400, validation({ body: 'Send the enquiry as UTF-8 JSON.' }), origin);
      }
      if (text === null) return json(413, { ok: false, error: 'too_large' }, origin);

      /** @type {unknown} */
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        return json(400, validation({ body: 'Send the enquiry as JSON.' }), origin);
      }

      if (isSilentDrop(body, now())) return json(200, { ok: true, reference: null }, origin);

      const result = validateEnquiry(body);
      if (!result.ok) return json(400, validation(result.fields), origin);

      const enquiry = result.enquiry;
      const clientHash = await hashClient(clientIpFromHeaders(req.headers), await deps.salt());
      const { data, error } = await deps.submit({
        p_name: enquiry.name,
        p_message: enquiry.message,
        p_privacy_ack: true,
        p_client_hash: clientHash,
        p_email: enquiry.email,
        p_phone: enquiry.phone,
        p_organisation: enquiry.organisation,
        p_location: enquiry.location,
        p_services: enquiry.services,
        p_preferred_contact: enquiry.preferred_contact,
        p_source_page: enquiry.source_page,
      });
      if (error) {
        const mapped = mapSubmitError(error);
        if (mapped.status === 500) {
          logError('website-enquiry: submit failed', { code: error.code ?? null, message: error.message ?? null });
        }
        return json(mapped.status, mapped.body, origin);
      }
      if (!isEnquiryReference(data)) {
        logError('website-enquiry: submit returned no reference');
        return json(500, UNAVAILABLE, origin);
      }
      if (deps.notify) {
        const reference = /** @type {string} */ (data);
        const alert = Promise.resolve()
          .then(() => deps.notify?.({ reference, enquiry, receivedAt: new Date(now()) }))
          .catch((alertError) => {
            logError('website-enquiry: email alert failed', {
              reference,
              error: alertError instanceof Error ? alertError.message : String(alertError),
            });
          });
        if (deps.background) {
          try {
            deps.background(alert);
          } catch {
            await alert;
          }
        } else {
          await alert;
        }
      }
      return json(200, { ok: true, reference: data }, origin);
    } catch (error) {
      logError('website-enquiry: unhandled error', error instanceof Error ? error.message : String(error));
      return json(500, UNAVAILABLE, originClass === 'allowed' ? origin : null);
    }
  };
}
