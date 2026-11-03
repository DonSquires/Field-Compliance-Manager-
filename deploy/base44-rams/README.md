# Base44 RAMS (OFO) sync on the VPS

The VPS is the always-on runner for `scripts/sync-base44-rams.mjs`. It polls the
Base44 RAMS (OFO) app hourly with a read-only, app-scoped token and applies new and
changed people, vehicles, permits, booking companions and kill returns through the
server-only `ingest_base44_rams_*` RPCs.

Update policy (same as the R&M source promotion): changed source rows update the
FCM record in place with their Base44 id and timestamps as provenance; nothing is
hard-deleted. A kill return that disappears from a complete Base44 listing is only
marked `withdrawn_at` (restored if it reappears), and a listing that shrinks below
`MIN_LISTING_RATIO` is treated as a source fault, so nothing is withdrawn. Ambiguous
people stay flagged for review rather than being merged.

## Install or update

```bash
install -d -m 755 /opt/fcm-base44-sync
install -m 644 scripts/sync-base44-rams.mjs /opt/fcm-base44-sync/
install -m 700 deploy/base44-rams/fcm-base44-rams-sync.sh /usr/local/bin/
install -m 644 deploy/base44-rams/fcm-base44-rams-sync.{service,timer} /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now fcm-base44-rams-sync.timer
```

Secrets: the Base44 token is in `/var/lib/bob/base44-rams-read-token` (root, `600`).
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are read from
`/var/lib/bob/control-plane.env`. In Codespaces, the same token is the repository
Codespaces secret `BASE44_RAMS_READ_TOKEN`.

Reports (counts only) and logs are in `/var/lib/fcm-base44-rams/` and are kept for
30 days. Run on demand with `systemctl start fcm-base44-rams-sync.service`.

The laptop task "FCM Base44 RAMS sync" (`scripts/run-base44-rams-sync.ps1`) is a
disabled fallback. Enable it only if the VPS timer is down.
