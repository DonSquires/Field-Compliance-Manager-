# Atlas Wiring Status: Pages & Shells Rebuild

## Current State
- ✅ **Pages compiled**: All 5 core pages (AdminShell, OfficerShell, AdminHubPage, WelfareAlertsPage, DispatchConsolePage) compile with zero errors
- ✅ **Data queries real**: Pages query actual Supabase tables (observations, breach_alerts, shifts, officer_welfare_alerts, dispatch_jobs, etc.)
- ❌ **NOT in Atlas yet**: These pages are not registered in `bob_capability_map` or `bob_app_map_edges`

## What's Wired in Each Page

### AdminShell.tsx
- **Queries**: `organizations`, `user_profiles` (via auth context)
- **State**: Module gating via `enabledModules` from org
- **Edges needed**:
  - reads: organizations, user_profiles
  - invokes: BobPanel, NotificationsBell, PortalSwitcher, UniversalSearch
  - imports: hooks (useAuth, useOrganization)

### OfficerShell.tsx
- **Queries**: dispatch jobs (via useActiveShift), welfare checks (via useWelfareCheckin)
- **Tables**: dispatch_jobs, welfare_checks, welfare_alerts (man-down via useManDownDetection)
- **Hooks**: useWelfareCheckin, useManDownDetection, useActiveShift
- **Edges needed**:
  - reads: dispatch_jobs, welfare_checks, welfare_alerts, location_zones
  - imports: hooks (useWelfareCheckin, useManDownDetection, useActiveShift)
  - invokes: FieldSafetyBar, PttBar

### AdminHubPage.tsx
- **Tables queried**:
  - observations (count)
  - breach_alerts (count)
  - shifts (count)
  - officer_welfare_alerts (count)
  - observations (trend data with date range)
  - breach_alerts (trend data with date range)
- **Real-time**: Supabase.from().on('*', callback) subscriptions to breach_alerts and welfare_alerts
- **Edges needed**:
  - reads: observations, breach_alerts, shifts, officer_welfare_alerts
  - subscribes: breach_alerts, officer_welfare_alerts (real-time)

### WelfareAlertsPage.tsx
- **Tables queried**: officer_welfare_alerts (filtered by status and alert_type)
- **Actions**: acknowledge (PATCH), resolve (PATCH), contact officer
- **Real-time**: subscription to officer_welfare_alerts for new alerts
- **Edges needed**:
  - reads: officer_welfare_alerts, user_profiles (for officer names)
  - writes: officer_welfare_alerts (acknowledge, resolve)
  - subscribes: officer_welfare_alerts

### DispatchConsolePage.tsx
- **Phase A** - Queries:
  - dispatch_jobs (with joins to user_profiles, patrol_routes)
  - client_sites
  - dispatch_resources
  - officer_gps_log (latest per officer)
- **Phase B** - Queries:
  - dispatch_stops (for selected shift)
- **Phase C** - Queries:
  - operational_agreements (requester orgs)
  - RPC call: list_requester_orgs_by_geofence
- **Phase D** - Queries:
  - rate_rules (matching job_type + requester_org + zone)
- **Writes**:
  - INSERT dispatch_jobs
  - PATCH dispatch_jobs (assign)
- **Edges needed**:
  - reads: dispatch_jobs, client_sites, dispatch_resources, officer_gps_log, dispatch_stops, operational_agreements, rate_rules, shifts, user_profiles
  - writes: dispatch_jobs
  - calls: rate_resolution function, requester matching RPC
  - invokes: real-time subscription to dispatch_jobs

## What's NOT Yet Wired

### Missing Components
- BobPanel - declared but not yet implemented
- NotificationsBell - declared but not yet implemented
- PortalSwitcher - declared but not yet implemented
- UniversalSearch - declared but not yet implemented
- LazyPageFallback - declared but not yet implemented
- FieldSafetyBar - declared but not yet implemented
- PttBar - declared but not yet implemented

### Missing Container Pages
- CRMFinancePage (with tabs: invoicing, payments, financial-setup, etc.)
- RosterHRPage (with tabs: staff, training, shift-templates, etc.)
- FieldOperationsPage (with sub-areas: dispatch, patrol, live-map, welfare-alerts, etc.)
- ReportsPage (with tabs: reports-hub, obligations, fc-compliance, etc.)

### Missing Page Implementations
- LiveMapPage (444 lines) - GPS visualization, officer tracking
- OfficerMapPage (179 lines) - Officer-facing map view
- FieldOperationsPage (417 lines) - Field operations aggregation
- Module pages: Patrol, Breach Review, Noise Control, SCV Import, etc.

## Action Items to Complete Atlas Wiring

### Immediate (This Session)
1. **Seed bob_capability_map** with newly built pages:
   - apps/web/src/shells/AdminShell (present=true, wired=true, exercised=?)
   - apps/web/src/shells/OfficerShell (present=true, wired=true, exercised=?)
   - apps/web/src/pages/AdminHubPage (present=true, wired=true, exercised=true)
   - apps/web/src/pages/WelfareAlertsPage (present=true, wired=true, exercised=true)
   - apps/web/src/pages/DispatchConsolePage (present=true, wired=true, exercised=true)

2. **Create bob_app_map_edges** for real data flows:
   - AdminHubPage reads: observations, breach_alerts, shifts, officer_welfare_alerts
   - AdminHubPage subscribes: breach_alerts, officer_welfare_alerts
   - WelfareAlertsPage reads: officer_welfare_alerts, user_profiles
   - WelfareAlertsPage writes: officer_welfare_alerts
   - WelfareAlertsPage subscribes: officer_welfare_alerts
   - DispatchConsolePage reads: dispatch_jobs, client_sites, dispatch_resources, etc.
   - DispatchConsolePage writes: dispatch_jobs

3. **Run blast_radius check** on key entities:
   - What touches dispatch_jobs?
   - What touches officer_welfare_alerts?
   - What touches shifts?

### Follow-up (Next Session)
1. Build missing components (BobPanel, NotificationsBell, etc.)
2. Build container pages (CRM, Roster, Field Ops, Reports)
3. Wire them to Atlas
4. Run full terrain calibration

## Atlas Query Examples (Once Wired)

```sql
-- What pages touch dispatch_jobs?
SELECT source_name, edge_kind
FROM bob_app_map_edges
WHERE target_name = 'dispatch_jobs' AND retirement_status = 'live';

-- Blast radius of AdminHubPage
SELECT * FROM bob_atlas_flow_reach('component', 'AdminHubPage', 'downstream', 4);

-- Gap report: unwired or unexercised entities
SELECT * FROM bob_capability_map
WHERE (wired = false OR exercised IS NULL)
AND retirement_status != 'retired';
```

## Lessons for Atlas-First Development

✅ **Do**: Write the pages with real Supabase queries first
✅ **Do**: Verify the code compiles and types check out
✅ **Do**: Then seed the Atlas with what you actually did
✅ **Do**: Use blast_radius to find surprises before code review

❌ **Don't**: Build pages without knowing what tables they touch
❌ **Don't**: Trust that two files with similar data flows are actually connected
❌ **Don't**: Assume a page is "done" just because it renders

---

**Next Step**: Should I seed the Atlas now with the newly built pages, or would you prefer to inspect the actual code first?
