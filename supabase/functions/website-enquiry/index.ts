// Public intake for enquiries from the R&M website (verify_jwt = false in
// supabase/config.toml). Contract, rules and HTTP handling live in
// validate.mjs and handler.mjs; the email alert text lives in notify.mjs;
// this file only wires the Deno runtime.
//
// Secrets: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the
// platform. WEBSITE_ENQUIRY_SALT salts the client IP hash used for the
// 5-per-hour limit. While it is unset the salt is the SHA-256 of the service
// role key, so rotating that key only restarts the rate-limit windows.
//
// Email alert: each stored enquiry is emailed to WEBSITE_ENQUIRY_NOTIFY_TO
// (comma-separated; default admin@remsec.co.nz and don@remsec.co.nz) over the
// shared SMTP secrets SMTP_HOST, SMTP_PORT (default 465; Edge Functions block
// 25 and 587), SMTP_USER, SMTP_PASS and SMTP_FROM. SITE_URL sets the FCM link
// in the email. Every alert writes an
// audit_log row (action website_enquiry_email_alert, result sent | skipped |
// failed) so delivery can be checked without function logs. While SMTP is
// not configured the alert is skipped and admins still get the in-app
// notification from submit_website_enquiry.
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts';
import { createWebsiteEnquiryHandler } from './handler.mjs';
import { buildEnquiryAlert, encodeBase64Body, resolveAlertRecipients } from './notify.mjs';
import { sha256Hex } from './validate.mjs';

const ALERT_TIMEOUT_MS = 20_000;
// Supabase Edge Functions cannot open outbound connections to ports 25 or 587
// (https://supabase.com/docs/guides/functions/limits), so use 465 or 2525.
const BLOCKED_SMTP_PORTS = new Set([25, 587]);

let serviceClient: SupabaseClient | null = null;

function getServiceClient(): SupabaseClient {
  if (serviceClient) return serviceClient;
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured');
  serviceClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return serviceClient;
}

async function clientHashSalt(): Promise<string> {
  const configured = Deno.env.get('WEBSITE_ENQUIRY_SALT')?.trim();
  if (configured) return configured;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!key) throw new Error('WEBSITE_ENQUIRY_SALT and SUPABASE_SERVICE_ROLE_KEY are not configured');
  return await sha256Hex(key);
}

type AlertResult = { result: 'sent' | 'skipped' | 'failed'; reason?: string; recipientCount: number };

async function recordAlertOutcome(reference: string, outcome: AlertResult): Promise<void> {
  try {
    const client = getServiceClient();
    const { data: row, error } = await client
      .from('website_enquiries')
      .select('id, provider_organization_id')
      .eq('reference', reference)
      .maybeSingle();
    if (error || !row) {
      console.error('website-enquiry: alert outcome not recorded', { reference, error: error?.message ?? 'enquiry not found' });
      return;
    }
    const { error: insertError } = await client.from('audit_log').insert({
      organization_id: row.provider_organization_id,
      actor_user_id: null,
      action: 'website_enquiry_email_alert',
      target_table: 'website_enquiries',
      target_id: row.id,
      metadata: {
        reference,
        result: outcome.result,
        reason: outcome.reason ?? null,
        recipient_count: outcome.recipientCount,
      },
    });
    if (insertError) console.error('website-enquiry: alert outcome not recorded', { reference, error: insertError.message });
  } catch (error) {
    console.error('website-enquiry: alert outcome not recorded', { reference, error: error instanceof Error ? error.message : String(error) });
  }
}

function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
}

async function sendEnquiryAlert(alert: Parameters<typeof buildEnquiryAlert>[0]): Promise<void> {
  const recipients = resolveAlertRecipients(Deno.env.get('WEBSITE_ENQUIRY_NOTIFY_TO'));
  const host = Deno.env.get('SMTP_HOST')?.trim() ?? '';
  const user = Deno.env.get('SMTP_USER')?.trim() ?? '';
  const pass = Deno.env.get('SMTP_PASS') ?? '';
  if (!host || !user || !pass) {
    console.warn('website-enquiry: SMTP not configured; email alert skipped', { reference: alert.reference });
    await recordAlertOutcome(alert.reference, { result: 'skipped', reason: 'smtp_not_configured', recipientCount: recipients.length });
    return;
  }
  const port = Number(Deno.env.get('SMTP_PORT')?.trim() || '465');
  if (BLOCKED_SMTP_PORTS.has(port) || !Number.isInteger(port) || port <= 0 || port > 65535) {
    console.warn('website-enquiry: SMTP_PORT cannot be used from Edge Functions; email alert skipped', { reference: alert.reference, port });
    await recordAlertOutcome(alert.reference, { result: 'skipped', reason: 'smtp_port_blocked', recipientCount: recipients.length });
    return;
  }
  const from = Deno.env.get('SMTP_FROM')?.trim() || user;
  const siteUrl = (Deno.env.get('SITE_URL')?.trim() || 'https://fcmanager.co.nz').replace(/\/+$/, '');
  const message = buildEnquiryAlert({ ...alert, reviewUrl: siteUrl });

  const smtp = new SMTPClient({
    connection: { hostname: host, port, tls: port === 465, auth: { username: user, password: pass } },
  });
  try {
    await withTimeout(
      smtp.send({
        from,
        to: recipients,
        subject: message.subject,
        mimeContent: [{
          mimeType: 'text/plain; charset="utf-8"',
          content: encodeBase64Body(message.text),
          transferEncoding: 'base64',
        }],
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      }),
      ALERT_TIMEOUT_MS,
    );
  } catch (error) {
    const timedOut = error instanceof Error && error.message.startsWith('timed out');
    await recordAlertOutcome(alert.reference, {
      result: 'failed',
      reason: timedOut ? 'smtp_timeout' : 'smtp_error',
      recipientCount: recipients.length,
    });
    throw error;
  } finally {
    try {
      await smtp.close();
    } catch {
      // The message outcome is already decided; a failed close changes nothing.
    }
  }
  await recordAlertOutcome(alert.reference, { result: 'sent', recipientCount: recipients.length });
}

type EdgeRuntimeLike = { waitUntil?: (task: Promise<unknown>) => void };

function backgroundTask(task: Promise<void>): void {
  const runtime = (globalThis as { EdgeRuntime?: EdgeRuntimeLike }).EdgeRuntime;
  if (typeof runtime?.waitUntil !== 'function') throw new Error('EdgeRuntime.waitUntil unavailable');
  runtime.waitUntil(task);
}

Deno.serve(createWebsiteEnquiryHandler({
  submit: async (args: Record<string, unknown>) => {
    const { data, error } = await getServiceClient().rpc('submit_website_enquiry', args);
    return { data, error };
  },
  salt: clientHashSalt,
  notify: sendEnquiryAlert,
  background: backgroundTask,
}));
