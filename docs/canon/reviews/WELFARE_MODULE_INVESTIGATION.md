> **Canonical copy.** Origin: GitLab `don-squires1/field-compliance-manager` `` @ `Main`, read 2026-09-14 via `scripts/gitlab-read.mjs`. This repository (`DonSquires/Field-Compliance-Manager-` `main`) is the authoritative home from now on; the GitLab text is lineage. Edit here and record the ruling — never fork the text. Links to files that do not exist in this repo refer to that lineage.

# Officer Welfare / Lone-Worker Safety — Investigation (New vs Old Build)

**Date:** 2026-06-27
**Companion to:** `PATROL_MODULE_INVESTIGATION.md`, `PATROL_ENTERPRISE_TARGET.md`
**Mandate:** old build had the depth we want; new build is the modern architecture.
Achieve an enterprise-grade lone-worker safety system fitting NZ safety law + practice.

---

## TL;DR

The **old build had a complete, HSWA-2015-grade lone-worker safety suite.** The **new
build has only a thin countdown-timer** welfare hook. The supporting tables
(`officer_welfare_settings`, `officer_welfare_alerts`, `officer_activity_log`) still exist
on the live DB (from the old build) but the new app barely uses them.

**This is a major safety-capability regression** that must be closed for an enterprise NZ
security deployment. Plan below; no destructive changes.

---

## 1. Regulatory grounding (NZ)

- **HSWA 2015 s36 (PCBU duties) / s38 (worker duties)** — a PCBU must ensure, so far as
  reasonably practicable, the health & safety of workers, explicitly including **isolated/
  lone workers**. The old build cited these for welfare + man-down.
- **WorkSafe NZ — working alone / remote & isolated work** — requires: agreed-interval
  communication, a **fail-safe** (no response → escalation), and a documented monitoring
  trail.
- **Privacy Act 2020** — officer GPS/welfare data minimised, org-scoped, retained as needed.

**Implication:** welfare monitoring must be **active, configurable, fail-safe (auto-escalate
without human action), and auditable.**

---

## 2. Old build welfare (the depth to re-inherit)

### Schema
- **`officer_welfare_settings`** (per-officer, auto-provisioned by trigger on officer
  creation): `auto_logoff_enabled`, `welfare_check_enabled`, `inactivity_warning_time`,
  `auto_logoff_time`, `gps_inactivity_threshold`, `admin_escalation_time`,
  `critical_escalation_time`, `investigation_exception_enabled`, plus man-down:
  `man_down_enabled`, `man_down_stationary_minutes` (15), `man_down_escalation_minutes` (5).
- **`officer_activity_log`** — `activity_type` (vehicle_scan, gps_update, investigation_
  start/end, login, logout), GPS, metadata. Basis for **GPS-inactivity** detection.
- **`officer_welfare_alerts`** — `alert_type` (inactivity, gps_lost, manual,
  investigation_overdue, man_down), `status` (pending/acknowledged/resolved),
  **`escalation_level` 1→2→3**, `acknowledged_by/at`, `resolved_by/at`, `officer_phone`,
  `last_activity_at`, `escalated_at`, `acknowledgement_notes`, `resolution_notes`.
- RLS: officers insert/update **own** alerts (man-down self-trigger + self-resolve);
  admins manage org; service_role full.

### Frontend safety suite (hooks)
- **`useManDownDetection`** — 15s checks; Haversine movement threshold **15 m**; fires
  `man_down` after `stationary_minutes`; **auto-escalates to L2** after `escalation_minutes`;
  **auto-resolves on movement**; “I’m OK” self-resolve; persistent toast.
- **`useOfficerWelfareMonitor`** — admin: list alerts, **acknowledge** + **resolve** with
  notes, settings CRUD, welfare stats (pending/ack/resolved/escalated/by-type).
- **`useFallDetection`** — accelerometer fall detection.
- **`useShakeDetection`** — shake-to-alert.
- **`useBluetoothPanicButton`** — hardware panic button.
- **`useSessionInactivityLock`** — auto-logoff / session lock.
- **`useSessionGpsLogging`** — GPS heartbeat → activity log.

---

## 3. New build welfare (what exists today)

- **`useWelfareCheckin`** (`apps/web/src/hooks/useWelfareCheckin.ts`): countdown timer
  reading `officer_welfare_settings.check_interval_minutes` + `last_checkin_at`. Status
  ok/due/overdue/man_down. **man_down is TIME-based** (2× interval, !242), not GPS-stationary.
  Writes `check_in`/`sos`/`missed` alerts (!248). SOS latches.
