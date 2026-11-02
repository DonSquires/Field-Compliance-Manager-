-- The rate-limit hash is taken from CF-Connecting-IP first (Cloudflare sets it
-- and clients cannot), then the first X-Forwarded-For entry, then X-Real-IP.
-- See clientIpFromHeaders in supabase/functions/website-enquiry/validate.mjs.
COMMENT ON COLUMN public.website_enquiries.client_hash IS
  'Salted SHA-256 (hex) of the client address: CF-Connecting-IP, else the first X-Forwarded-For entry, else X-Real-IP. Used for the 5 per hour limit. Never the raw IP.';
