-- The Workshop zone_id support added earlier today (2026-09-23) added the column
-- and the RPC overload but missed updating this constraint -- a maintenance work
-- order anchored to a zone (e.g. a forest, which has no LINZ address and is
-- never a "site") was still rejected. Found for real creating the Digger work
-- order (REMSEC Digger work 2023.xlsx) against OFO's "Te Hepe" zone.
ALTER TABLE public.workshop_work_orders
  DROP CONSTRAINT workshop_work_orders_maintenance_needs_place;

ALTER TABLE public.workshop_work_orders
  ADD CONSTRAINT workshop_work_orders_maintenance_needs_place
  CHECK (kind <> 'maintenance' OR client_site_id IS NOT NULL OR asset_id IS NOT NULL OR zone_id IS NOT NULL);
