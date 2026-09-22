#!/usr/bin/env node
/*
 * Seeds the forestry-sector reference data (scripts/data/forestry-sector-rm.json) under a provider
 * organisation (R & M Security and Investigation): CRM organisations, service agreements, rule sets,
 * office Sites and forest-block Zones (provisional fences around gazetteer points), closures, audit rows.
 *
 * One transaction. Idempotent: every row is keyed by a deterministic request id / external_ref / seed_key,
 * so a re-run creates nothing that already exists. Writes only through the same tables the governed CRM
 * RPCs write, with the same states they would set (prospect orgs, provisional/unverified geometry).
 *
 *   node scripts/seed-forestry-sector-rm.mjs --dry-run   # BEGIN … report … ROLLBACK
 *   node scripts/seed-forestry-sector-rm.mjs --apply     # BEGIN … report … COMMIT
 *   node scripts/seed-forestry-sector-rm.mjs --apply --file scripts/data/other-seed.json
 *
 * Required: FIELD_COMPLIANCE_CODESPACE (Supabase management token; never printed).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_REF = 'dotczcyyzgabmtmnglqj';
const here = path.dirname(fileURLToPath(import.meta.url));
const fileArgIndex = process.argv.indexOf('--file');
const dataPath = fileArgIndex !== -1 && process.argv[fileArgIndex + 1]
  ? path.resolve(process.argv[fileArgIndex + 1])
  : path.join(here, 'data', 'forestry-sector-rm.json');
const mode = process.argv.includes('--apply') ? 'apply' : 'dry-run';
const token = process.env.FIELD_COMPLIANCE_CODESPACE;
if (!token) { console.error('FIELD_COMPLIANCE_CODESPACE is required'); process.exit(1); }

const raw = readFileSync(dataPath, 'utf8');
const data = JSON.parse(raw);
if (raw.includes('$json$')) throw new Error('data file must not contain the $json$ delimiter');

const body = `
DO $seed$
DECLARE
  v_data jsonb := $json$${raw}$json$::jsonb;
  v_seed text := v_data->>'seed_key';
  v_provider uuid := (v_data->>'provider_organization_id')::uuid;
  v_actor uuid := (v_data->>'actor_user_id')::uuid;
  v_org jsonb; v_site jsonb; v_zone jsonb; v_closure jsonb; v_defaults jsonb; v_mod text;
  v_org_id uuid; v_req uuid; v_rule_set_id uuid; v_agreement_id uuid; v_house_id uuid; v_site_id uuid; v_zone_id uuid;
  v_lat double precision; v_lng double precision; v_radius integer; v_point geometry; v_buffer geometry;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = v_provider AND organization_type = 'service_provider' AND active) THEN
    RAISE EXCEPTION 'Provider organisation % not found or not an active service_provider', v_provider;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL) THEN
    RAISE EXCEPTION 'Actor profile % not found', v_actor;
  END IF;

  -- Provider module enablement is an explicit opt-in in the data file: for a service_provider it creates a
  -- Layer-1 subscription line (tg_align_module_subscription), i.e. a billing change for the tenant.
  FOR v_mod IN SELECT jsonb_array_elements_text(coalesce(v_data->'provider_modules', '[]'::jsonb)) LOOP
    IF NOT EXISTS (SELECT 1 FROM public.organization_modules WHERE organization_id = v_provider AND module_key = v_mod) THEN
      INSERT INTO public.organization_modules (organization_id, module_key, enabled, settings) VALUES (v_provider, v_mod, true, jsonb_build_object('seed_key', v_seed, 'basis', v_data->>'provider_modules_basis'));
      INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
      VALUES (v_provider, v_actor, 'seed_forestry_sector.provider_module_enabled', 'organization_modules', v_provider, jsonb_build_object('seed_key', v_seed, 'module_key', v_mod, 'basis', v_data->>'provider_modules_basis', 'creates_subscription_line', true));
    END IF;
  END LOOP;

  FOR v_org IN SELECT * FROM jsonb_array_elements(v_data->'organizations') LOOP
    v_req := md5(v_seed || ':org:' || (v_org->>'key'))::uuid;
    SELECT id INTO v_org_id FROM public.organizations
     WHERE parent_organization_id = v_provider AND (client_request_id = v_req OR lower(name) = lower(v_org->>'name'))
     ORDER BY (client_request_id = v_req) DESC, created_at LIMIT 1;
    IF v_org_id IS NULL THEN
      INSERT INTO public.organizations (name, organization_type, parent_organization_id, active, status, contact_email, contact_phone, account_notes, external_refs, client_request_id)
      VALUES (v_org->>'name', v_org->>'organization_type', v_provider, coalesce((v_org->>'active')::boolean, false), coalesce(v_org->>'status', 'prospect'),
              v_org->>'contact_email', v_org->>'contact_phone', v_org->>'account_notes',
              jsonb_strip_nulls(jsonb_build_object('website', v_org->>'website', 'seed_key', v_seed, 'seed_entity_key', v_org->>'key', 'source_urls', v_org->'source_urls', 'facts', v_org->'facts', 'retrieved_at', v_data->>'retrieved_at')),
              v_req)
      RETURNING id INTO v_org_id;
      INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
      VALUES (v_provider, v_actor, 'seed_forestry_sector.organization_created', 'organizations', v_org_id, jsonb_build_object('seed_key', v_seed, 'key', v_org->>'key', 'status', coalesce(v_org->>'status', 'prospect'), 'source_urls', v_org->'source_urls'));
    END IF;

    -- Module enablement on the client org (non-provider: no Layer-1 subscription line is created).
    FOR v_mod IN SELECT jsonb_array_elements_text(coalesce(v_org->'modules', '[]'::jsonb)) LOOP
      IF NOT EXISTS (SELECT 1 FROM public.organization_modules WHERE organization_id = v_org_id AND module_key = v_mod) THEN
        INSERT INTO public.organization_modules (organization_id, module_key, enabled, settings) VALUES (v_org_id, v_mod, true, jsonb_build_object('seed_key', v_seed));
      END IF;
    END LOOP;

    IF jsonb_typeof(v_org->'agreement') = 'object' THEN
      SELECT id INTO v_agreement_id FROM public.service_agreements
       WHERE provider_organization_id = v_provider AND client_organization_id = v_org_id AND external_refs->>'seed_key' = v_seed;
      IF v_agreement_id IS NULL THEN
        INSERT INTO public.service_agreements (provider_organization_id, client_organization_id, name, agreement_type, enabled_modules, external_refs)
        VALUES (v_provider, v_org_id, v_org->'agreement'->>'name', 'operational',
                ARRAY(SELECT jsonb_array_elements_text(coalesce(v_org->'agreement'->'enabled_modules', '[]'::jsonb))),
                coalesce(v_org->'agreement'->'external_refs', '{}'::jsonb) || jsonb_build_object('seed_key', v_seed, 'evidence', v_org->'agreement'->>'evidence', 'evidence_urls', v_org->'agreement'->'evidence_urls', 'retrieved_at', v_data->>'retrieved_at'))
        RETURNING id INTO v_agreement_id;
        INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
        VALUES (v_provider, v_actor, 'seed_forestry_sector.agreement_created', 'service_agreements', v_agreement_id, jsonb_build_object('seed_key', v_seed, 'client_organization_id', v_org_id, 'evidence_urls', v_org->'agreement'->'evidence_urls'));
      END IF;
    END IF;

    v_rule_set_id := NULL;
    IF jsonb_typeof(v_org->'rule_set') = 'object' THEN
      SELECT id INTO v_rule_set_id FROM public.jurisdiction_rule_sets
       WHERE organization_id = v_org_id AND module_key = v_org->'rule_set'->>'module_key' AND name = v_org->'rule_set'->>'name';
      IF v_rule_set_id IS NULL THEN
        INSERT INTO public.jurisdiction_rule_sets (organization_id, module_key, name, jurisdiction_name, rules)
        VALUES (v_org_id, v_org->'rule_set'->>'module_key', v_org->'rule_set'->>'name', v_org->'rule_set'->>'jurisdiction_name', (v_org->'rule_set'->'rules') || jsonb_build_object('seed_key', v_seed))
        RETURNING id INTO v_rule_set_id;
        INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
        VALUES (v_provider, v_actor, 'seed_forestry_sector.rule_set_created', 'jurisdiction_rule_sets', v_rule_set_id, jsonb_build_object('seed_key', v_seed, 'organization_id', v_org_id, 'source', v_org->'rule_set'->'rules'->'source'));
      END IF;
    END IF;

    FOR v_site IN SELECT * FROM jsonb_array_elements(coalesce(v_org->'sites', '[]'::jsonb)) LOOP
      v_req := md5(v_seed || ':site:' || (v_site->>'key'))::uuid;
      SELECT id INTO v_house_id FROM public.locations
       WHERE organization_id = v_org_id AND (client_request_id = v_req OR address_match_key = public.address_match_key(v_site->>'address'))
       ORDER BY (client_request_id = v_req) DESC, created_at LIMIT 1;
      IF v_house_id IS NULL THEN
        INSERT INTO public.locations (organization_id, name, address, address_match_key, suburb, postcode, notes, created_by, client_request_id)
        VALUES (v_org_id, v_site->>'name', v_site->>'address', public.address_match_key(v_site->>'address'), v_site->>'suburb', v_site->>'postcode',
                '[seed:' || v_seed || '] published office address; source ' || (v_site->>'source'), v_actor, v_req)
        RETURNING id INTO v_house_id;
        INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
        VALUES (v_provider, v_actor, 'seed_forestry_sector.location_created', 'locations', v_house_id, jsonb_build_object('seed_key', v_seed, 'key', v_site->>'key', 'organization_id', v_org_id));
      END IF;
      SELECT id INTO v_site_id FROM public.client_sites WHERE client_organization_id = v_org_id AND (client_request_id = v_req OR location_id = v_house_id) LIMIT 1;
      IF v_site_id IS NULL THEN
        v_lat := (v_site->>'lat')::double precision; v_lng := (v_site->>'lng')::double precision;
        INSERT INTO public.client_sites (client_organization_id, location_id, name, address, address_match_key, site_type, active, site_origin, boundary_status, boundary_verification,
                                         center_point, gps_lat, gps_lng, external_ref, external_refs, metadata, client_request_id)
        VALUES (v_org_id, v_house_id, v_site->>'name', v_site->>'address', public.address_match_key(v_site->>'address'), coalesce(v_site->>'site_type', 'commercial_premises'), true, 'contracted', 'provisional', 'unverified',
                ST_SetSRID(ST_MakePoint(v_lng, v_lat), 4326), v_lat, v_lng, v_site->>'key',
                jsonb_build_object('seed_key', v_seed, 'source_url', v_site->>'source'),
                jsonb_build_object('seed_key', v_seed, 'source_url', v_site->>'source', 'geocode', v_site->'geocode', 'geocode_path', 'linz-lookup address_autocomplete (LINZ primary, Google seed)'),
                v_req)
        RETURNING id INTO v_site_id;
        INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
        VALUES (v_provider, v_actor, 'seed_forestry_sector.site_created', 'client_sites', v_site_id, jsonb_build_object('seed_key', v_seed, 'key', v_site->>'key', 'location_id', v_house_id, 'geocode', v_site->'geocode'));
      END IF;
    END LOOP;

    v_defaults := coalesce(v_org->'zone_defaults', '{}'::jsonb);
    FOR v_zone IN SELECT * FROM jsonb_array_elements(coalesce(v_org->'zones', '[]'::jsonb)) LOOP
      v_req := md5(v_seed || ':zone:' || (v_zone->>'key'))::uuid;
      SELECT id INTO v_zone_id FROM public.location_zones WHERE organization_id = v_org_id AND external_ref = v_zone->>'key' LIMIT 1;
      IF v_zone_id IS NULL THEN
        SELECT id INTO v_house_id FROM public.locations WHERE organization_id = v_org_id AND client_request_id = v_req;
        IF v_house_id IS NULL THEN
          INSERT INTO public.locations (organization_id, name, notes, created_by, client_request_id)
          VALUES (v_org_id, v_zone->>'name', '[seed:' || v_seed || '] forest block named on the owner''s website; geometry provisional (' || coalesce(v_zone->'gazetteer'->>'name', 'no gazetteer feature') || ')', v_actor, v_req)
          RETURNING id INTO v_house_id;
          INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
          VALUES (v_provider, v_actor, 'seed_forestry_sector.location_created', 'locations', v_house_id, jsonb_build_object('seed_key', v_seed, 'key', v_zone->>'key', 'organization_id', v_org_id));
        END IF;
        v_lat := (v_zone->>'lat')::double precision; v_lng := (v_zone->>'lng')::double precision;
        v_radius := coalesce((v_zone->>'radius_m')::integer, (v_defaults->>'radius_m')::integer, 2500);
        IF v_lat IS NOT NULL AND v_lng IS NOT NULL THEN
          v_point := ST_SetSRID(ST_MakePoint(v_lng, v_lat), 4326);
          v_buffer := ST_Multi(ST_Transform(ST_Buffer(ST_Transform(v_point, 2193), v_radius), 4326));
        ELSE
          v_point := NULL; v_buffer := NULL;
        END IF;
        INSERT INTO public.location_zones (organization_id, location_id, name, zone_type, module_key, rule_type, is_active, boundary_status, boundary_verification,
                                           center_point, boundary, radius_meters, jurisdiction_rule_set_id, bylaw_clause, bylaw_source_url, external_ref, metadata, scv_required, is_adhoc, onsite_profile)
        VALUES (v_org_id, v_house_id, v_zone->>'name', coalesce(v_zone->>'zone_type', v_defaults->>'zone_type', 'access_control'), coalesce(v_zone->>'module_key', v_defaults->>'module_key', 'access_control'),
                coalesce(v_zone->>'rule_type', v_defaults->>'rule_type', 'restricted'), true, 'provisional', 'unverified',
                v_point, v_buffer, CASE WHEN v_point IS NULL THEN NULL ELSE v_radius END, v_rule_set_id,
                coalesce(v_zone->>'bylaw_clause', v_defaults->>'bylaw_clause'), coalesce(v_zone->>'bylaw_source_url', v_defaults->>'bylaw_source_url'), v_zone->>'key',
                jsonb_strip_nulls(jsonb_build_object(
                  'seed_key', v_seed,
                  'geometry_method', CASE WHEN v_point IS NULL THEN 'unplaced_named_block' ELSE 'gazetteer_point_provisional_buffer' END,
                  'gazetteer', v_zone->'gazetteer', 'gazetteer_licence', CASE WHEN v_point IS NULL THEN NULL ELSE 'LINZ NZ Gazetteer, CC-BY 4.0' END,
                  'access_status', jsonb_strip_nulls(jsonb_build_object('week_starting', v_defaults->>'status_week', 'source', v_defaults->>'status_source', 'status', v_zone->'status')),
                  'public_access_easements', v_zone->'pae', 'special_areas', v_zone->'special_areas', 'clubs', v_zone->'clubs',
                  'source_urls', v_org->'source_urls', 'retrieved_at', v_data->>'retrieved_at')),
                false, false, 'boundary')
        RETURNING id INTO v_zone_id;
        INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
        VALUES (v_provider, v_actor, 'seed_forestry_sector.zone_created', 'location_zones', v_zone_id, jsonb_build_object('seed_key', v_seed, 'key', v_zone->>'key', 'location_id', v_house_id, 'placed', v_point IS NOT NULL, 'gazetteer', v_zone->'gazetteer'));
      END IF;

      FOR v_closure IN SELECT * FROM jsonb_array_elements(coalesce(v_zone->'closures', '[]'::jsonb)) LOOP
        IF NOT EXISTS (SELECT 1 FROM public.zone_closures WHERE zone_id = v_zone_id AND reason = v_closure->>'reason') THEN
          INSERT INTO public.zone_closures (organization_id, zone_id, closure_type, status, effective_from, effective_to, reason, notice_bundle_url, created_by)
          VALUES (v_org_id, v_zone_id, coalesce(v_closure->>'closure_type', 'temporary_closure'), 'active', (v_closure->>'effective_from')::date, (v_closure->>'effective_to')::date, v_closure->>'reason', v_defaults->>'status_source', v_actor);
          INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
          VALUES (v_provider, v_actor, 'seed_forestry_sector.zone_closure_created', 'zone_closures', v_zone_id, jsonb_build_object('seed_key', v_seed, 'zone_key', v_zone->>'key', 'closure_type', v_closure->>'closure_type'));
        END IF;
      END LOOP;
    END LOOP;

    -- Operational link: what manage_crm_agreement_setup / manage_crm_agreement_zone_coverage would do once the
    -- client has accepted — acceptance itself is recorded here on the owner's instruction with its basis.
    IF v_agreement_id IS NOT NULL AND (v_org->'agreement'->>'invitation_status') = 'accepted' THEN
      UPDATE public.service_agreements
         SET invitation_status = 'accepted',
             external_refs = external_refs || jsonb_build_object('accepted_basis', v_org->'agreement'->>'accepted_basis', 'accepted_recorded_at', v_data->>'retrieved_at')
       WHERE id = v_agreement_id AND invitation_status = 'not_invited';
      IF FOUND THEN
        INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
        VALUES (v_provider, v_actor, 'seed_forestry_sector.agreement_accepted', 'service_agreements', v_agreement_id, jsonb_build_object('seed_key', v_seed, 'client_organization_id', v_org_id, 'basis', v_org->'agreement'->>'accepted_basis'));
      END IF;
      FOR v_mod IN SELECT jsonb_array_elements_text(coalesce(v_org->'agreement'->'enabled_modules', '[]'::jsonb)) LOOP
        IF NOT EXISTS (SELECT 1 FROM public.service_agreement_modules WHERE service_agreement_id = v_agreement_id AND module_key = v_mod) THEN
          INSERT INTO public.service_agreement_modules (service_agreement_id, module_key, enabled, settings) VALUES (v_agreement_id, v_mod, true, jsonb_build_object('seed_key', v_seed));
        END IF;
      END LOOP;
      UPDATE public.service_agreements
         SET enabled_modules = coalesce((SELECT array_agg(sam.module_key ORDER BY sam.module_key) FROM public.service_agreement_modules sam WHERE sam.service_agreement_id = v_agreement_id AND sam.enabled), '{}'::text[])
       WHERE id = v_agreement_id;
      IF coalesce((v_org->'agreement'->>'link_all_sites')::boolean, false) THEN
        INSERT INTO public.service_agreement_locations (service_agreement_id, site_id, status, created_by)
        SELECT v_agreement_id, s.id, 'active', v_actor FROM public.client_sites s
         WHERE s.client_organization_id = v_org_id AND s.active
           AND NOT EXISTS (SELECT 1 FROM public.service_agreement_locations l WHERE l.service_agreement_id = v_agreement_id AND l.site_id = s.id);
        UPDATE public.client_sites SET service_agreement_id = v_agreement_id WHERE client_organization_id = v_org_id AND active AND service_agreement_id IS NULL;
      END IF;
      IF coalesce((v_org->'agreement'->>'link_all_zones')::boolean, false) THEN
        INSERT INTO public.service_agreement_locations (service_agreement_id, zone_id, status, created_by)
        SELECT v_agreement_id, z.id, 'active', v_actor FROM public.location_zones z
         WHERE z.organization_id = v_org_id AND z.is_active
           AND NOT EXISTS (SELECT 1 FROM public.service_agreement_locations l WHERE l.service_agreement_id = v_agreement_id AND l.zone_id = z.id);
        INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
        VALUES (v_provider, v_actor, 'seed_forestry_sector.agreement_coverage_linked', 'service_agreement_locations', v_agreement_id,
                jsonb_build_object('seed_key', v_seed, 'client_organization_id', v_org_id,
                                   'zones_covered', (SELECT count(*) FROM public.service_agreement_locations l WHERE l.service_agreement_id = v_agreement_id AND l.zone_id IS NOT NULL AND l.status = 'active'),
                                   'sites_covered', (SELECT count(*) FROM public.service_agreement_locations l WHERE l.service_agreement_id = v_agreement_id AND l.site_id IS NOT NULL AND l.status = 'active')));
      END IF;
    END IF;
  END LOOP;
END
$seed$;

SELECT
  (SELECT count(*) FROM public.organizations WHERE parent_organization_id = '${data.provider_organization_id}' AND external_refs->>'seed_key' = '${data.seed_key}') AS organizations,
  (SELECT count(*) FROM public.organizations WHERE parent_organization_id = '${data.provider_organization_id}' AND external_refs->>'seed_key' = '${data.seed_key}' AND status = 'active') AS active_clients,
  (SELECT count(*) FROM public.service_agreements WHERE provider_organization_id = '${data.provider_organization_id}' AND external_refs->>'seed_key' = '${data.seed_key}') AS agreements,
  (SELECT count(*) FROM public.jurisdiction_rule_sets WHERE rules->>'seed_key' = '${data.seed_key}') AS rule_sets,
  (SELECT count(*) FROM public.organization_modules m JOIN public.organizations o ON o.id = m.organization_id WHERE o.external_refs->>'seed_key' = '${data.seed_key}') AS client_modules,
  (SELECT count(*) FROM public.locations WHERE notes LIKE '[seed:${data.seed_key}]%') AS houses,
  (SELECT count(*) FROM public.canonical_places p WHERE p.id IN (SELECT canonical_place_id FROM public.locations WHERE notes LIKE '[seed:${data.seed_key}]%')) AS registry_places,
  (SELECT count(*) FROM public.client_sites WHERE metadata->>'seed_key' = '${data.seed_key}') AS sites,
  (SELECT count(*) FROM public.client_sites WHERE metadata->>'seed_key' = '${data.seed_key}' AND service_agreement_id IS NOT NULL) AS sites_linked_to_agreement,
  (SELECT count(*) FROM public.location_zones WHERE metadata->>'seed_key' = '${data.seed_key}') AS zones,
  (SELECT count(*) FROM public.location_zones WHERE metadata->>'seed_key' = '${data.seed_key}' AND center_point IS NOT NULL) AS placed_zones,
  (SELECT count(*) FROM public.location_zones WHERE metadata->>'seed_key' = '${data.seed_key}' AND jurisdiction_rule_set_id IS NOT NULL) AS zones_with_rules,
  (SELECT count(*) FROM public.zone_closures c JOIN public.location_zones z ON z.id = c.zone_id WHERE z.metadata->>'seed_key' = '${data.seed_key}') AS closures,
  (SELECT count(*) FROM public.service_agreements WHERE provider_organization_id = '${data.provider_organization_id}' AND external_refs->>'seed_key' = '${data.seed_key}' AND invitation_status = 'accepted') AS agreements_accepted,
  (SELECT count(*) FROM public.service_agreement_modules m JOIN public.service_agreements a ON a.id = m.service_agreement_id WHERE a.external_refs->>'seed_key' = '${data.seed_key}' AND m.enabled) AS agreement_modules,
  (SELECT count(*) FROM public.service_agreement_locations l JOIN public.service_agreements a ON a.id = l.service_agreement_id WHERE a.external_refs->>'seed_key' = '${data.seed_key}' AND l.zone_id IS NOT NULL AND l.status = 'active') AS zones_covered,
  (SELECT count(*) FROM public.service_agreement_locations l JOIN public.service_agreements a ON a.id = l.service_agreement_id WHERE a.external_refs->>'seed_key' = '${data.seed_key}' AND l.site_id IS NOT NULL AND l.status = 'active') AS sites_covered,
  (SELECT string_agg(m.module_key || ':' || coalesce(s.status, 'no-subscription-line'), ', ' ORDER BY m.module_key) FROM public.organization_modules m LEFT JOIN public.org_module_subscriptions s ON s.organization_id = m.organization_id AND s.module_key = m.module_key WHERE m.organization_id = '${data.provider_organization_id}' AND m.settings->>'seed_key' = '${data.seed_key}') AS provider_modules_enabled,
  (SELECT count(*) FROM public.audit_log WHERE action LIKE 'seed_forestry_sector.%' AND metadata->>'seed_key' = '${data.seed_key}') AS audit_rows;
`;

const detail = process.argv.includes('--detail') ? `
SELECT z.name, z.zone_type, z.module_key, z.rule_type, z.boundary_status, z.boundary_verification, p.place_kind, p.canonical_key,
       CASE WHEN z.boundary IS NULL THEN NULL ELSE round(ST_Area(z.boundary::geography) / 10000) END AS fence_hectares,
       z.radius_meters, (z.jurisdiction_rule_set_id IS NOT NULL) AS has_rules, (SELECT count(*) FROM public.zone_closures c WHERE c.zone_id = z.id) AS closures,
       o.name AS owner_org
  FROM public.location_zones z JOIN public.locations l ON l.id = z.location_id JOIN public.canonical_places p ON p.id = l.canonical_place_id JOIN public.organizations o ON o.id = z.organization_id
 WHERE z.metadata->>'seed_key' = '${data.seed_key}'
UNION ALL
SELECT s.name, 'site', s.site_type, NULL, s.boundary_status, s.boundary_verification, p.place_kind, p.canonical_key, NULL, NULL, (s.service_agreement_id IS NOT NULL), 0, o.name
  FROM public.client_sites s JOIN public.locations l ON l.id = s.location_id JOIN public.canonical_places p ON p.id = l.canonical_place_id JOIN public.organizations o ON o.id = s.client_organization_id
 WHERE s.metadata->>'seed_key' = '${data.seed_key}'
ORDER BY 13, 2, 1;` : '';

const sql = `BEGIN;${body}${detail}${mode === 'apply' ? 'COMMIT;' : 'ROLLBACK;'}`;
const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }),
});
const text = await response.text();
if (!response.ok) { console.error(`${mode}: failed`, text.slice(0, 2000)); process.exit(1); }
console.log(`${mode}: ${data.seed_key}`);
const rows = JSON.parse(text);
if (detail) for (const row of rows) console.log(Object.values(row).map((value) => value === null ? '-' : String(value)).join(' | '));
else console.log(JSON.stringify(rows[0] ?? {}, null, 1));
