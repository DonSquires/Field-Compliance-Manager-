# Exact patrol-stop private briefing contract

Local implementation only; this function and the `get_officer_patrol_journey`
migration must be released through the governed lane before a client can use
them. No migration, deployment or live write is performed by this change.

## Client

Invoke `officer-patrol-stop-briefing` with the signed-in officer's session:

```ts
const { data, error } = await supabase.functions.invoke('officer-patrol-stop-briefing', {
  body: { shift_id: selectedShiftId, stop_id: selectedStopId },
});
```

Both IDs are required UUID strings. Success is:

```ts
{
  shift_id: string;
  stop_id: string;
  officer_instructions: string | null;
  access_instructions: string | null;
  hs_notes: string | null;
  privacy: { status: 'checked' | 'partly_withheld' | 'unavailable'; message?: string };
}
```

Check the returned IDs against the current selection before displaying. `null`
is absent, empty or withheld, never a safety clearance. `partly_withheld` means
only non-null fields passed review; tell the officer some content is withheld,
and do not treat safety as complete. `unavailable` withholds all three fields.
Errors return a non-2xx response with `error` and unavailable `privacy`; a
client must handle function invocation errors as unavailable too. Never fall
back to the legacy raw RPC, cache private briefing content, or interpret
missing safety information as safe. No checkpoint, contact, attendance, or
general site record is included.

The web and mobile patrols show the current stop's reviewed briefing before arrival.
Loading, unavailable or partly withheld review never exposes unchecked text;
unavailable and partial reviews provide retry and operations escalation.
Private-review availability does not gate recording arrival evidence. A checked
empty briefing, a withheld briefing, and an arrival receipt are not safety
clearance. The separate server-enforced risk-acknowledgement gate still applies.

## Boundary and release gates

The handler validates the Auth user and active profile, then calls the journey
RPC with the caller JWT for the exact non-overdue assignment. It requires a
unique stop with complete contract attribution. Only then does the server-only
service client read the exact `shift_stops` row, filtered by stop, shift and
assigned site or zone ID, joining only the exact place's name, address where
applicable, access instructions and H&S notes. Stop instructions and place
access/safety fields alone are sent to the same private Oracle route as the
static briefing. Shift, stop, place IDs, kind, name/address and assignment must
agree. No legacy raw patrol RPC is called by this function.
The receipt requires an allowed private provider, model, exact SHA-256 source
hash and complete valid field set. Assignment, active profile and source are
rechecked after review; mismatch or outage returns no narrative.

The local privilege migration revokes direct API-role execution of the legacy
RPC; the sanitized reader still calls it internally. Web and mobile clients
use that sanitized reader. Until those changes are released, the live legacy
RPC remains a raw exposure. Revoking it before installed mobile clients are
updated will make their stop reader fail, so coordinate the rollout and
support older installations explicitly.

The sanitized reader must return every required check key for recording and
departure gating. Custom check keys can be derived from configurable labels
and may contain sensitive text; these keys are not privately reviewed. Nor are
checkpoint labels, site briefs, contacts or separate safety-briefing hazards
reviewed here. This is not a complete privacy boundary, and authorization and
source reads are not an atomic database snapshot. The client must use the
journey projection for structured stop data and this function for reviewed
text.

Synthetic regression check from the repository root:

```sh
deno test --no-config --no-lock --node-modules-dir=none --allow-env --allow-net \
  supabase/functions/officer-patrol-stop-briefing/handler_test.ts \
  supabase/functions/officer-shift-briefing/handler_test.ts
```

Before release, apply the projection migrations through the approved database
process, deploy the function with JWT verification enabled, distribute the
updated web and mobile clients, then coordinate the legacy-grant restriction.
Verify the private control-plane configuration without exposing credentials,
refresh Atlas after deployment, and run a human-operated authorised synthetic
end-to-end check.
