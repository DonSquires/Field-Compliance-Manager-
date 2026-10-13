import { createClient } from "npm:@supabase/supabase-js@2.49.8";
// ATLAS EXTERNAL CALLER: workflow-runner
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
Deno.serve(async (req)=>{
  if (req.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405
    });
  }
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response("Missing Authorization header", {
      status: 401
    });
  }
  const apiKey = req.headers.get("apikey");
  if (!apiKey) {
    return new Response("Missing apikey header", {
      status: 401
    });
  }
  const body = await req.json();
  const jobId = body?.job_id;
  const runId = body?.run_id ?? null;
  const kind = body?.kind;
  const objectPath = body?.object_path;
  const sha256 = body?.sha256 ?? null;
  const sizeBytes = body?.size_bytes ?? null;
  const leaseToken = body?.lease_token ?? null;
  const bucketId = body?.bucket_id ?? "wf-artifacts";
  if (!jobId || !runId || !kind || !objectPath || !leaseToken) {
    return new Response("job_id, run_id, kind, object_path, and lease_token are required", {
      status: 400
    });
  }
  const supabase = createClient(SUPABASE_URL, apiKey, {
    global: {
      headers: {
        Authorization: authHeader
      }
    }
  });
  const { data, error } = await supabase.rpc("wf_return_artifact", {
    _job_id: jobId,
    _run_id: runId,
    _kind: kind,
    _bucket_id: bucketId,
    _object_path: objectPath,
    _sha256: sha256,
    _size_bytes: sizeBytes,
    _lease_token: leaseToken
  });
  if (error) {
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 400,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "Content-Type": "application/json"
    }
  });
});
