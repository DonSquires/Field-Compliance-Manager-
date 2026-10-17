# CarJam vehicle enrichment

FCM uses CarJam's licensed Developer Connection API for canonical vehicle
enrichment. It does not automate the CarJam website, reuse a person's browser
session, or accept a CarJam username/password.

## Provider prerequisites

Before enabling the connector, obtain both:

1. A CarJam Developer Connection API key.
2. Written CarJam authorization allowing an automated system to persist the
   non-personal vehicle attributes used by FCM.

CarJam's API terms currently say automated systems must discard vehicle
information after the immediate request and require prior written consent for
storage. A normal website login does not provide that consent.

Authoritative references, retrieved 2026-10-15:

- [API vehicle queries](https://www.carjam.co.nz/dev:page?t=vehicle-queries)
- [API terms and conditions](https://www.carjam.co.nz/cms:page?t=api-terms-and-conditions)
- [API throttling](https://www.carjam.co.nz/dev:category?t=api)

## Configuration

Store the following as Supabase Edge Function secrets, never in a browser
environment or committed file:

```text
CARJAM_API_KEY=<developer-connection-api-key>
CARJAM_STORAGE_AUTHORIZATION_REFERENCE=<non-secret contract/approval reference>
```

The function deliberately has no login URL, username, password, cookie, HTML
parser, or configurable remote host. It calls only:

```text
https://www.carjam.co.nz/api/car/
```

The authorization reference is persisted with each enrichment receipt. Do not
put the API key, a password, a session cookie, or personal MVR information in
that reference.

## Data flow

1. `carjam-vehicle-lookup` accepts only the service role used by the controlled
   server-side batch job. Browser and ordinary authenticated calls are rejected.
2. The requested plate must already exist in `canonical_vehicles`; the connector
   cannot create a new canonical identity.
3. CarJam's JSON response is checked against the requested plate and normalized
   to make, model, year, colour, body style, and fuel type.
4. `record_carjam_vehicle_enrichment` locks the canonical record, fills only
   missing values, and records source attribution and a replay-safe receipt in
   one database transaction.
5. The raw CarJam response is discarded. FCM retains only the promoted
   non-personal fields, a SHA-256 response digest, retrieval time, credential-free
   source URL, geographic scope, terms URL, and written-authorization reference.
6. `canonical_vehicle_public` exposes only the provider credit, source URL,
   source scope, and checked time. API keys, raw payloads, authorization
   references, ownership data, and private vehicle notes are excluded.

The public attribution is labelled as the latest licensed enrichment receipt,
not as the source of every current vehicle field. MotoWeb remains the live
rego/WoF/CoF provider and may independently update canonical make, model, year,
and colour values.

## Bounded batch refresh

After the migration and Edge Function are deployed and both provider
prerequisites are configured, run:

```powershell
node scripts\carjam-refresh-vehicle-data.js
```

Optional server-side controls:

```text
CARJAM_BATCH_LIMIT=25
CARJAM_MIN_INTERVAL_MS=1250
CARJAM_REFRESH_AFTER_DAYS=30
```

The batch is sequential, stops on provider rate limiting, masks plate numbers
in logs, and exits non-zero when any lookup fails. It selects only canonical
vehicles with missing supported fields or stale source checks.
