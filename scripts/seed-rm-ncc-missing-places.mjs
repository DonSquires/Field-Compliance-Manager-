import { createHash } from 'node:crypto';

const apply = process.argv.includes('--apply');
const token = process.env.SUPABASE_ACCESS_TOKEN || process.env.FIELD_COMPLIANCE_CODESPACE;
if (!token) throw new Error('A Supabase management credential is required for this bounded seed');
const provider = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13';
const client = '405fc1f7-45e8-4736-a517-885bb3e5ef95';
const source = {
  file: 'ACTIVE NelsonCityCouncil patrol NCC.xlsx', sheet: 'DATA',
  sha256: 'a6fcc1937b600eac5530e1a4977e4b7aa54ebac639b017a594f46d1a76a6d143',
  decision: 'Owner authorized creation of missing source-backed places on 2026-10-20; no geometry or agreement coverage inferred',
};
const places = [
  { name: 'Branford Park (NCC)', source_rows: [1484, 1485, 1506, 1507, 1508, 1515, 1516, 1518] },
  { name: 'Neale Park (NCC)', source_rows: [1622, 1634, 1637, 1642, 1643, 1646, 1647] },
  { name: 'Queens Garden (NCC)', source_rows: [2153, 2154] },
  { name: 'Peppertree Park (NCC)', source_rows: [2232, 2234, 2235] },
].map(place => ({ ...place, request_id: createHash('md5').update(`rm-source-place:v1:${client}:${place.name}`).digest('hex') }));
const encoded = Buffer.from(JSON.stringify({ source, places })).toString('base64');
const query = `BEGIN;
SET LOCAL request.jwt.claim.sub = 'f1c00000-0000-4000-8000-000000000001';
SET LOCAL statement_timeout = '30s';
CREATE TEMP TABLE source_place_receipts(name text,location_id uuid,zone_id uuid,canonical_place_id uuid,created_location boolean,created_zone boolean) ON COMMIT DROP;
DO $seed$
DECLARE
  v_data jsonb:=convert_from(decode('${encoded}','base64'),'UTF8')::jsonb;
  v_place jsonb;
  v_location public.locations%rowtype;
  v_zone public.location_zones%rowtype;
  v_location_created boolean;
  v_zone_created boolean;
  v_count integer;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.import_source_profiles
    WHERE organization_id='${provider}'::uuid AND profile_code='rm_patrol_log' AND active AND import_actor_id=auth.uid())
    THEN RAISE EXCEPTION 'Configured provider import identity required'; END IF;
  FOR v_place IN SELECT value FROM jsonb_array_elements(v_data->'places') LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('${client}:'||(v_place->>'name'),0));
    SELECT count(*) INTO v_count FROM public.locations
    WHERE organization_id='${client}'::uuid AND lower(name)=lower(v_place->>'name');
    IF v_count>1 THEN RAISE EXCEPTION 'Duplicate client houses require review before source mapping'; END IF;
    SELECT * INTO v_location FROM public.locations
    WHERE organization_id='${client}'::uuid
      AND (client_request_id=(v_place->>'request_id')::uuid OR lower(name)=lower(v_place->>'name'))
    ORDER BY (client_request_id=(v_place->>'request_id')::uuid) DESC LIMIT 1;
    v_location_created:=NOT FOUND;
    IF v_location_created THEN
      IF EXISTS(SELECT 1 FROM public.canonical_places
        WHERE status<>'merged' AND lower(display_name) IN (
          lower(v_place->>'name'),lower(regexp_replace(v_place->>'name',' \\(NCC\\)$',''))))
        THEN RAISE EXCEPTION 'Registry match requires an existing-place link rather than a new place'; END IF;
      v_location:=public.manage_crm_location(
        (v_place->>'request_id')::uuid,'${client}'::uuid,'create',v_place->>'name',
        NULL,NULL,NULL,
        'Source: '||(v_data->'source'->>'file')||'; sheet '||(v_data->'source'->>'sheet')||
        '; rows '||(v_place->'source_rows')::text||'; workbook SHA-256 '||(v_data->'source'->>'sha256')||
        '. Named source place only. Unplaced; no verified boundary, address, public-access right or legal restriction asserted.'
      );
    END IF;
    IF v_location.canonical_place_id IS NULL THEN RAISE EXCEPTION 'Canonical registry link required'; END IF;
    SELECT count(*) INTO v_count FROM public.location_zones
    WHERE location_id=v_location.id AND module_key='patrol' AND is_active;
    IF v_count>1 THEN RAISE EXCEPTION 'Multiple patrol facets require review'; END IF;
    SELECT * INTO v_zone FROM public.location_zones
    WHERE location_id=v_location.id AND module_key='patrol' AND is_active LIMIT 1;
    v_zone_created:=NOT FOUND;
    IF v_zone_created THEN
      v_zone:=public.manage_crm_zone('create',NULL,v_location.id,NULL,v_place->>'name',
        'general','patrol','unrestricted',true,NULL,NULL,false,NULL);
    END IF;
    IF v_zone.organization_id<>'${client}'::uuid OR v_zone.location_id<>v_location.id THEN
      RAISE EXCEPTION 'Source place ownership mismatch'; END IF;
    IF v_zone_created AND (v_zone.center_point IS NOT NULL OR v_zone.boundary IS NOT NULL
      OR v_zone.boundary_verification<>'unverified') THEN RAISE EXCEPTION 'New source place must remain unplaced and unverified'; END IF;
    IF v_location_created OR v_zone_created THEN
      INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
      VALUES('${provider}'::uuid,auth.uid(),'rm_source_place_registered','location_zones',v_zone.id,
        jsonb_build_object('client_organization_id','${client}','location_id',v_location.id,
          'canonical_place_id',v_location.canonical_place_id,'source',v_data->'source','source_rows',v_place->'source_rows',
          'geometry_inferred',false,'agreement_coverage_changed',false));
    END IF;
    INSERT INTO source_place_receipts VALUES(v_place->>'name',v_location.id,v_zone.id,v_location.canonical_place_id,v_location_created,v_zone_created);
  END LOOP;
END;
$seed$;
SELECT * FROM source_place_receipts ORDER BY name;
${apply ? 'COMMIT;' : 'ROLLBACK;'}`;
const response = await fetch('https://api.supabase.com/v1/projects/dotczcyyzgabmtmnglqj/database/query', {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query }), signal: AbortSignal.timeout(45000),
});
const result = await response.json();
if (!response.ok) {
  console.error(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', status: response.status,
    primary_error: String(result.message ?? 'Place seed rejected').split('\n')[0].slice(0, 300) }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', places: result,
    geometry_inferred: false, agreement_coverage_changed: false }));
}