-- Behavioural truth table: client rates from the invoice workbooks override the standing rate card only
-- for that client's matching labour/travel work; everything else still resolves to the standing card.
-- Runs in a transaction and rolls back.
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
  ofo uuid := 'c48c1aaf-236b-417c-bbce-938c151662d6';
  stand uuid := '2c433420-9fcc-40ba-8b32-3b542aa15e8f';
  dart uuid := 'febfdc61-fc56-4139-bb06-9ab5d616ba86';
  ncc uuid := '405fc1f7-45e8-4736-a517-885bb3e5ef95';
  tdc uuid := '54ade19f-0bb7-45ca-a32d-2d87214c4e77';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.service_agreements WHERE client_organization_id = ofo) THEN
    RAISE NOTICE 'skip: R&M clients not present in this environment';
    RETURN;
  END IF;

  PERFORM pg_temp.check('23 client rules loaded, all active billing',
    (SELECT count(*) FROM public.rate_rules WHERE organization_id = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'
       AND rule_kind = 'billing' AND active AND client_org_id IN (ofo, stand, dart, ncc)) = 23);
  PERFORM pg_temp.check('every client rule has an audit row naming its workbook',
    (SELECT count(*) FROM public.rate_rules r WHERE r.client_org_id IN (ofo, stand, dart, ncc) AND r.rule_kind = 'billing'
       AND EXISTS (SELECT 1 FROM public.audit_log a WHERE a.target_table = 'rate_rules' AND a.target_id = r.id
                   AND a.action = 'operating_branch_rate_rule_managed' AND a.metadata ? 'workbook')) = 23);

  PERFORM pg_temp.check('OFO patrol at client rate 58.30', pg_temp.rate('2026-09-15', 'patrol', NULL, ofo, 'hourly') = 58.30);
  PERFORM pg_temp.check('OFO camera review at client rate 58.30', pg_temp.rate('2026-09-15', 'camera_review', NULL, ofo, 'hourly') = 58.30);
  PERFORM pg_temp.check('OFO engineering stays on standing card 79.50', pg_temp.rate('2026-09-15', 'engineering', NULL, ofo, 'hourly') = 79.50);
  PERFORM pg_temp.check('OFO excavator stays on standing card 116.60', pg_temp.rate('2026-09-15', 'excavator', NULL, ofo, 'hourly') = 116.60);
  PERFORM pg_temp.check('OFO two-person patrol stays on standing card 108.20', pg_temp.rate('2026-09-15', 'patrol_two_person', NULL, ofo, 'hourly') = 108.20);
  PERFORM pg_temp.check('OFO alarm callout (job type) stays 58.30', pg_temp.rate('2026-09-15', NULL, 'alarm_response', ofo, 'hourly') = 58.30);
  PERFORM pg_temp.check('OFO travel uses standing 1.04/km', pg_temp.rate('2026-09-15', NULL, NULL, ofo, 'per_km') = 1.04);

  PERFORM pg_temp.check('STAND patrol 55.00', pg_temp.rate('2026-09-15', 'patrol', NULL, stand, 'hourly') = 55.00);
  PERFORM pg_temp.check('STAND travel 0.99/km', pg_temp.rate('2026-09-15', NULL, NULL, stand, 'per_km') = 0.99);
  PERFORM pg_temp.check('STAND engineering stays 79.50', pg_temp.rate('2026-09-15', 'engineering', NULL, stand, 'hourly') = 79.50);
  PERFORM pg_temp.check('STAND before 2025-11 falls back to standing 54.10', pg_temp.rate('2025-10-15', 'patrol', NULL, stand, 'hourly') = 54.10);

  PERFORM pg_temp.check('DART patrol 62.50', pg_temp.rate('2026-01-15', 'patrol', NULL, dart, 'hourly') = 62.50);
  PERFORM pg_temp.check('DART travel 0.99/km', pg_temp.rate('2026-01-15', NULL, NULL, dart, 'per_km') = 0.99);

  PERFORM pg_temp.check('NCC investigation 60.00 from Aug 2026', pg_temp.rate('2026-09-01', 'investigation', NULL, ncc, 'hourly') = 60.00);
  PERFORM pg_temp.check('NCC before Aug 2026 falls back to standing 54.10', pg_temp.rate('2026-07-01', 'investigation', NULL, ncc, 'hourly') = 54.10);

  PERFORM pg_temp.check('TDC (no client rate) uses standing patrol 54.10', pg_temp.rate('2026-09-15', 'patrol', NULL, tdc, 'hourly') = 54.10);
  PERFORM pg_temp.check('TDC (no client rate) uses standing travel 1.04', pg_temp.rate('2026-09-15', NULL, NULL, tdc, 'per_km') = 1.04);
  PERFORM pg_temp.check('No client at all uses standing patrol 54.10', pg_temp.rate('2026-09-15', 'patrol', NULL, NULL, 'hourly') = 54.10);
END $$;

ROLLBACK;
