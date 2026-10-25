-- Private community-camera clients get their own records and $85/hr + $1.26/km client rates; the seven
-- fixed-price agreements without a fee are pay as you go; OneFortyOne stays fixed price. Rolls back.
BEGIN;
SET LOCAL role postgres;
SET LOCAL search_path TO public, extensions, pg_catalog;

CREATE OR REPLACE FUNCTION pg_temp.check(p_label text, p_ok boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN RAISE EXCEPTION 'FAIL [%]', p_label; END IF;
  RAISE NOTICE 'ok   [%]', p_label;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.rate(p_when date, p_service text, p_job text, p_client uuid, p_type text) RETURNS numeric
LANGUAGE sql AS $$
  SELECT amount FROM public.resolve_rate_rule('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', 'billing',
    (p_when::timestamp + interval '10 hours') AT TIME ZONE 'Pacific/Auckland',
    p_service, p_job, NULL, p_client, NULL, NULL, NULL, 12, 'weekday', p_type);
$$;

DO $$
DECLARE
  rm uuid := 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13';
  seed text := 'rm_private_camera_clients_2026-10-25';
  pvt uuid := 'fc047614-ee8d-47d8-8bd3-734cd239dc36';
  barber uuid; coppins uuid; kai uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = pvt) THEN
    RAISE NOTICE 'skip: R&M clients not present in this environment';
    RETURN;
  END IF;
  SELECT id INTO barber FROM public.organizations WHERE client_request_id = md5(seed || ':org:barber-motueka')::uuid;
  SELECT id INTO coppins FROM public.organizations WHERE client_request_id = md5(seed || ':org:coppins')::uuid;
  SELECT id INTO kai FROM public.organizations WHERE client_request_id = md5(seed || ':org:kaiteriteri')::uuid;

  PERFORM pg_temp.check('three private camera clients exist under R&M',
    (SELECT count(*) FROM public.organizations WHERE id IN (barber, coppins, kai) AND parent_organization_id = rm AND active) = 3);
  PERFORM pg_temp.check('each has one accepted pay-as-you-go agreement',
    (SELECT count(*) FROM public.service_agreements sa JOIN public.crm_commercial_settings cs ON cs.service_agreement_id = sa.id
      WHERE sa.client_organization_id IN (barber, coppins, kai) AND sa.invitation_status = 'accepted'
        AND cs.commercial_model = 'pay_as_you_go') = 3);
  PERFORM pg_temp.check('24 client rules (4 clients x 6), all audited',
    (SELECT count(*) FROM public.rate_rules r WHERE r.organization_id = rm AND r.rule_kind = 'billing' AND r.active
       AND r.client_org_id IN (barber, coppins, kai, pvt)
       AND EXISTS (SELECT 1 FROM public.audit_log a WHERE a.target_id = r.id AND a.action = 'operating_branch_rate_rule_managed')) = 24);

  PERFORM pg_temp.check('Barber camera review $85', pg_temp.rate(date '2026-01-20', 'camera_review', NULL, barber, 'hourly') = 85.00);
  PERFORM pg_temp.check('Kaiteriteri patrol $85', pg_temp.rate(date '2025-12-23', 'patrol', NULL, kai, 'hourly') = 85.00);
  PERFORM pg_temp.check('Coppins travel $1.26/km', pg_temp.rate(date '2026-01-21', NULL, NULL, coppins, 'per_km') = 1.26);
  PERFORM pg_temp.check('umbrella private clients $85', pg_temp.rate(date '2026-02-01', 'patrol', NULL, pvt, 'hourly') = 85.00);
  PERFORM pg_temp.check('specialist engineering stays on the standing card',
    pg_temp.rate(date '2026-01-20', 'engineering', NULL, barber, 'hourly') = 79.50);
  PERFORM pg_temp.check('before Dec 2025 the standing card applies',
    pg_temp.rate(date '2025-11-15', 'patrol', NULL, kai, 'hourly') = 54.10);

  PERFORM pg_temp.check('seven former fixed-fee agreements are pay as you go',
    (SELECT count(*) FROM public.crm_commercial_settings WHERE commercial_model = 'pay_as_you_go' AND service_agreement_id IN (
      'ea29860c-54ad-4ae8-99af-2295bfd3af32','ea833b30-62bb-4f63-a390-feef857edc99','ff245fea-4ba7-4dd0-bc59-36fd22becb9d',
      '1febbf58-9f9a-4738-86c6-32061d6e6bdd','ad2a5116-c480-4ee8-bdff-87b4d0da03e9','a3a145e2-487b-43b5-b9e6-f930791c4817',
      'a9f026fa-7383-4277-b066-61ce109e9525')) = 7);
  PERFORM pg_temp.check('OneFortyOne is still fixed price with Extra',
    (SELECT commercial_model FROM public.crm_commercial_settings WHERE service_agreement_id = 'c36761e5-1634-419d-9ae5-234d3ec934ec') = 'fixed_price_with_extras');
  PERFORM pg_temp.check('only OneFortyOne remains on fixed price for R&M',
    (SELECT count(*) FROM public.crm_commercial_settings cs JOIN public.service_agreements sa ON sa.id = cs.service_agreement_id
      WHERE sa.provider_organization_id = rm AND cs.commercial_model = 'fixed_price_with_extras') = 1);
END $$;

ROLLBACK;
