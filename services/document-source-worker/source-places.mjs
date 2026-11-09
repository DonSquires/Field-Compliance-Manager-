import { createHash } from 'node:crypto';

// Owner ruling 2026-11-04: an R&M log location that matches no known place still becomes a
// place, so its entries reach the client report. Spelling slips are resolved to the existing
// place by the importer (scripts/rm-place-resolver.mjs) before a location reaches this step.
// A new place is a named, unplaced house with a patrol facet, created through the governed
// CRM RPCs as the source profile's import identity, and covered by the client's single active
// operational agreement. Anything ambiguous is held for a person rather than guessed.

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const MAX_NEW_PLACES_PER_SHEET = 10;
// Ceiling for a reviewed source map that raises the per-sheet limit for a catch-up run.
export const MAX_REVIEWED_PLACES = 50;

export function registeredPlaceName(name, suffix) {
  const base = String(name ?? '').replace(/\s+/g, ' ').trim();
  return suffix ? `${base} (${suffix})` : base;
}

function requestId(clientId, name) {
  const hex = createHash('md5').update(`rm-source-place:v1:${clientId}:${name}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// The places a plan asks for: only named locations, deduplicated by registered name.
export function placesToRegister(plan, sheet) {
  const byName = new Map();
  for (const place of plan?.unresolved_places ?? []) {
    if (!place?.name) continue;
    const name = registeredPlaceName(place.name, sheet.place_name_suffix);
    const entry = byName.get(name) ?? { name, source_name: place.name, reserve_codes: [], locations: [], source_rows: [] };
    for (const field of ['reserve_codes', 'locations', 'source_rows']) {
      for (const value of place[field] ?? []) if (!entry[field].includes(value)) entry[field].push(value);
    }
    byName.set(name, entry);
  }
  return [...byName.values()];
}

export function placeRegistrationSql({ actorId, providerId, clientId, source, places, commit, limit = MAX_NEW_PLACES_PER_SHEET }) {
  if (![actorId, providerId, clientId].every(id => UUID.test(id ?? ''))) throw new Error('Place registration needs valid identities');
  if (!places.length || places.length > Math.min(limit, MAX_REVIEWED_PLACES)) throw new Error('Place registration volume is out of range');
  const data = {
    source: { file: source.file, sheet: source.sheet, sha256: source.sha256 },
    places: places.map(place => ({ name: place.name, source_name: place.source_name,
      source_rows: place.source_rows.slice(0, 50), request_id: requestId(clientId, place.name) })),
  };
  const encoded = Buffer.from(JSON.stringify(data)).toString('base64');
  return `BEGIN;
SET LOCAL request.jwt.claim.sub = '${actorId}';
SET LOCAL statement_timeout = '60s';
CREATE TEMP TABLE source_place_receipts(name text,status text,zone_id uuid,agreement_linked boolean) ON COMMIT DROP;
DO $places$
DECLARE
  v_data jsonb:=convert_from(decode('${encoded}','base64'),'UTF8')::jsonb;
  v_place jsonb;
  v_location public.locations%rowtype;
  v_zone public.location_zones%rowtype;
  v_agreement uuid;
  v_agreements integer;
  v_created boolean;
  v_linked boolean;
  v_count integer;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.import_source_profiles
    WHERE organization_id='${providerId}'::uuid AND profile_code='rm_patrol_log' AND active AND import_actor_id=auth.uid())
    THEN RAISE EXCEPTION 'Configured provider import identity required'; END IF;
  SELECT count(*),min(sa.id::text)::uuid INTO v_agreements,v_agreement FROM public.service_agreements sa
  WHERE sa.provider_organization_id='${providerId}'::uuid AND sa.client_organization_id='${clientId}'::uuid
    AND sa.agreement_type='operational' AND sa.invitation_status='accepted'
    AND (sa.ends_on IS NULL OR sa.ends_on>=current_date);
  IF v_agreements<>1 THEN v_agreement:=NULL; END IF;
  FOR v_place IN SELECT value FROM jsonb_array_elements(v_data->'places') LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('${clientId}:'||lower(v_place->>'name'),0));
    SELECT count(*) INTO v_count FROM public.locations
    WHERE organization_id='${clientId}'::uuid AND lower(name)=lower(v_place->>'name');
    IF v_count>1 THEN
      INSERT INTO source_place_receipts VALUES(v_place->>'name','duplicate_house_review',NULL,false); CONTINUE;
    END IF;
    SELECT * INTO v_location FROM public.locations
    WHERE organization_id='${clientId}'::uuid
      AND (client_request_id=(v_place->>'request_id')::uuid OR lower(name)=lower(v_place->>'name'))
    ORDER BY (client_request_id=(v_place->>'request_id')::uuid) DESC LIMIT 1;
    v_created:=NOT FOUND;
    IF v_created THEN
      IF EXISTS(SELECT 1 FROM public.canonical_places WHERE status<>'merged'
        AND lower(display_name) IN (lower(v_place->>'name'),lower(v_place->>'source_name'))) THEN
        INSERT INTO source_place_receipts VALUES(v_place->>'name','registry_match_review',NULL,false); CONTINUE;
      END IF;
      v_location:=public.manage_crm_location(
        (v_place->>'request_id')::uuid,'${clientId}'::uuid,'create',v_place->>'name',NULL,NULL,NULL,
        'Source: '||(v_data->'source'->>'file')||'; sheet '||(v_data->'source'->>'sheet')||
        '; rows '||(v_place->'source_rows')::text||'; workbook SHA-256 '||(v_data->'source'->>'sha256')||
        '. Named source place only. Unplaced; no verified boundary, address, public-access right or legal restriction asserted.');
    END IF;
    IF v_location.canonical_place_id IS NULL THEN RAISE EXCEPTION 'Canonical registry link required'; END IF;
    SELECT count(*) INTO v_count FROM public.location_zones WHERE location_id=v_location.id AND is_active;
    IF v_count>1 THEN
      INSERT INTO source_place_receipts VALUES(v_place->>'name','multiple_facets_review',NULL,false); CONTINUE;
    END IF;
    SELECT * INTO v_zone FROM public.location_zones WHERE location_id=v_location.id AND is_active LIMIT 1;
    IF NOT FOUND THEN
      v_created:=true;
      v_zone:=public.manage_crm_zone('create',NULL,v_location.id,NULL,v_place->>'name',
        'general','patrol','unrestricted',true,NULL,NULL,false,NULL);
    END IF;
    IF v_zone.organization_id<>'${clientId}'::uuid OR v_zone.location_id<>v_location.id THEN
      RAISE EXCEPTION 'Source place ownership mismatch'; END IF;
    v_linked:=false;
    IF v_agreement IS NOT NULL THEN
      -- An existing link is left alone, including one a person deliberately ended.
      INSERT INTO public.service_agreement_locations(service_agreement_id,zone_id,status,created_by)
      VALUES(v_agreement,v_zone.id,'active',auth.uid()) ON CONFLICT DO NOTHING;
      v_linked:=FOUND;
    END IF;
    IF v_created OR v_linked THEN
      INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
      VALUES('${providerId}'::uuid,auth.uid(),'rm_source_place_registered','location_zones',v_zone.id,
        jsonb_build_object('client_organization_id','${clientId}','location_id',v_location.id,
          'canonical_place_id',v_location.canonical_place_id,'source',v_data->'source','source_rows',v_place->'source_rows',
          'geometry_inferred',false,'agreement_id',v_agreement,'agreement_coverage_changed',v_linked));
    END IF;
    INSERT INTO source_place_receipts VALUES(v_place->>'name',CASE WHEN v_created THEN 'created' ELSE 'existing' END,
      v_zone.id,v_linked OR EXISTS(SELECT 1 FROM public.service_agreement_locations l
        WHERE l.zone_id=v_zone.id AND l.service_agreement_id=v_agreement AND l.status='active'));
  END LOOP;
END;
$places$;
SELECT name,status,zone_id,agreement_linked FROM source_place_receipts ORDER BY name;
${commit ? 'COMMIT;' : 'ROLLBACK;'}`;
}

// Maps each original location text (or the reserve code, when the row had no location) to the
// registered zone, so the re-exported plan resolves those rows. Reserve codes are only used when
// they named the place: a shared code must not pull other locations onto the new place.
export function placeOverlay(places, receipts) {
  const overlay = {};
  for (const place of places) {
    const receipt = receipts.find(row => row.name === place.name);
    if (!receipt?.zone_id || !['created', 'existing'].includes(receipt.status)) continue;
    const keys = place.locations.length ? place.locations : place.reserve_codes;
    for (const key of keys) overlay[key] = receipt.zone_id;
  }
  return overlay;
}
