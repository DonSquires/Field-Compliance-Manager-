export async function relayVpsRead({ path, stackBase, stackToken, controlBase, controlToken, fetchImpl = fetch }) {
  const targets = [
    ...(stackBase && stackToken ? [{ base: stackBase, token: stackToken }] : []),
    ...(controlBase && controlToken ? [{ base: controlBase, token: controlToken }] : []),
  ];
  if (!targets.length) return { ok: false, status: 503, body: { code: 'RELAY_NOT_CONFIGURED' } };
  for (const { base, token } of targets) {
    const normalizedBase = base.replace(/\/+$/, '').replace(/\/api(?:\/bob)?(?:\/builder)?$/, '');
    for (const suffix of [path, `/api/bob${path}`, `/api/bob/builder${path}`]) {
      let response;
      try {
        response = await fetchImpl(`${normalizedBase}${suffix}`, {
          headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000), redirect: 'error',
        });
      } catch {
        return { ok: false, status: 502, body: { code: 'RELAY_UNREACHABLE' } };
      }
      if (response.status === 404) continue;
      let body;
      try { body = await response.json(); } catch {
        return { ok: false, status: 502, body: { code: 'RELAY_INVALID_RESPONSE' } };
      }
      return { ok: response.ok, status: response.status, body };
    }
  }
  return { ok: false, status: 404, body: { code: 'RELAY_ROUTE_NOT_FOUND' } };
}
