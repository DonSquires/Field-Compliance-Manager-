import { createClient } from "npm:@supabase/supabase-js@2.49.8";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const authHeader = req.headers.get("Authorization");
  const apiKey = req.headers.get("apikey");
  if (!authHeader || !apiKey) return new Response("Missing service authorization", { status: 401 });
  const body = await req.json();
  const required = ["job_id", "run_id", "kind", "object_path", "lease_token", "sha256", "size_bytes"];
  if (required.some((key) => body?.[key] === undefined || body?.[key] === null || body?.[key] === "")) return new Response("job_id, run_id, kind, object_path, lease_token, sha256, and size_bytes are required", { status: 400 });
  if (!/^[a-f0-9]{64}$/i.test(body.sha256) || !Number.isSafeInteger(body.size_bytes) || body.size_bytes < 0) {
    return new Response("sha256 must be a 64-character hex digest and size_bytes must be a non-negative integer", { status: 400 });
  }
  const storage = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: object, error: downloadError } = await storage.storage.from(body.bucket_id ?? "wf-artifacts").download(body.object_path);
  if (downloadError || !object) return new Response(JSON.stringify({ error: "artifact object not found" }), { status: 422, headers: { "Content-Type": "application/json" } });
  const bytes = new Uint8Array(await object.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const actualSha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (bytes.byteLength !== body.size_bytes || actualSha256.toLowerCase() !== body.sha256.toLowerCase()) {
    return new Response(JSON.stringify({ error: "artifact integrity check failed" }), { status: 422, headers: { "Content-Type": "application/json" } });
  }
  const supabase = createClient(SUPABASE_URL, apiKey, { global: { headers: { Authorization: authHeader } } });
  const { data, error } = await supabase.rpc("wf_service_return_artifact", {
    _job_id: body.job_id,
    _run_id: body.run_id,
    _kind: body.kind,
    _bucket_id: body.bucket_id ?? "wf-artifacts",
    _object_path: body.object_path,
    _sha256: body.sha256 ?? null,
    _size_bytes: body.size_bytes ?? null,
    _lease_token: body.lease_token
  });
  if (error) return new Response(JSON.stringify({ error: "artifact return failed" }), { status: 400, headers: { "Content-Type": "application/json" } });
  return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
});