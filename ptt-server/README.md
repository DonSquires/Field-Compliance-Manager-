# FCM PTT server

This service provides organization- and channel-bound WebSocket signaling for
the Field Compliance Manager push-to-talk radio. It is internal infrastructure:
the browser receives only a short-lived session minted by the `ptt-session`
Supabase Edge Function.

## Required configuration

```text
PORT=4000
PTT_SESSION_SECRET=<shared with Supabase ptt-session>
PTT_RELAY_TOKEN=<used only by the internal bob-ptt-view relay>
```

The web deployment must set `VITE_PTT_SIGNAL_URL` to the TLS WebSocket origin
(`wss://...`). Do not set either server secret with a `VITE_` prefix.

Supabase Edge Function secrets:

```text
PTT_SESSION_SECRET=<same value as the PTT server>
PTT_TURN_URLS=turns://<private-turn-host>:5349?transport=tcp,turn:<private-turn-host>:3478?transport=udp
PTT_TURN_SHARED_SECRET=<coturn REST shared secret>
```

`bob-ptt-view` can read bounded service telemetry only when its existing relay
configuration points at this service and uses `PTT_RELAY_TOKEN`.

## Operational checks

`GET /health` is public and returns only bounded service state. The following
routes require the internal `PTT_RELAY_TOKEN` bearer credential:

- `/connections`
- `/rooms`
- `/turn/status`
- `/recent-errors`

Run `node index.js` only behind a TLS WebSocket proxy. Browser microphone access
and WebRTC require a secure origin. `ptt-session` creates expiring coturn REST
credentials from `PTT_TURN_SHARED_SECRET`; the browser never receives that
shared secret. Do not activate a mobile rollout until a private authenticated
TURN service is provisioned.