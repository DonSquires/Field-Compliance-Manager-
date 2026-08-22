# FCM Bob Control-Plane Implementation Runbook

## Target infrastructure

- VPS: `1601189`
- Application root: `/opt/fcm`
- Supabase project ref: `dotczcyyzgabmtmnglqj`
- Supabase local project directory: `/opt/fcm/supabase`
- Existing Edge Function: `/opt/fcm/supabase/functions/onspace-ai-chat`
- Existing function modules include:
  - `index.ts`
  - `constitutional-lane.ts`
  - `caddie.ts`
  - `query-records-conductor.ts`
  - `conductor-welfare-seam.ts`

## Implementation target

Update `onspace-ai-chat` to consume the control-plane schema already present in Supabase. Do not recreate the schema manually in the function and do not replace the existing conductor modules.

The function must:

1. Load enabled, non-retired tools from `public.bob_tool_registry`.
2. Apply `public.bob_tool_tenant_policy` overrides for the active organization.
3. Rank tools against the user intent.
4. Dispatch the selected tool through the existing conductor implementation.
5. Retry the next ranked candidate only when the failed tool is retryable.
6. Insert one row into `public.bob_tool_executions` for every attempted step.
7. Insert a pending row into `public.bob_action_approvals` when approval is required.
8. Return `blocked_approval` without executing the protected tool.
9. Return the normalized envelope:

```ts
{
  ok: boolean,
  status: 'success' | 'partial' | 'failed' | 'blocked_approval',
  retryable: boolean,
  requires_approval: boolean,
  data: unknown | null,
  error: {
    code: string | null,
    message: string | null,
    details: unknown
  },
  meta: {
    tool_key: string,
    latency_ms: number,
    request_id: string
  }
}
```

## Step 1: Open the VPS project

Use the VPS terminal for VPS `1601189`, then run:

```bash
cd /opt/fcm
pwd
find supabase/functions/onspace-ai-chat -maxdepth 2 -type f
find supabase/migrations -maxdepth 1 -type f | tail -20
```

Confirm that the working tree is the intended FCM source before editing. Do not edit the deployed Docker images or the `/opt/fcm/docker-compose.api.yml` services for this change; this is a Supabase migration and Edge Function change.

## Step 2: Create the control-plane module directory

Create:

```text
/opt/fcm/supabase/functions/onspace-ai-chat/control-plane/
```

Add these files:

```text
control-plane/types.ts
control-plane/registry.ts
control-plane/audit.ts
control-plane/approval.ts
control-plane/planner.ts
control-plane/executor.ts
```

Use the Supabase AI skeleton as the type contract. In particular:

- `ToolRegistryRow` must include `tool_key`, `display_name`, `description`, `endpoint_url`, `http_method`, `auth_mode`, `risk_level`, `requires_approval`, `timeout_ms`, `retry_limit`, `enabled`, and `retired_at`.
- Tenant policy must support `enabled` and nullable `requires_approval_override`.
- `loadActiveTools()` must filter `enabled = true` and `retired_at IS NULL`.
- A tenant policy of `enabled = false` excludes the tool.
- A non-null approval override replaces the registry approval setting.

Use imports compatible with the existing function, for example:

```ts
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
```

## Step 3: Wire the existing orchestrator

Edit:

```text
/opt/fcm/supabase/functions/onspace-ai-chat/index.ts
```

Do not remove the existing constitutional lane, caddie, welfare seam, or query-records conductor logic.

Add the control-plane flow at the point where the function currently decides which operational action or conductor to invoke:

```text
request received
  -> resolve authenticated user and organization
  -> create or preserve request_id
  -> load active registry and tenant policy
  -> rank matching candidates
  -> check approval before execution
  -> execute via existing conductor module
  -> log execution attempt
  -> retry next candidate only when retryable
  -> return normalized envelope
```

The existing conductor should remain the only layer that knows how to call:

- `endpoint_probe`
- `endpoint_call`
- `repo_search`
- `schema_inspect`
- `query_records`
- `sql_read`
- `dispatch_flow`

Do not make direct arbitrary HTTP or SQL calls from the planner. Do not bypass approval for tools marked `write`, `destructive`, `deploy`, or `secret` unless the registry and tenant policy explicitly permit it.

## Step 4: Add the source-of-truth migration

Create:

```text
/opt/fcm/supabase/migrations/20260822_bob_control_plane.sql
```

Copy the already-approved idempotent DDL into this file for:

- `public.bob_tool_registry`
- `public.bob_tool_contracts`
- `public.bob_tool_executions`
- `public.bob_action_approvals`
- `public.bob_tool_tenant_policy`
- RLS on all five tables
- Seed upserts for exactly these seven tools:
  - `endpoint_probe`
  - `endpoint_call`
  - `repo_search`
  - `schema_inspect`
  - `query_records`
  - `sql_read`
  - `dispatch_flow`

Because the schema already exists in Supabase, the migration must be idempotent. Do not drop, truncate, or recreate the existing tables. If the exact approved DDL is not available in the repository, stop before writing guessed column definitions and obtain the DB-approved DDL.

## Step 5: Review locally before deployment

From `/opt/fcm`:

```bash
supabase link --project-ref dotczcyyzgabmtmnglqj
supabase db diff
supabase functions serve onspace-ai-chat
```

Check the diff carefully. It must not contain destructive table drops or unrelated schema changes.

Run the function against these cases:

1. Read-only request matching `query_records`.
2. Schema request matching `schema_inspect`.
3. Repository request matching `repo_search`.
4. Request requiring an approval.
5. A retryable tool failure followed by a successful fallback.
6. No matching tool.

## Step 6: Deploy in this order

From `/opt/fcm`:

```bash
supabase link --project-ref dotczcyyzgabmtmnglqj
supabase db push
supabase functions deploy onspace-ai-chat
supabase functions list
```

The deployment command must be entered as one line:

```bash
supabase functions deploy onspace-ai-chat
```

Do not deploy the function before the migration has completed successfully.

## Step 7: Verify the database

In the Supabase SQL Editor for project `dotczcyyzgabmtmnglqj`, run:

```sql
select count(*)
from public.bob_tool_registry;
```

Expected result: `7`.

Then:

```sql
select tool_key, enabled, requires_approval, retired_at
from public.bob_tool_registry
order by tool_key;
```

Confirm that all seven seeded tools are present and active.

Verify audit behavior after one test request:

```sql
select request_id, step_index, tool_key, latency_ms, error
from public.bob_tool_executions
order by created_at desc
limit 20;
```

Verify approval behavior after a protected-action test:

```sql
select request_id, tool_key, status
from public.bob_action_approvals
order by created_at desc
limit 20;
```

## Stop conditions

Stop and report the exact issue if any of these occur:

- The migration proposes dropping or recreating existing control-plane tables.
- The actual DB columns do not match the approved TypeScript types.
- RLS prevents the function's intended service-role path from reading the registry.
- An approval-required tool executes before a pending approval is inserted.
- A failed non-retryable tool causes another tool to execute.
- Execution logs omit `request_id`, `step_index`, input/output, latency, or error information.
- The seven-tool registry count is not exactly `7` after deployment.

## Completion report format

Report only these items after deployment:

```text
Target VPS: 1601189
Supabase project: dotczcyyzgabmtmnglqj
Migration: applied / not applied
Function deployment: successful / unsuccessful
Registry count: <number>
Approval path: passed / failed
Execution logging: passed / failed
Retry fallback: passed / failed
Normalized envelope: passed / failed
Outstanding issue: <none or exact issue>
```