- **`WelfareAlertsPage`** — admin list + acknowledge/resolve + 20s poll + realtime (!244).
- **`OfficerShell` FieldSafetyBar** — welfare countdown, SOS, man_down label, **Armed Danger
  overlay** (!257).

### What’s MISSING vs old build
| Capability | Old | New |
|-----------|-----|-----|
| Configurable per-officer settings (consumed) | ✅ | ❌ (table exists, hook only reads interval) |
| GPS-stationary man-down (Haversine) | ✅ | ❌ (time-based only) |
| 3-tier escalation ladder (L1→L2→L3) | ✅ | ⚠️ flat (overdue→man_down) |
| Activity log / GPS-inactivity detection | ✅ | ❌ |
| Fall detection | ✅ | ❌ |
| Shake-to-alert | ✅ | ❌ |
| Bluetooth panic button | ✅ | ❌ |
| Auto-logoff / inactivity lock | ✅ | ❌ |
| Admin welfare settings UI | ✅ | ❌ |
| Investigation exception | ✅ | ❌ |
| Acknowledge THEN resolve, with notes + audit | ✅ | ⚠️ (WelfareAlertsPage has ack/resolve; not notes-rich) |

---

## 4. Target welfare model (enterprise NZ)

Keep the new architecture (FieldSafetyBar, WelfareAlertsPage, realtime); **re-inherit the
old depth** on top:

1. **Configurable settings, honoured by the app.** `useWelfareCheckin` reads the full
   `officer_welfare_settings` (interval, escalation timings, man-down config, auto-logoff).
   Admin settings UI (per-org defaults + per-officer override). Auto-provision defaults.
2. **GPS-stationary man-down.** Port `useManDownDetection` (Haversine 15 m, configurable
   `man_down_stationary_minutes`, auto-escalate, auto-resolve on movement). This is the
   correct lone-worker fail-safe vs pure time-based.
3. **Escalation ladder L1→L2→L3** with timings from settings; supervisor must acknowledge
   then resolve; full audit (`acknowledged_by/at`, `resolved_by/at`, notes, `escalated_at`).
4. **Activity log** for GPS-inactivity + audit (`officer_activity_log`); GPS heartbeat
   already runs in OfficerShell — also write activity rows.
5. **Sensor fail-safes (phase 2, mobile-dependent):** fall detection, shake-to-alert,
   Bluetooth panic. Web-first now (SOS button + man-down); full sensors land with the
   mobile app (Layer 5).
6. **Auto-logoff / inactivity lock** for unattended devices (optional, configurable).

---

## 5. Plan (phased; safety-first; check LIVE_SCHEMA before each migration)

| # | Item | Type |
|---|------|------|
| W1 | Welfare settings parity: confirm live `officer_welfare_settings` columns; ADD any missing; `useWelfareCheckin` honours all thresholds + man-down config; auto-provision defaults | migration + hook |
| W2 | GPS-stationary man-down: port `useManDownDetection` into the new OfficerShell (replace/augment the time-based man_down); auto-escalate + auto-resolve | hook + shell wiring |
| W3 | Escalation ladder + ack/resolve-with-notes in WelfareAlertsPage; alert_type parity (inactivity/gps_lost/manual/investigation_overdue/man_down) | UI + small migration |
| W4 | Activity log: write `officer_activity_log` from the GPS heartbeat + key actions; basis for gps_lost/inactivity alerts | hook + migration |
| W5 | Admin welfare settings UI (per-org default + per-officer override) | new page + AdminShell wiring |
| W6 | (Layer 5 / mobile) fall detection, shake-to-alert, Bluetooth panic, auto-logoff | mobile |

**Order rationale:** W1→W2 deliver the core HSWA fail-safe (configurable + GPS man-down).
W3→W4 complete the audit + escalation. W5 is admin control. W6 is mobile-sensor depth.

---

## 6. Non-negotiables
- Fail-safe: no human response → automatic escalation (HSWA).
- Man-down must be GPS-stationary-based, not time-only, for real lone-worker safety.
- Every ack/resolve/escalation recorded (auditable, defensible).
- Org-scoped RLS; officer can self-trigger + self-resolve own alerts.
- Additive, idempotent migrations; check `docs/db/LIVE_SCHEMA.md` first.
