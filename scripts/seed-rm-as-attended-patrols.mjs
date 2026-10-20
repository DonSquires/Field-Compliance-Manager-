import { readFileSync } from 'node:fs';

const policy = JSON.parse(readFileSync(new URL('./data/rm-attendance-patrol-policy.json', import.meta.url), 'utf8'));
const apply = process.argv.includes('--apply');
const token = process.env.SUPABASE_ACCESS_TOKEN || process.env.FIELD_COMPLIANCE_CODESPACE;
if (!token) throw new Error('A Supabase management credential is required for this bounded seed');
if (policy.provider_organization_id !== 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13' || policy.attendance_mode !== 'as_attended') {
  throw new Error('Approved R&M attendance policy required');
}
const encoded = Buffer.from(JSON.stringify(policy)).toString('base64');
const query = `BEGIN;
SET LOCAL request.jwt.claim.sub='f1c00000-0000-4000-8000-000000000001';
SET LOCAL statement_timeout='90s';
CREATE TEMP TABLE attendance_seed_receipts(client_organization_id uuid,route_id uuid,site_id uuid,zone_id uuid,result text,reason text,schedule_id uuid) ON COMMIT DROP;
DO $seed$
DECLARE
  v_policy jsonb:=convert_from(decode('${encoded}','base64'),'UTF8')::jsonb;
  v_provider uuid:=(v_policy->>'provider_organization_id')::uuid;
  v_candidate record;
  v_agreement uuid;
  v_agreements integer;
  v_result jsonb;
  v_request uuid;
  v_existing public.service_agreement_delivery_schedules%rowtype;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.import_source_profiles WHERE organization_id=v_provider
    AND profile_code='rm_patrol_log' AND active AND import_actor_id=auth.uid()) THEN
    RAISE EXCEPTION 'Configured provider import identity required';
  END IF;
  FOR v_candidate IN
    WITH mapping AS (
      SELECT (value->>'performer_id')::uuid AS performer_id,(value->>'patrol_route_id')::uuid AS route_id
      FROM jsonb_array_elements(v_policy->'performer_routes')
    ), attended AS (
      SELECT o.organization_id,o.site_id,o.zone_id,mapping.route_id FROM public.observations o JOIN mapping ON mapping.performer_id=o.officer_id
      WHERE o.module_key='patrol' AND o.external_refs->'import'->>'source'='rm_patrol_log_import'
      UNION ALL
      SELECT e.organization_id,e.client_site_id,e.zone_id,mapping.route_id FROM public.location_events e JOIN mapping ON mapping.performer_id=e.observed_entity_id
      WHERE e.source='rm_patrol_log_import' AND e.event_type='patrol_visit'
    )
    SELECT DISTINCT organization_id,site_id,zone_id,route_id FROM attended
    WHERE (site_id IS NULL)<>(zone_id IS NULL) ORDER BY organization_id,site_id,zone_id,route_id
  LOOP
    SELECT count(*),(array_agg(id ORDER BY created_at))[1] INTO v_agreements,v_agreement
    FROM public.service_agreements WHERE provider_organization_id=v_provider
      AND client_organization_id=v_candidate.organization_id AND agreement_type='operational'
      AND invitation_status IN ('not_invited','invited','accepted')
      AND (starts_on IS NULL OR starts_on<=current_date) AND (ends_on IS NULL OR ends_on>=current_date);
    IF v_agreements<>1 THEN
      INSERT INTO attendance_seed_receipts VALUES(v_candidate.organization_id,v_candidate.route_id,v_candidate.site_id,v_candidate.zone_id,
        'held',CASE WHEN v_agreements=0 THEN 'active_agreement_required' ELSE 'ambiguous_agreement' END,NULL);
      CONTINUE;
    END IF;
    SELECT * INTO v_existing FROM public.service_agreement_delivery_schedules
    WHERE service_agreement_id=v_agreement AND active AND module_key='general_patrol'
      AND site_id IS NOT DISTINCT FROM v_candidate.site_id AND zone_id IS NOT DISTINCT FROM v_candidate.zone_id LIMIT 1;
    IF FOUND AND v_existing.work_model<>'as_attended_patrol' THEN
      INSERT INTO attendance_seed_receipts VALUES(v_candidate.organization_id,v_candidate.route_id,v_candidate.site_id,v_candidate.zone_id,
        'held','existing_timed_schedule_requires_review',v_existing.id);
      CONTINUE;
    END IF;
    v_request:=md5('rm-as-attended:v1:'||v_agreement::text||':'||coalesce(v_candidate.site_id,v_candidate.zone_id)::text||':'||v_candidate.route_id::text)::uuid;
    BEGIN
      v_result:=public.manage_crm_as_attended_patrol(v_request,v_agreement,v_candidate.route_id,
        v_candidate.site_id,v_candidate.zone_id,
        'As attended. Route coverage derived from human-authored R&M patrol-log completion under owner direction 2026-10-20.',v_provider);
      INSERT INTO attendance_seed_receipts VALUES(v_candidate.organization_id,v_candidate.route_id,v_candidate.site_id,v_candidate.zone_id,
        CASE WHEN coalesce((v_result->>'replayed')::boolean,false) THEN 'replayed' ELSE 'configured' END,NULL,(v_result->>'schedule_id')::uuid);
    EXCEPTION WHEN raise_exception THEN
      INSERT INTO attendance_seed_receipts VALUES(v_candidate.organization_id,v_candidate.route_id,v_candidate.site_id,v_candidate.zone_id,
        'held',CASE
          WHEN SQLERRM LIKE '%does not belong to this client%' THEN 'place_ownership_requires_review'
          WHEN SQLERRM LIKE '%Multiple active patrol schedules%' THEN 'multiple_active_schedules'
          ELSE 'governed_attendance_configuration_refused' END,NULL);
    END;
  END LOOP;
END;
$seed$;
SELECT route_id,result,reason,count(*)::integer AS places,count(DISTINCT client_organization_id)::integer AS client_organizations
FROM attendance_seed_receipts GROUP BY route_id,result,reason ORDER BY route_id,result,reason;
${apply ? 'COMMIT;' : 'ROLLBACK;'}`;
const response = await fetch('https://api.supabase.com/v1/projects/dotczcyyzgabmtmnglqj/database/query', {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query }), signal: AbortSignal.timeout(105000),
});
const result = await response.json();
if (!response.ok) {
  console.error(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', status: response.status,
    primary_error: String(result.message ?? 'Attendance seed rejected').split('\n')[0].slice(0, 300) }));
  process.exitCode = 1;
} else console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', results: result, shifts_created: 0, visits_fabricated: 0 }));