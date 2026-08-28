import { createClient } from "npm:@supabase/supabase-js@2.49.8";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const authHeader = req.headers.get("Authorization");
  const apiKey = req.headers.get("apikey");
  if (!authHeader || !apiKey) return new Response("Missing service authorization", { status: 401 });
  const body = await req.json();
  if (!body?.job_id || !body?.runner_id) return new Response("job_id and runner_id are required", { status: 400 });
  const supabase = createClient(SUPABASE_URL, apiKey, { global: { headers: { Authorization: authHeader } } });
  const { data, error } = await supabase.rpc("wf_service_pickup_run", { _job_id: body.job_id, _runner_id: body.runner_id });
  if (error) return new Response(JSON.stringify({ error: "runner pickup failed" }), { status: 400, headers: { "Content-Type": "application/json" } });
  return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
});