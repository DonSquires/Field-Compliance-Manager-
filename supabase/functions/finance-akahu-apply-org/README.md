# finance-akahu-apply-org

Server-side Akahu Apply configuration verification for finance administrators.

Required secret:

- `AKAHU_APPLY_API_KEY`

This function calls `GET /v1/orgs/current` with the Apply API key and returns only the Apply organisation ID and name. The key is never sent to the browser or written to the database.
