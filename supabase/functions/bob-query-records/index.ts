Deno.serve(async (req)=>{
  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
  let bodyCapability = null;
  let bodyKeys = [];
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      const cloned = req.clone();
      const contentType = cloned.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const json = await cloned.json();
        if (json && typeof json === "object") {
          bodyKeys = Object.keys(json).slice(0, 20);
          const maybeCapability = json["capability"];
          bodyCapability = typeof maybeCapability === "string" ? maybeCapability : null;
        }
      }
    }
  } catch  {
  // Intentionally ignore parse failures; keep deprecation response deterministic.
  }
  const payload = {
    error: "deprecated_endpoint",
    message: "Use /functions/v1/bob-query-atlas instead of /functions/v1/bob-query-records",
    replacement: "/functions/v1/bob-query-atlas",
    request_id: requestId,
    timestamp: new Date().toISOString()
  };
  console.warn(JSON.stringify({
    event: "deprecated_endpoint_called",
    endpoint: "bob-query-records",
    method: req.method,
    path: new URL(req.url).pathname,
    request_id: requestId,
    caller_hint: req.headers.get("x-bob-caller") ?? null,
    origin: req.headers.get("origin") ?? null,
    referer: req.headers.get("referer") ?? null,
    user_agent: req.headers.get("user-agent") ?? null,
    has_authorization: req.headers.has("authorization"),
    has_apikey: req.headers.has("apikey"),
    capability: bodyCapability,
    body_keys: bodyKeys,
    region: Deno.env.get("SB_REGION") ?? null,
    execution_id: Deno.env.get("SB_EXECUTION_ID") ?? null,
    deployment_id: Deno.env.get("DENO_DEPLOYMENT_ID") ?? null
  }));
  return new Response(JSON.stringify(payload), {
    status: 410,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-request-id": requestId
    }
  });
});
