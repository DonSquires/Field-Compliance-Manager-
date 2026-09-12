# finance-akahu-apply-report

Creates and checks the status of an Akahu Apply report for a tenant-scoped local application.

Required secret:

- `AKAHU_APPLY_API_KEY`

Create request:

```json
{
  "action": "create",
  "application_id": "<local finance_akahu_apply_applications.id>",
  "document_ids": ["doc_xxxxxxxxxxxxxxxxxxxxxxxx"]
}
```

Status request:

```json
{
  "action": "status",
  "application_id": "<local finance_akahu_apply_applications.id>",
  "report_id": "report_xxxxxxxxxxxxxxxxxxxxxxxx"
}
```

Report results remain staged for human review. This function does not post transactions, match receipts, make payments, or submit IRD filings.
