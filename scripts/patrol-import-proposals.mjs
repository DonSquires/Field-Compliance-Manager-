function sourceEvidence(input) {
  const { payload } = input;
  return {
    evidence_external_ref: input.externalRef,
    evidence_record_type: input.evidenceRecordType,
    client_organization_id: input.clientOrganizationId,
    client_code: input.clientCode,
    source_profile: payload.classification_profile,
    source_file: payload.source_file,
    source_sha256: payload.source_sha256,
    derivative_sha256: payload.derivative_sha256,
    source_sheet: payload.source_sheet,
    source_row: payload.source_row,
    job_number: payload.job_number,
    patroller_raw: payload.patroller_raw,
    location_raw: payload.location_raw,
    reserve_raw: payload.reserve_raw,
    source_category: payload.source_category,
    subject: payload.subject,
    issue: payload.issue,
    comments: payload.comments,
    work_subject_code: payload.work_subject_code,
    work_activity_code: payload.work_activity_code,
    job_cost: payload.job_cost,
    travel_cost: payload.travel_cost,
    total_cost: payload.total_cost,
    classification_rule_ids: payload.classification_rule_ids,
  };
}

export function buildPatrolImportProposals(input) {
  const { payload } = input;
  const sourceValues = sourceEvidence(input);
  const proposals = [];

  if (
    payload.work_order_candidate === true
    && payload.work_subject_code_id
    && payload.work_activity_code_id
    && (input.zoneId || input.siteId)
  ) {
    const title = [payload.subject, payload.issue].filter(Boolean).join(' - ') || payload.job_number || 'Imported field work';
    proposals.push({
      source_record_key: input.externalRef,
      source_row_number: payload.source_row,
      target_type: 'workshop_work_order',
      proposed_payload: {
        organization_id: input.providerOrganizationId,
        client_organization_id: input.clientOrganizationId,
        kind: 'maintenance',
        title,
        description: payload.comments,
        work_subject_code_id: payload.work_subject_code_id,
        work_activity_code_id: payload.work_activity_code_id,
        client_site_id: input.siteId,
        zone_id: input.zoneId,
        assigned_user_id: input.officerId,
        scheduled_for: input.occurredAt,
        evidence_record_type: input.evidenceRecordType,
        evidence_external_ref: input.externalRef,
      },
      source_values: sourceValues,
      confidence: null,
    });
  }

  return proposals;
}
