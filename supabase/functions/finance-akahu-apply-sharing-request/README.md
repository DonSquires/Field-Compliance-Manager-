# finance-akahu-apply-sharing-request

Creates a tenant-scoped Akahu Apply sharing request for an existing local Apply application.

Required secret:

- `AKAHU_APPLY_API_KEY`

Optional secret:

- `AKAHU_APPLY_REDIRECT_URI`

Request body:

```json
{
  "application_id": "application_xxxxxxxxxxxxxxxxxxxxxxxx",
  "requested_days": 365,
  "allow_manual_uploads": true
}
```

The returned `link` is the applicant-facing Akahu Apply URL. The app must display it as a secure external step and must not collect bank credentials itself.
