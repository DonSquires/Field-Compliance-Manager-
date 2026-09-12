# finance-akahu-apply-promote

Promotes approved Apply review rows into `finance_external_bank_transactions` for an organisation-owned bank connection.

Request body:

```json
{
  "connection_request_id": "<local finance_external_connection_requests.id>",
  "review_ids": ["<approved review row id>"]
}
```

The destination rows are always created with `reconciliation_status = 'review'`. Promotion does not match receipts, mark transactions as reconciled, make payments, or submit IRD filings. Deterministic external IDs make retries idempotent.
