# finance-akahu-apply-application

Creates or reuses a tenant-scoped Akahu Apply application.

Required secret:

- `AKAHU_APPLY_API_KEY`

Request body:

```json
{ "reference": "finance-review:2026-09" }
```

The function reuses an existing local application for the same organisation and reference, then creates a remote Apply application only when needed. The API key remains server-side.
